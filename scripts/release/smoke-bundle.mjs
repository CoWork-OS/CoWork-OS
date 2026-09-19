import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "./package-bundle.mjs";

const directory = process.env.RELEASE_BUNDLE_DIR;
const manifest = readBundle(directory, {
  tag: process.env.RELEASE_TAG,
  sha: process.env.RELEASE_SHA,
});
const script = fileURLToPath(new URL("../release-smoke-install.mjs", import.meta.url));
for (const entry of manifest.packages) {
  // Installation/setup scripts need no publication credentials.
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) delete env[key];
  env.COWORK_RELEASE_TARBALL = path.resolve(directory, entry.filename);
  env.COWORK_RELEASE_PACKAGE_NAME = entry.name;
  const result = spawnSync(process.execPath, [script], { env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`Retained package smoke check failed for ${entry.id}`);
  }
}
// Ensure validation did not change the bytes that will be published.
readBundle(directory, { tag: manifest.tag, sha: manifest.sourceSha });
