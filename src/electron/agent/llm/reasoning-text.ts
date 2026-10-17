/**
 * Reasoning models served by local runtimes (Ollama, LM Studio, llama.cpp)
 * can return their private reasoning inside the message text instead of a
 * separate field:
 *
 * - `<think>…</think>answer`, when the model writes both tags itself.
 * - `reasoning…</think>answer`, when the chat template already opened
 *   `<think>` in the prompt (qwen3 thinking models with `think: false`).
 * - `<think>reasoning…`, cut off by the token limit before the answer.
 *
 * None of it is part of the reply, so callers keep only the answer.
 */

const LEADING_REASONING_BLOCK = /^\s*<(think|thinking)>([\s\S]*?)<\/\1>/i;
const LEADING_UNCLOSED_REASONING = /^\s*<(?:think|thinking)>([\s\S]*)$/i;
const BARE_REASONING_CLOSE = /<\/(?:think|thinking)>/i;
const REASONING_OPEN = /<(?:think|thinking)>/i;

export interface SplitReasoningText {
  /** The user-facing answer, with reasoning removed. */
  text: string;
  /** The removed reasoning; empty when there was none. */
  reasoning: string;
}

export function splitReasoningFromText(value: string): SplitReasoningText {
  let text = String(value ?? "");
  const reasoning: string[] = [];

  let block = LEADING_REASONING_BLOCK.exec(text);
  while (block) {
    reasoning.push(block[2]!.trim());
    text = text.slice(block[0].length);
    block = LEADING_REASONING_BLOCK.exec(text);
  }

  const unclosed = LEADING_UNCLOSED_REASONING.exec(text);
  if (unclosed) {
    reasoning.push(unclosed[1]!.trim());
    text = "";
  } else {
    // A closing tag with no opener before it: the template opened the block
    // in the prompt, so everything up to the tag is reasoning.
    const close = BARE_REASONING_CLOSE.exec(text);
    if (close && !REASONING_OPEN.test(text.slice(0, close.index))) {
      reasoning.push(text.slice(0, close.index).trim());
      text = text.slice(close.index + close[0].length);
    }
  }

  if (reasoning.length === 0) return { text: value, reasoning: "" };
  return { text: text.trim(), reasoning: reasoning.filter(Boolean).join("\n\n") };
}

/**
 * Plain-prose reasoning that a model wrote where an answer belongs, e.g.
 * "We are given a request: …" or "Okay, I need to improve the draft…". Used
 * to reject short generated text (titles, rewrites), not to edit replies.
 */
const REASONING_PREAMBLE =
  /^\s*(?:(?:okay|ok|alright|hmm+)\s*[,.!]?\s+(?:so\s+)?(?:i|we|let(?:'|’)?s|let me|the user|user)\b|we(?:'re|’re| are) (?:given|asked|told)\b|we (?:need|have|must|should) to\b|i (?:need|have|must|should) to\b|let me (?:think|figure|see|start|try|analy[sz]e|understand|break)\b|the user (?:wants|asks|is asking|asked|has asked|requested|needs)\b|first,? (?:i|we|let me)\b)/i;

export function looksLikeReasoningPreamble(value: string): boolean {
  return REASONING_PREAMBLE.test(String(value ?? ""));
}
