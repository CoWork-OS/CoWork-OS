/**
 * Links to a tab of the task's terminal panel, written in an answer as
 * `[tab title](#terminal/<tab id>)`. The answer shows them as a chip that opens the tab.
 * Tab ids are agent background process ids (`bg-…`) or the panel's own shell tab ids.
 */

const TERMINAL_TAB_HREF_PREFIX = "#terminal/";
const TERMINAL_TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

/** The href for a terminal tab link. */
export function terminalTabHref(tabId: string): string {
  return `${TERMINAL_TAB_HREF_PREFIX}${encodeURIComponent(tabId)}`;
}

/** A markdown link to a terminal tab, as the agent should write it. */
export function terminalTabMarkdownLink(title: string, tabId: string): string {
  const label = title.replace(/[[\]\\]/g, "").trim() || "terminal";
  return `[${label}](${terminalTabHref(tabId)})`;
}

/** The tab id a `#terminal/<id>` href points at, or null for any other href. */
export function parseTerminalTabHref(href: string | null | undefined): string | null {
  if (typeof href !== "string" || !href.startsWith(TERMINAL_TAB_HREF_PREFIX)) return null;
  let tabId: string;
  try {
    tabId = decodeURIComponent(href.slice(TERMINAL_TAB_HREF_PREFIX.length));
  } catch {
    return null;
  }
  return TERMINAL_TAB_ID_PATTERN.test(tabId) ? tabId : null;
}
