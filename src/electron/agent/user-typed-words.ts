/**
 * The words a person typed, out of the message a composer or channel built around them.
 *
 * A typed prompt or follow-up can carry text its sender did not write: the desktop composer
 * appends attached files' text (attachment-summary.ts) and WhatsApp puts the quoted message in
 * front of a reply (channel-reply-context.ts). The admin-lane tools open only on the user's own
 * words (tool-policy-engine.ts, userText), so both are left out.
 */
import { textBeforeAttachedFiles } from "../../shared/attachment-summary";
import { withoutChannelReplyContext } from "../../shared/channel-reply-context";

export function userTypedWords(text: string): string {
  // Quotes first: a quoted line that looks like an attachment header must not cut off the
  // words typed under it.
  return textBeforeAttachedFiles(withoutChannelReplyContext(String(text || "")));
}
