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
 *
 * The adapter layers a channel-specific directive ON TOP of the core persona —
 * it never replaces it. The result: same personality, adapted delivery.
 *
 * Governed by guardrail `channelPersonaEnabled` (default off).
 */

import type { ChannelType } from "../gateway/channels/types";
import { GuardrailManager } from "../guardrails/guardrail-manager";

// ─── Channel Communication Profiles ──────────────────────────────────

interface ChannelProfile {
  /** Short description of channel communication norms. */
  directive: string;
  /** Suggested response length adjustment. */
  lengthHint: "shorter" | "normal" | "longer";
  /** Whether to encourage emoji usage. */
  emojiEncouraged: boolean;
  /** Whether to use structured formatting (headers, bullets, blocks). */
  structuredFormatting: boolean;
  /** Whether to include formal greeting/sign-off. */
  formalFraming: boolean;
}

const CHANNEL_PROFILES: Partial<Record<ChannelType, ChannelProfile>> = {
  slack: {
    directive:
      "You are responding in a Slack workspace. Keep messages concise and scannable. " +
      "Use bullet points and bold text for key information. " +
      "Avoid long paragraphs — prefer short blocks. " +
      "If sharing code, use backtick code blocks. " +
      "Thread-style brevity is preferred over essay-length answers.",
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
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  imessage: {
    directive:
      "You are responding via iMessage. Keep messages concise and natural. " +
      "Use a conversational, friendly tone. Avoid long blocks of text. " +
      "Short replies feel more natural on this platform.",
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
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  matrix: {
    directive:
      "You are responding in Matrix/Element. Use clean markdown formatting. " +
      "Matrix is often used by technical communities — be direct and precise.",
    lengthHint: "normal",
    emojiEncouraged: false,
    structuredFormatting: true,
    formalFraming: false,
  },
  googlechat: {
    directive:
      "You are responding in Google Chat. Keep messages professional and concise. " +
      "Google Chat supports basic formatting. Prefer short, actionable messages.",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  twitch: {
    directive:
      "You are responding in Twitch chat. Keep messages very short — " +
      "Twitch messages should be punchy and easy to read in a fast-moving chat. " +
      "One or two sentences max per message.",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  line: {
    directive:
      "You are responding via LINE. Keep messages short and friendly. " +
      "LINE is a casual messaging platform — use a warm, conversational tone.",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
  x: {
    directive:
      "You are responding via X (Twitter) DMs. Keep messages concise and clear. " +
      "Match the brief, direct style typical of the platform.",
    lengthHint: "shorter",
    emojiEncouraged: false,
    structuredFormatting: false,
    formalFraming: false,
  },
  bluebubbles: {
    directive:
      "You are responding via BlueBubbles (iMessage bridge). " +
      "Keep messages concise and conversational, matching iMessage norms.",
    lengthHint: "shorter",
    emojiEncouraged: true,
    structuredFormatting: false,
    formalFraming: false,
  },
};

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
  static adaptForChannel(
    channelType?: ChannelType,
    gatewayContext?: GatewayContext,
  ): string {
    // Check guardrail
    const settings = GuardrailManager.loadSettings();
    if (!(settings as Record<string, unknown>).channelPersonaEnabled) {
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
        lines.push("- Thorough responses are appropriate on this platform when the topic warrants it.");
        break;
    }

    // Formatting hints
    if (!profile.structuredFormatting) {
      lines.push("- Avoid heavy formatting (headers, complex lists). Keep it simple and readable.");
    }

    if (profile.formalFraming) {
      lines.push("- Include an appropriate greeting and sign-off.");
    }

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
  static getChannelProfile(channelType: ChannelType): ChannelProfile | undefined {
    return CHANNEL_PROFILES[channelType];
  }

  /**
   * List all channel types that have a defined profile.
   */
  static getSupportedChannels(): ChannelType[] {
    return Object.keys(CHANNEL_PROFILES) as ChannelType[];
  }
}
