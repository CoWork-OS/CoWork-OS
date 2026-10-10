// Launches the CoWork desktop app with Playwright's _electron.
//
// Without `executablePath`, Playwright preloads its Electron loader, which adds Chromium's
// test switches, including --use-mock-keychain: safeStorage then uses a mock key, so a real
// profile's settings are unreadable (the app refuses to save and logs why). That is fine
// for disposable profiles. Pass `realKeychain: true` to keep the OS keychain, e.g. to drive
// the user's own profile; Playwright then skips the loader.
import { createRequire } from "node:module";
import path from "node:path";

export async function launchCoworkDesktop(
  electron,
  { root, realKeychain = false, args = [], ...options },
) {
  const require = createRequire(path.join(root, "package.json"));
  return electron.launch({
    ...options,
    args: [root, ...args],
    cwd: options.cwd ?? root,
    ...(realKeychain ? { executablePath: require("electron") } : {}),
  });
}
