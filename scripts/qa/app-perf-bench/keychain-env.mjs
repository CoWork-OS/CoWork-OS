// How benchmark launches reach secure settings (BENCH_KEYCHAIN).
//
// "mock" (default): safeStorage stays on. Playwright starts Electron with
// --use-mock-keychain, so settings use the same OS-keychain cipher as on a real Mac,
// with a fixed test key and without touching the real Keychain.
// "off": sets COWORK_DISABLE_OS_KEYCHAIN. Every settings read and write then uses the
// app-level fallback (PBKDF2 with 210k SHA-512 rounds), which makes settings-heavy
// startup steps look far slower than they are for Mac users.
//
// Warm a template in the mode you benchmark it in.
export const KEYCHAIN_MODE = process.env.BENCH_KEYCHAIN === "off" ? "off" : "mock";

export function applyKeychainEnv(env) {
  if (KEYCHAIN_MODE === "off") env.COWORK_DISABLE_OS_KEYCHAIN = "1";
  else delete env.COWORK_DISABLE_OS_KEYCHAIN;
  return env;
}
