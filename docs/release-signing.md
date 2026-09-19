# Release Signing

How CoWork OS verifies that a downloaded update is the artifact the maintainers
published, and how to switch that verification on.

## Why this exists

Neither shipped desktop platform is code-signed today:

- macOS packages with `COWORK_MAC_UNSIGNED=1`, which sets an ad-hoc signing
  identity (`identity: "-"`) and disables notarization.
- Windows has no `publisherName` in the build config. The installed
  `electron-updater` short-circuits its own check when that field is absent —
  `verifySignature` returns `null` without validating anything.

That leaves the `sha512` in `latest.yml` as the only integrity control. Because
`latest.yml` is uploaded to the same GitHub release as the artifact it describes,
anyone who can replace one asset can replace both, and the checksum still
matches.

The detached-signature scheme below closes that without requiring an Apple
Developer ID or a Windows certificate. Signing an artifact requires the private
key, which lives only in CI secrets, so replacing a release asset is no longer
sufficient to ship a modified update.

Code signing remains worth doing — it also satisfies Gatekeeper and SmartScreen,
which this does not. Treat this as the integrity control that works today, not a
replacement.

## Current state

**Verification is inert until a key is generated.**
`RELEASE_SIGNING_PUBLIC_KEY` in `src/electron/updater/release-signing-key.ts` is
an empty string, so `isReleaseSignatureEnforced()` returns `false`, the updater
behaves exactly as before, and it logs a warning noting that no key is embedded.

This default was chosen so existing installs do not lose the ability to update
before a key exists. Once a key is embedded, an artifact whose signature is
missing or invalid is **refused**, and `installUpdate` throws rather than handing
an unverified file to `quitAndInstall`.

## Enabling it

### 1. Generate the keypair (once, locally)

```sh
node scripts/release/generate-signing-key.mjs
```

This prints an Ed25519 keypair. Run it locally, not in CI — it writes the private
key to stdout.

### 2. Embed the public key

Paste the printed public key into `src/electron/updater/release-signing-key.ts`:

```ts
export const RELEASE_SIGNING_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\n...";
```

Commit it. The public key is not a secret; it must ship inside the app so the
updater can verify against it.

### 3. Store the private key as a CI secret

Add the printed private key as the `RELEASE_SIGNING_PRIVATE_KEY` GitHub Actions
secret, and keep an encrypted offline backup. Losing it means you cannot ship a
verifiable update to existing installs without a key rotation.

### 4. Verify the release job signs

`.github/workflows/release.yml` runs `scripts/release/sign-release-artifacts.mjs`
after packaging and before uploading. It writes a detached `<artifact>.sig`
(base64) next to each `.exe`, `.dmg`, `.zip`, `.AppImage`, `.deb`, `.rpm`,
`.blockmap`, and `.yml`, and the upload step includes `release/*.sig`.

Without the secret set, the script prints a message and exits `0` rather than
failing the build — so a fork or a pre-key-generation build still completes.
Confirm the `.sig` assets are present on the release before trusting enforcement.

## How verification runs

1. `autoUpdater.autoDownload` is `false`; the download is explicit.
2. On `update-downloaded`, `verifyDownloadedArtifact` reads the local
   `downloadedFile` path and the release asset name from the event, fetches
   `<asset>.sig` from the release, and verifies the Ed25519 signature over the
   artifact bytes against the embedded public key.
3. A failure clears `updateReadyToInstall`, reports the reason to the renderer,
   and logs it. `installUpdate` then refuses, directing the user to download
   manually.
4. When no public key is embedded, verification returns success with reason
   `no_public_key_configured` and the updater logs a warning.

Implementation: `src/electron/updater/release-signature.ts`, wired in
`src/electron/updater/update-manager.ts`. It uses only Node's `crypto` — there is
no external signing tool to install.

## Rotating the key

Rotating breaks verification for installs that still carry the old public key.
Ship the new public key in a release signed by the **old** key first, so existing
installs can verify the update that teaches them the new key, then rotate the CI
secret.

## Related

- [Security Hardening Record](security-hardening.md) — why this control was
  added, and the other findings from the same review.
- [Security Guide](security-guide.md) — the user-facing view of update handling.
