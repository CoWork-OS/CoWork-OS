import type { WebContents } from "electron";
import type { BrowserColorScheme } from "../../shared/browser-settings";

export interface BrowserColorSchemeDeps {
  getPreference: () => BrowserColorScheme | null;
  subscribe: (listener: () => void) => () => void;
  apply: (colorScheme: BrowserColorScheme | null) => Promise<void>;
}

/** Browser-only appearance, shared by native tab views and webview guests. */
export function attachBrowserColorScheme(
  contents: Pick<WebContents, "isDestroyed" | "on" | "once">,
  deps: BrowserColorSchemeDeps,
): void {
  let stopped = false;
  let overridden = false;
  let pending = Promise.resolve();

  const apply = () => {
    // Serialize updates and read the latest saved choice when each one runs,
    // so a slow navigation cannot restore an older preference.
    pending = pending
      .then(async () => {
        if (stopped || contents.isDestroyed()) return;
        const colorScheme = deps.getPreference();
        // null (no browser choice, app on "system") needs no CDP attachment or
        // override: Chromium already follows the OS, as the app does.
        if (colorScheme === null && !overridden) return;
        await deps.apply(colorScheme);
        overridden = colorScheme !== null;
      })
      .catch((error: unknown) => {
        if (!stopped && !contents.isDestroyed()) {
          console.warn("[Browser] Could not apply color scheme", error);
        }
        // A navigation or renderer replacement may temporarily reject CDP;
        // the next committed navigation / dom-ready event retries it.
      });
  };

  const unsubscribe = deps.subscribe(apply);
  contents.on("did-navigate", apply);
  contents.on("dom-ready", apply);
  contents.once("destroyed", () => {
    stopped = true;
    unsubscribe();
  });
  apply();
}
