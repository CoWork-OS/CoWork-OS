import type { MessageSurfaceOrigin } from "../../../shared/types";

/** Options the browser workbench passes along with a message to its task. */
export type BrowserSendOptions = {
  /** Send exactly this text, never a rewritten reply. */
  verbatim?: boolean;
  surfaceOrigin?: MessageSurfaceOrigin;
};

/**
 * For a message that carries web page content the user did not type: text they selected,
 * the page's console output, element values, its URL, an answer drawn from a video. The
 * origin keeps page text from counting as the user's own words (follow-up-provenance.ts),
 * so it cannot expose the admin-lane tools, and verbatim keeps the app from reading it as
 * the user's reply to a pending question, such as whether to turn on shell access.
 */
export const BROWSER_PAGE_SEND = {
  verbatim: true,
  surfaceOrigin: "browser_page",
} as const satisfies BrowserSendOptions;

/** The message the page context menu's "Ask" sends about the text the user selected. */
export function buildBrowserAskMessage(text: string, url: string): string {
  const quoted = text.split("\n").join("\n> ");
  return `About this text from ${url || "the page"}:\n\n> ${quoted}\n\nExplain this and tell me what matters here.`;
}
