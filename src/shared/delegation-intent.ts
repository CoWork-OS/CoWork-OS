/** Remove prohibited actions before looking for delegation requests.
 * Newlines can be pasted line wrapping; commas can join a prohibited list.
 * A sentence, semicolon, or contrast starts a new scope of authorization.
 */
export function affirmativeDelegationText(text: string): string {
  return String(text || "").replace(
    /\b(?:do\s+not|don['’]?t|never|without|no)\b[^.!?;]*?(?=\b(?:but|however|instead)\b|[.!?;]|$)/gi,
    " ",
  );
}

/** A mention of teammates or delegation is not a request to hand work off. */
export const DELEGATION_REQUEST_LEAD =
  "(?:^|[.!?;:\\n]\\s*|\\b(?:please|then|also|but|instead|and|let['’]?s|(?:can|could|would|will)\\s+you|i\\s+(?:want|need)\\s+you\\s+to)\\s+)(?:please\\s+)?";

export function hasAffirmativeDelegationAction(text: string): boolean {
  const affirmative = affirmativeDelegationText(text);
  return new RegExp(
    `${DELEGATION_REQUEST_LEAD}(?:delegate|spawn|orchestrate)\\b|${DELEGATION_REQUEST_LEAD}(?:use|call|invoke)\\s+(?:the\\s+)?send_agent_message\\b|${DELEGATION_REQUEST_LEAD}(?:use|assign|involve|have)\\b[^.!?;]{0,60}\\b(?:teammates?|bots?|agents?|bot team)\\b`,
    "i",
  ).test(affirmative);
}
