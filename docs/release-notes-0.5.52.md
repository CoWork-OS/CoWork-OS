# Release Notes 0.5.52

Release `0.5.52` expands CoWork OS as a free, open-source multi-provider AI super app and upgrades the desktop runtime to Electron 44. It adds OpenRouter image generation, OpenCode Zen and Go routing, guarded SearXNG search, Atlas Cloud transcription, and Browser Use Cloud V4 defaults, while establishing macOS 13 Ventura as the minimum supported Mac operating system.

## What changed

- **OpenRouter image generation** supports every image model exposed by OpenRouter, including `meta/muse-image`, through the dedicated image API. CoWork discovers available image models and endpoint capabilities, forwards only supported parameters, supports provider pinning, multi-image output, advanced image options, and local/HTTP(S)/data-URL reference images, and keeps output paths workspace-safe.
- **OpenCode Zen and Go** are available as curated provider routes with transport-aware Responses API and Anthropic Messages handling, custom Responses-compatible endpoints, and image-capability metadata.
- **SearXNG and Web Search Plus** provide a guarded private-search route with explicit provider selection, locale and safe-search controls, endpoint policy forwarding, settings validation, and packaged workflow guidance.
- **Atlas Cloud transcription** is available as a transcription provider with completed-job success handling.
- **Browser Use Cloud V4** is now the default cloud browser backend, with the existing explicit routing and safety controls retained.
- **Browser and scraping reliability** now includes bounded Browser Use Cloud retries with `Retry-After` handling, structured retryable errors, host-scoped Scrapling throttling, timeout/proxy forwarding, and target response classification.
- **Model browsing** now offers richer metadata, responsive picker layouts, and custom model IDs for provider routes.
- **Electron 44.0.0** is pinned as the desktop runtime, with `@electron/rebuild` `4.2.0` and an Electron 44-aware `node-abi` lock entry for ABI 149.
- **macOS 13 Ventura or later is required.** The app bundle records `LSMinimumSystemVersion=13.0`; macOS updater metadata records Darwin `22.0.0`.
- **macOS 12 Monterey support ends with 0.5.51.** Monterey users can keep their existing CoWork data and install the final compatible npm release with `npm install -g cowork-os@0.5.51`.
- **Updates are compatibility-aware.** The UI can show that a newer release exists without offering to install it on an unsupported Mac. npm, Git, and packaged update paths repeat the support check before making changes.
- **Packaged updates use the complete check/download sequence.** `electron-updater` checks release metadata with automatic download disabled before an explicit download begins.
- **Notification delivery has a fallback.** If the operating system accepts a native notification object but later reports delivery failure, CoWork shows the in-app notification overlay.
- **Native dependency repair uses package metadata.** The setup path reads the required `better-sqlite3` version from the active install instead of relying on a stale embedded version.
- **Reliability and security hardening.** Capability-bundle evaluation now fails closed for incomplete coverage and unresolved managed metadata; legacy migrations and task/state persistence are hardened; mailbox/provider fallbacks are more resilient; and asynchronous native notification failures fall back to the in-app overlay.
- **Documentation and adoption reporting.** Product positioning, provider/access/comparison documentation, bundled skill distribution metadata, and npm all-time coverage reporting were refreshed for this release.
- **Release CI preparation.** Clean test jobs now rebuild the native PTY dependency and generate the pinned Numbat fixture before running the suite.
- **Windows packaging compatibility.** Pinned Numbat archive extraction now uses native Windows drive paths, keeping the Windows installer build aligned with the macOS release path.

## macOS upgrade guidance

The macOS version requirement and Gatekeeper signing state are independent:

- A message saying the operating system is unsupported means the Mac must be upgraded to macOS 13+ or CoWork OS must remain on `0.5.51`.
- A message saying Apple could not verify the app is a Gatekeeper/signing warning on a supported system. Follow the documented **Privacy & Security > Open Anyway** flow for unsigned builds.

The updater and npm launcher do not delete the local database or app-data directory when they block an unsupported release.

## Release validation

The release candidate was validated with:

```bash
npm test
npm run build
npm run release:smoke
npm run qa:positioning-copy
npm run qa:security:harness -- --fail-on-findings
npm run qa:eval:run -- --suite reliability-regressions --mode deterministic --allow-empty
npx vitest run tests/platform-support.test.ts \
  tests/release-platform-metadata.test.ts \
  src/electron/notifications/__tests__/NativeNotificationCenter.test.ts \
  src/electron/updater/__tests__/update-manager-platform.test.ts \
  src/renderer/components/__tests__/Sidebar.test.ts
npm run build:electron
npm run type-check
npm run package:mac:smoke -- --expected-version=0.5.52 --allow-unsigned
```

The clean release smoke installs the packed npm artifact into a fresh project, runs setup, rebuilds Electron-native modules, and verifies `better-sqlite3` under Electron. The macOS artifact smoke test verifies the application version, bundle identifier, and minimum system version. The updater metadata check verifies the Darwin 22 floor. The local reliability suite had no seeded cases, so it was run with the explicit empty-suite allowance; CI or a seeded QA database must execute real cases before treating that suite as coverage. Production signing/notarization and Windows/Linux packaging remain CI/platform gates.

WebMCP is intentionally outside this release and is unchanged.
