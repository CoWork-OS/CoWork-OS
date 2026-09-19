/**
 * Ed25519 public key used to verify release artifacts before installing them.
 *
 * EMPTY = signature enforcement is OFF. The verification code path is complete
 * and inert; nothing checks signatures until a key is put here.
 *
 * To turn it on, once:
 *
 *   node scripts/release/generate-signing-key.mjs
 *
 * That prints a public key (paste it below, commit it) and a private key
 * (store it as the `RELEASE_SIGNING_PRIVATE_KEY` GitHub Actions secret, never
 * commit it). The release workflow then signs each artifact and uploads a
 * matching `.sig` file, and this app refuses to install an artifact whose
 * signature is missing or invalid.
 *
 * Rotating the key makes existing installs unable to verify newer releases, so
 * ship the new public key in a release signed by the OLD key first, then rotate.
 */
export const RELEASE_SIGNING_PUBLIC_KEY = "";
