/** Reasons the "Not helpful" menu offers, with the words people see for each. */
export const MESSAGE_FEEDBACK_REASON_OPTIONS = [
  ["incorrect", "Incorrect"],
  ["too_verbose", "Too verbose"],
  ["ignored_instructions", "Ignored instructions"],
  ["wrong_tone", "Wrong tone"],
  ["unsafe", "Unsafe / unwanted"],
] as const;

/**
 * The words for a stored rejection reason. Reasons from elsewhere (older events, other
 * surfaces) read as sentence-case words instead of a snake_case code.
 */
export function messageFeedbackReasonLabel(reason: string): string {
  const known = MESSAGE_FEEDBACK_REASON_OPTIONS.find(([code]) => code === reason);
  if (known) return known[1];
  const words = reason.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : reason;
}
