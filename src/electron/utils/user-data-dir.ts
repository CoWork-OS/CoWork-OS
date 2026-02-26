import os from "os";
import path from "path";

/**
 * Resolve the userData directory for persistence (DB + settings).
 *
 * In Electron runtime, this will usually be `app.getPath('userData')`.
 * In headless/server deployments we also support `COWORK_USER_DATA_DIR` as an override.
 * As a convenience, `--user-data-dir <path>` is also supported (works in both Electron and Node entrypoints).
 *
 * This helper intentionally avoids a static `import { app } from 'electron'` so it can be reused
 * by future non-Electron daemon entrypoints.
 */
export function getUserDataDir(): string {
  const override = process.env.COWORK_USER_DATA_DIR;
  if (typeof override === "string" && override.trim().length > 0) {
    const trimmed = override.trim();
    const expanded =
      trimmed === "~"
        ? os.homedir()
        : trimmed.startsWith("~/")
          ? path.join(os.homedir(), trimmed.slice(2))
          : trimmed;
    return path.resolve(expanded);
  }

  // CLI override (useful for local testing and future non-Electron daemons).
  // Accepts both `--user-data-dir /path` and `--user-data-dir=/path`.
  const argv = process.argv || [];
  const flag = "--user-data-dir";
  const idx = argv.indexOf(flag);
  const rawFromArgv =
    (idx !== -1 && typeof argv[idx + 1] === "string" ? argv[idx + 1] : undefined) ??
    argv.find((a) => typeof a === "string" && a.startsWith(flag + "="))?.slice(flag.length + 1);
  if (typeof rawFromArgv === "string" && rawFromArgv.trim().length > 0) {
    const trimmed = rawFromArgv.trim();
    const expanded =
      trimmed === "~"
        ? os.homedir()
        : trimmed.startsWith("~/")
          ? path.join(os.homedir(), trimmed.slice(2))
          : trimmed;
    return path.resolve(expanded);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const app = electron?.app;
    if (app?.getPath) {
      return app.getPath("userData");
    }
  } catch {
    // Not running under Electron.
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return path.join(home, ".cowork");
}
