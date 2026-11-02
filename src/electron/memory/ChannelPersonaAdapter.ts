/**
 * ChannelPersonaAdapter — Cross-channel persona coherence
 *
 * Takes the core personality prompt from PersonalityManager and adapts it
 * per-channel (Slack, Email, WhatsApp, etc.) while keeping the underlying
 * knowledge, style, and personality consistent.
 *
 * Each channel has communication norms:
 *   - Slack: concise, use blocks/bullets, thread-friendly
 *   - Email: formal structure, greeting/sign-off, paragraphs
 *   - WhatsApp/iMessage/Signal: casual, short messages, emoji-friendly
 *   - Discord: markdown-rich, casual, code blocks welcome
 *   - Teams: professional, structured, moderate length
 *   - Telegram: concise, no heavy formatting
 *   - GitHub: dense and structured (background, change, verification)
 *
 * Chat channels also get a hard reply cap (about 100 words, conclusions first, direct
 * questions only); email and GitHub get the dense background/change/verification shape.
 *
 * The adapter layers a channel-specific directive ON TOP of the core persona —
 * it never replaces it. The result: same personality, adapted delivery.
 *
 * Governed by guardrail `channelPersonaEnabled` (default off).
 */

import type { ChannelType } from "../gateway/channels/types";
import { GuardrailManager } from "../guardrails/guardrail-manager";

// ─── Channel Communication Profiles ──────────────────────────────────

/** Where a reply goes: a gateway channel, or GitHub (PR and issue comments). */
export type PersonaSurface = ChannelType | "github";

/** The hard per-reply word cap on chat channels. */
export const CHAT_REPLY_WORD_LIMIT = 100;

/**
 * - chat: instant messaging; replies are capped and lead with the conclusion.
 * - structured: email and GitHub; dense background / change / verification shape.
 */
type ReplyNorm = "chat" | "structured";

interface ChannelProfile {
  /** Short description of channel communication norms. */
  directive: string;
  /** Hard reply norm for the channel. */
  replyNorm: ReplyNorm;
  /** Suggested response length adjustment. */
  lengthHint: "shorter" | "normal" | "longer";
  /** Whether to encourage emoji usage. */
  emojiEncouraged: boolean;
  /** Whether to use structured formatting (headers, bullets, blocks). */
  structuredFormatting: boolean;
  /** Whether to include formal greeting/sign-off. */
  formalFraming: boolean;
}

