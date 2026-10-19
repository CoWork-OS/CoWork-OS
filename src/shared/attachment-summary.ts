/**
 * The block a composer adds after the words the user typed when files ride along with a message.
 *
 * The desktop composer (renderer MainContent/attachments.ts) appends a summary: the header, one
 * line per file, and for each file it could read the extracted text between the two content
 * markers. The artifact viewers and the browser annotation tool append a shorter list header with
 * file names only, and channel messages get a list of the paths the gateway saved. Main and
 * renderer share these strings so the main process can find where the user's own words end:
 * the admin-lane tools open only on those words (tool-policy-engine.ts, userText). A composer
 * that appends file or page text to a typed message must put it after one of these headers or
 * the start marker, or that text counts as typed.
 */

/** Header of the desktop composer's summary, which may carry extracted file text. */
export const ATTACHED_FILES_SUMMARY_HEADER = "Attached files (relative to workspace):";
/** Header of the names-only list the artifact viewers and browser annotations append. */
export const ATTACHED_FILES_LIST_HEADER = "Attached files:";
/** Header of the saved-paths list the gateway appends to a channel message. */
export const CHANNEL_ATTACHMENTS_SAVED_HEADER = "Attachments saved to workspace:";
export const ATTACHMENT_CONTENT_START_MARKER = "[[ATTACHMENT_EXTRACTED_CONTENT_START]]";
export const ATTACHMENT_CONTENT_END_MARKER = "[[ATTACHMENT_EXTRACTED_CONTENT_END]]";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The list headers are short and could appear in what the user types, so they count only on a
// line of their own, which is how the composers write them.
const LIST_HEADER_LINE_PATTERN = new RegExp(
  `(?:^|\\n)[ \\t]*(?:${escapeRegExp(ATTACHED_FILES_LIST_HEADER)}|${escapeRegExp(
    CHANNEL_ATTACHMENTS_SAVED_HEADER,
  )})[ \\t]*(?:\\r?\\n|$)`,
);

/**
 * The part of a message before any attachment block: the words the user typed. Cuts at the
 * first summary header, content start marker, or list header line. A file's text may contain a
 * fake end marker or a second header, so nothing after the first cut is ever kept.
 */
export function textBeforeAttachedFiles(text: string): string {
  const value = String(text || "");
  const cuts = [
    value.indexOf(ATTACHED_FILES_SUMMARY_HEADER),
    value.indexOf(ATTACHMENT_CONTENT_START_MARKER),
    value.search(LIST_HEADER_LINE_PATTERN),
  ].filter((index) => index >= 0);
  return cuts.length === 0 ? value : value.slice(0, Math.min(...cuts));
}
