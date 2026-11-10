/**
 * A reply typed on an approval card ("Reply instead") denies the operation and reaches the
 * agent as a follow-up. The agent needs to know what the reply answers; the person who typed
 * it should see only their own words.
 */

const APPROVAL_REPLY_PREFIX = "Reply to your permission request (the operation was not run): ";

/** The follow-up message that hands an approval-card reply to the agent. */
export function buildApprovalReplyMessage(reply: string): string {
  return `${APPROVAL_REPLY_PREFIX}${reply}`;
}

/** The words the person typed, for a message built by buildApprovalReplyMessage. */
export function approvalReplyDisplayText(message: string): string {
  return message.startsWith(APPROVAL_REPLY_PREFIX)
    ? message.slice(APPROVAL_REPLY_PREFIX.length)
    : message;
}