const CHANNEL_PROFILES: Partial<Record<PersonaSurface, ChannelProfile>> = {
  slack: {
    directive:
      "You are responding in a Slack workspace. Keep messages concise and scannable. " +
      "Use bullet points and bold text for key information. " +
      "Avoid long paragraphs — prefer short blocks. " +
      "If sharing code, use backtick code blocks. " +
      "Thread-style brevity is preferred over essay-length answers.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  email: {
    directive:
      "You are composing an email response. Use a professional structure: " +
      "brief greeting, clear body with paragraphs, and a courteous sign-off. " +
      "Be thorough but not verbose. Organize long responses with numbered points or sections. " +
      "Maintain a professional tone appropriate for business communication.",
    replyNorm: "structured",
    lengthHint: "longer",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: true,
  },
  whatsapp: {
    directive:
      "You are responding via WhatsApp. Keep messages short and conversational. " +
      "Use simple, direct language. Break long responses into multiple short paragraphs. " +
      "Avoid heavy formatting — WhatsApp supports only basic bold/italic. " +
      "Match the casual, quick-reply style typical of instant messaging.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  whatsapp_cloud: {
    directive:
      "You are replying to a customer through a WhatsApp Business account. Keep messages short, " +
      "polite and professional, and use plain text with at most basic bold/italic. " +
      "Break long answers into short paragraphs.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  twilio_sms: {
    directive:
      "You are replying by SMS. Use plain text only — no Markdown, tables or code blocks. " +
      "Keep replies brief (ideally under 320 characters) because long messages are split and billed per segment.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  imessage: {
    directive:
      "You are responding via iMessage. Keep messages concise and natural. " +
      "Use a conversational, friendly tone. Avoid long blocks of text. " +
      "Short replies feel more natural on this platform.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  signal: {
    directive:
      "You are responding via Signal. Keep messages focused and concise. " +
      "This is a security-conscious platform — avoid unnecessary verbosity. " +
      "Direct, clear communication is valued.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  discord: {
    directive:
      "You are responding in Discord. Use markdown formatting freely — " +
      "headers, bold, code blocks, and bullets are well-supported. " +
      "Match the community-style tone. Keep responses moderately sized. " +
      "Use code blocks with syntax highlighting for technical content.",
    replyNorm: "chat",
    lengthHint: "normal",
    emojiEncouraged: true,
    structuredFormatting: true,
    formalFraming: false,
  },
  teams: {
    directive:
      "You are responding in Microsoft Teams. Use a professional but approachable tone. " +
      "Teams supports rich formatting — use headings, bullets, and tables when helpful. " +
      "Keep responses structured and actionable. " +
      "Business context is the norm — maintain professionalism.",
    replyNorm: "chat",
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  telegram: {
    directive:
      "You are responding via Telegram. Keep messages concise. " +
      "Telegram supports markdown formatting but users prefer brevity. " +
      "Use bold for emphasis and code blocks for technical content.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  mattermost: {
    directive:
      "You are responding in Mattermost. Use professional, structured formatting. " +
      "Mattermost supports full markdown — use headers, bullets, and code blocks as appropriate. " +
      "Match the workplace communication style.",
    replyNorm: "chat",
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  matrix: {
    directive:
      "You are responding in Matrix/Element. Use clean markdown formatting. " +
      "Matrix is often used by technical communities — be direct and precise.",
    replyNorm: "chat",
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  googlechat: {
    directive:
      "You are responding in Google Chat. Keep messages professional and concise. " +
      "Google Chat supports basic formatting. Prefer short, actionable messages.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  line: {
    directive:
      "You are responding via LINE. Keep messages short and friendly. " +
      "LINE is a casual messaging platform — use a warm, conversational tone.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  bluebubbles: {
    directive:
      "You are responding via BlueBubbles (iMessage bridge). " +
      "Keep messages concise and conversational, matching iMessage norms.",
    replyNorm: "chat",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  github: {
    directive:
      "You are writing on GitHub (pull request or issue comments, reviews, descriptions). " +
      "Write for engineers reading a review queue: dense, factual and skimmable. " +
      "Use Markdown headings or bold labels, short bullets and code spans for identifiers.",
    replyNorm: "structured",
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
};

const CHAT_REPLY_NORM = [
  `- Hard limit: keep every reply under about ${CHAT_REPLY_WORD_LIMIT} words. Do not split a long answer into several messages to get around it.`,
  "- Give the conclusion or answer first, not the process that led to it.",
  "- Ask only direct questions, and only when you cannot continue without the answer.",
];

const STRUCTURED_REPLY_NORM = [
  "- Write densely, in three parts when reporting work: Background (why), Change (what was done or is proposed), Verification (how it was checked, with results).",
  "- No filler or pleasantries beyond what the medium requires; every sentence should carry information.",
];

// ─── Group context adjustments ───────────────────────────────────────

const GROUP_CONTEXT_DIRECTIVE =
  "You are responding in a group conversation. Be mindful that others can see your response. " +
  "Address the specific person when relevant. Keep responses focused on the topic. " +
  "Avoid sharing private or sensitive information.";

const PUBLIC_CONTEXT_DIRECTIVE =
  "You are responding in a public channel. Your response is visible to everyone. " +
  "Maintain professionalism and discretion. Do not share any private or sensitive information. " +
  "Keep responses helpful and on-topic.";

// ─── Main Service ────────────────────────────────────────────────────

export type GatewayContext = "private" | "group" | "public";

export class ChannelPersonaAdapter {
  /**
   * Adapt the core personality prompt for a specific channel.
   *
   * Returns an additional directive to append to the system prompt —
   * does NOT replace the core personality.
   *
   * @param channelType - The channel this task originates from
   * @param gatewayContext - Whether this is a private, group, or public conversation
   * @returns Channel-specific directive string (empty if disabled or desktop)
   */
  static adaptForChannel(channelType?: PersonaSurface, gatewayContext?: GatewayContext): string {
    // Check guardrail
    const settings = GuardrailManager.loadSettings();
    if (!settings.channelPersonaEnabled) {
      return "";
    }

    if (!channelType) return "";

    const profile = CHANNEL_PROFILES[channelType];
    if (!profile) return "";

    const lines: string[] = [];

    // Channel directive
    lines.push("CHANNEL COMMUNICATION GUIDELINES:");
    lines.push(profile.directive);

    // Length hint
    switch (profile.lengthHint) {
      case "shorter":
        lines.push(
          "- Prefer shorter responses on this platform. Be concise without losing clarity.",
        );
        break;
      case "longer":
        lines.push(
          "- Thorough responses are appropriate on this platform when the topic warrants it.",
        );
        break;
    }

    // Formatting hints
    if (!profile.structuredFormatting) {
      lines.push("- Avoid heavy formatting (headers, complex lists). Keep it simple and readable.");
    }

    if (profile.formalFraming) {
      lines.push("- Include an appropriate greeting and sign-off.");
    }

    // Hard reply norms
    lines.push(...(profile.replyNorm === "chat" ? CHAT_REPLY_NORM : STRUCTURED_REPLY_NORM));

    // Group/public context overlay
    if (gatewayContext === "group") {
      lines.push("");
      lines.push(GROUP_CONTEXT_DIRECTIVE);
    } else if (gatewayContext === "public") {
      lines.push("");
      lines.push(PUBLIC_CONTEXT_DIRECTIVE);
    }

    return lines.join("\n");
  }

  /**
   * Get the channel profile for a given channel type.
   * Useful for UI display or debugging.
   */
  static getChannelProfile(channelType: PersonaSurface): ChannelProfile | undefined {
    return CHANNEL_PROFILES[channelType];
  }

  /**
   * List all channel types that have a defined profile.
   */
  static getSupportedChannels(): PersonaSurface[] {
    return Object.keys(CHANNEL_PROFILES) as PersonaSurface[];
  }
}
