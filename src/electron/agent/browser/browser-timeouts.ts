/**
 * Time budgets for the headless browser (BrowserService) and for the executor's outer timeout
 * on browser_* tools.
 *
 * Element actions fail fast so a wrong selector costs seconds, not minutes; launch and page
 * navigation keep a longer budget. The executor's outer timeout must always outlast a service
 * budget plus failure capture, otherwise the action's own diagnostics (screenshot, URL, page text,
 * candidate selectors) are replaced by a generic "tool timed out" error.
 */

/** Default for click / fill / type / select / check: waiting for the element plus the action. */
export const BROWSER_ACTION_TIMEOUT_MS = 15_000;

/** Default for browser_wait (an explicit wait for an element); matches the tool schema. */
export const BROWSER_WAIT_TIMEOUT_MS = 30_000;

/** Default for browser launch and page navigation (goto, reload, back/forward). */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;

/** Upper bound for collecting failure diagnostics after an action fails. */
export const BROWSER_FAILURE_CAPTURE_TIMEOUT_MS = 8_000;

/** Extra time the executor grants beyond an explicit action timeout_ms for failure capture. */
export const BROWSER_ACTION_DIAGNOSTICS_HEADROOM_MS = 15_000;

/** Executor outer timeout for browser_* tools: navigation budget plus launch/consent headroom. */
export const BROWSER_TOOL_TIMEOUT_MS = BROWSER_NAVIGATION_TIMEOUT_MS + 30_000;
