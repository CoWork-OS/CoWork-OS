import path from "node:path";
import { createRequire } from "node:module";
const [root, profile, waitMs = "40000"] = process.argv.slice(2);
const require = createRequire(path.join(root, "package.json"));
const { _electron: electron } = require("playwright");
const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: profile,
  COWORK_DISABLE_OS_KEYCHAIN: "1",
  COWORK_IMPORT_ENV_SETTINGS: "0",
  COWORK_DISABLE_UPDATE_CHECK: "1",
  COWORK_DEV_BRAND_APP: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
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
await app.close();
console.log("warmed", profile);
