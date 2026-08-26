# Release Notes 0.5.52

Release `0.5.52` upgrades the CoWork OS desktop runtime to Electron 44 and establishes macOS 13 Ventura as the minimum supported Mac operating system. It also makes the support boundary explicit in the launcher, updater, installer metadata, documentation, and release checks.

## What changed

- **Electron 44.0.0** is pinned as the desktop runtime, with `@electron/rebuild` `4.2.0` and an Electron 44-aware `node-abi` lock entry for ABI 149.
- **macOS 13 Ventura or later is required.** The app bundle records `LSMinimumSystemVersion=13.0`; macOS updater metadata records Darwin `22.0.0`.
- **macOS 12 Monterey support ends with 0.5.51.** Monterey users can keep their existing CoWork data and install the final compatible npm release with `npm install -g cowork-os@0.5.51`.
- **Updates are compatibility-aware.** The UI can show that a newer release exists without offering to install it on an unsupported Mac. npm, Git, and packaged update paths repeat the support check before making changes.
- **Packaged updates use the complete check/download sequence.** `electron-updater` checks release metadata with automatic download disabled before an explicit download begins.
- **Notification delivery has a fallback.** If the operating system accepts a native notification object but later reports delivery failure, CoWork shows the in-app notification overlay.
- **Native dependency repair uses package metadata.** The setup path reads the required `better-sqlite3` version from the active install instead of relying on a stale embedded version.

## macOS upgrade guidance

The macOS version requirement and Gatekeeper signing state are independent:

- A message saying the operating system is unsupported means the Mac must be upgraded to macOS 13+ or CoWork OS must remain on `0.5.51`.
- A message saying Apple could not verify the app is a Gatekeeper/signing warning on a supported system. Follow the documented **Privacy & Security > Open Anyway** flow for unsigned builds.

The updater and npm launcher do not delete the local database or app-data directory when they block an unsupported release.

## Release validation

Release candidates should pass:

```bash
npx vitest run tests/platform-support.test.ts \
  tests/release-platform-metadata.test.ts \
  src/electron/notifications/__tests__/NativeNotificationCenter.test.ts \
  src/electron/updater/__tests__/update-manager-platform.test.ts \
  src/renderer/components/__tests__/Sidebar.test.ts
npm run build:electron
npm run type-check
npm run package:mac:smoke -- --expected-version=0.5.52
```

The macOS artifact smoke test verifies the application version, bundle identifier, and minimum system version. The updater metadata check verifies the Darwin 22 floor. Run the normal clean-worktree release smoke and platform packaging workflow before publishing.

WebMCP is intentionally outside this release and is unchanged.
