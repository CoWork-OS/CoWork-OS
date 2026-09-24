import type { App } from "electron";

/**
 * Electron quits automatically when its last BrowserWindow closes unless an
 * app listener handles this event. Headless direct runs temporarily create a
 * hidden window to initialize safeStorage, but must keep running afterward.
 */
export function keepDirectRunAliveWithoutWindows(app: Pick<App, "on">): void {
  app.on("window-all-closed", () => {
    // The direct-run owner calls app.quit() after its task reaches a terminal state.
  });
}

export const DIRECT_RUN_INJECTED_SYSTEM_CA_ENV = "COWORK_DIRECT_RUN_INJECTED_SYSTEM_CA";

/**
 * Remove the `--use-system-ca` option injected by buildDirectRuntimeLaunch. Node
 * reads NODE_OPTIONS at startup, so the running process keeps the system CA
 * store while child processes (which may be Node < 22.15) no longer receive it.
 */
export function stripInjectedSystemCaOption(env: NodeJS.ProcessEnv): void {
  if (env[DIRECT_RUN_INJECTED_SYSTEM_CA_ENV] !== "1") return;
  delete env[DIRECT_RUN_INJECTED_SYSTEM_CA_ENV];
  const remaining = String(env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((option) => option && option !== "--use-system-ca")
    .join(" ");
  if (remaining) env.NODE_OPTIONS = remaining;
  else delete env.NODE_OPTIONS;
}
