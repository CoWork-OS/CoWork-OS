/**
 * Sign each release artifact with the Ed25519 release key, producing a detached
 * `<artifact>.sig` (base64) next to it.
 *
 * Run in CI after packaging, before uploading assets:
 *   RELEASE_SIGNING_PRIVATE_KEY="$SECRET" node scripts/release/sign-release-artifacts.mjs
 *
 * No-op with a clear message when the secret is absent, so a fork or a
 * pre-key-generation build still completes — the app treats a missing signature
 * as unverifiable and refuses to auto-install only once a public key is
 * embedded, which is the same condition under which this secret should exist.
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RELEASE_DIR = process.env.RELEASE_DIR || "release";
const SIGNABLE = /\.(exe|dmg|zip|AppImage|deb|rpm|blockmap|yml)$/i;

const pem = process.env.RELEASE_SIGNING_PRIVATE_KEY;
if (!pem || pem.trim().length === 0) {
  console.log(
    "RELEASE_SIGNING_PRIVATE_KEY is not set; skipping artifact signing. " +
      "Releases will not carry detached signatures.",
  );
  process.exit(0);
}

if (!existsSync(RELEASE_DIR)) {
  console.error(`Release directory not found: ${RELEASE_DIR}`);
  process.exitCode = 1;
  process.exit();
}

const key = createPrivateKey(pem);
const entries = readdirSync(RELEASE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && SIGNABLE.test(entry.name) && !entry.name.endsWith(".sig"))
  .map((entry) => entry.name);

if (entries.length === 0) {
  console.error(`No signable artifacts found in ${RELEASE_DIR}`);
  process.exitCode = 1;
  process.exit();
}

for (const name of entries) {
  const filePath = join(RELEASE_DIR, name);
  const signature = cryptoSign(null, readFileSync(filePath), key).toString("base64");
  writeFileSync(`${filePath}.sig`, `${signature}\n`, "utf8");
  console.log(`Signed ${name}`);
}

console.log(`Signed ${entries.length} artifact(s).`);
