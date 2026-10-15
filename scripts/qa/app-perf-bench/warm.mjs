import path from "node:path";
import { createRequire } from "node:module";
import { applyKeychainEnv, KEYCHAIN_MODE } from "./keychain-env.mjs";
const [root, profile, waitMs = "40000"] = process.argv.slice(2);
const require = createRequire(path.join(root, "package.json"));
const { _electron: electron } = require("playwright");
const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: profile,
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_DISABLE_UPDATE_CHECK: "1",
  COWORK_DEV_BRAND_APP: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
applyKeychainEnv(env);
const app = await electron.launch({
  args: [root, "--user-data-dir", profile],
  cwd: root,
  env,
  timeout: 120000,
});
let lines = 0;
app.process().stdout?.on("data", (d) => {
  for (const l of String(d).split("\n"))
    if (/Deferred startup task|backfill|Maintenance step/i.test(l)) console.log(l.slice(0, 200));
  lines++;
});
await new Promise((r) => setTimeout(r, Number(waitMs)));
if (KEYCHAIN_MODE === "mock") {
  // seed.cjs runs outside Electron, so its settings use the app-level fallback cipher.
  // Re-save them with the (mock) keychain cipher a real Mac profile would have.
  const repoPath = path.join(root, "dist/electron/electron/database/SecureSettingsRepository.js");
  const result = await app.evaluate((_electron, file) => {
    const { SecureSettingsRepository } = process.mainModule.require(file);
    return SecureSettingsRepository.getInstance().reEncryptAll();
  }, repoPath);
  console.log("re-encrypted settings", JSON.stringify(result));
}
await app.close();
console.log("warmed", profile, `(keychain: ${KEYCHAIN_MODE})`);
