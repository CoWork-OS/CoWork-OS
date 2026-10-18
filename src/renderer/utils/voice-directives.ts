/**
 * Voice Directive Parser
 *
 * Parses and extracts voice directives from assistant messages.
 * Supports [[speak]]text[[/speak]] tags to indicate text that should be spoken.
 *
 * When responseMode is:
 * - 'auto': Speaks all assistant messages
 * - 'manual': Only speaks when user clicks speak button
 * - 'smart': Only speaks text within [[speak]] tags
 */

export interface VoiceDirective {
  /** Text to be spoken (extracted from [[speak]] tags or full message) */
  speakText: string;
  /** Original message with tags stripped for display */
  displayText: string;
  /** Whether the message contains explicit speak directives */
  hasDirective: boolean;
  /** Optional voice parameters from directive */
  params?: {
    voice?: string;
    speed?: number;
    pitch?: number;
  };
}

/**
 * Parse [[speak]] directives from message text
 *
 * Supports:
 * - [[speak]]text to speak[[/speak]] - Explicit speech block
 * - [[speak:voice=alloy speed=1.2]]text[[/speak]] - With parameters
 */
export function parseVoiceDirectives(message: string): VoiceDirective {
  // Pattern for [[speak]] tags with optional parameters
  const speakPattern = /\[\[speak(?::([^\]]*))?\]\]([\s\S]*?)\[\[\/speak\]\]/gi;

  let hasDirective = false;
  const speakTexts: string[] = [];
  let displayText = message;
  let params: VoiceDirective["params"] = undefined;

  // Find all [[speak]] blocks
  let match;
  while ((match = speakPattern.exec(message)) !== null) {
    hasDirective = true;
    const paramString = match[1];
    const text = match[2].trim();

    if (text) {
      speakTexts.push(text);
    }

    // Parse parameters from first directive found
    if (paramString && !params) {
      params = parseDirectiveParams(paramString);
    }
  }

  // Remove [[speak]] tags from display text
  displayText = message.replace(speakPattern, "$2").trim();

  // If no explicit directives, the speak text is the full message
  const speakText = hasDirective ? speakTexts.join(" ") : stripMarkdownForSpeech(message);

  return {
    speakText,
    displayText,
    hasDirective,
    params,
  };
}

/**
 * Parse directive parameters like voice=alloy speed=1.2
 */
function parseDirectiveParams(paramString: string): VoiceDirective["params"] {
  const params: VoiceDirective["params"] = {};

  // Match key=value pairs
  const paramPattern = /(\w+)=([^\s]+)/g;
  let match;

  while ((match = paramPattern.exec(paramString)) !== null) {
    const [, key, value] = match;
    switch (key.toLowerCase()) {
      case "voice":
        params.voice = value;
        break;
      case "speed":
      case "rate":
        params.speed = parseFloat(value);
        break;
      case "pitch":
        params.pitch = parseFloat(value);
        break;
    }
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Strip markdown formatting for cleaner speech
 */
export function stripMarkdownForSpeech(text: string): string {
  return (
    text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove bold/italic
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // Underscore emphasis only at word boundaries. A single word in double
      // underscores is a dunder name (`__init__`), and underscores next to a
      // path separator belong to a path (`/tmp/_cache_/x`); both are kept.
      .replace(
        /(^|[^\p{L}\p{N}_/\\])__([^_\n]*[^\p{L}\p{N}_\n][^_\n]*)__(?=[^\p{L}\p{N}_/\\]|$)/gu,
        "$1$2",
      )
      .replace(/(^|[^\p{L}\p{N}_/\\])_([^_\n]+)_(?=[^\p{L}\p{N}_/\\]|$)/gu, "$1$2")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, "")
      // Remove bullet points
      .replace(/^[\s]*[-*+]\s+/gm, "")
      // Remove numbered lists
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Collapse spaces left behind by removed elements
      .replace(/[ \t]{2,}/g, " ")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Check if message should be spoken based on response mode
 */
export function shouldSpeak(
  message: string,
  responseMode: "auto" | "manual" | "smart",
  voiceEnabled: boolean,
): boolean {
  if (!voiceEnabled) return false;

  const { hasDirective, speakText } = parseVoiceDirectives(message);

  switch (responseMode) {
    case "auto":
      // Speak all messages with content
      return speakText.length > 0;
    case "smart":
      // Only speak if has [[speak]] directive
      return hasDirective;
    case "manual":
    default:
      // Never auto-speak
      return false;
  }
}

/**
 * Extract text suitable for speech from a message
 */
export function getTextForSpeech(message: string): string {
  const { speakText } = parseVoiceDirectives(message);
  return speakText;
}
