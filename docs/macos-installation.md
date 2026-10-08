# macOS Installation

CoWork OS ships for Apple Silicon Macs running macOS 13 Ventura or later. There are three ways to install the desktop app. Pick the terminal installer unless you have a reason not to: it is the only download path that never shows the Gatekeeper "Apple could not verify" dialog.

| Method                                                      | Gatekeeper dialog           | Needs                          |
| ----------------------------------------------------------- | --------------------------- | ------------------------------ |
| [Terminal installer](#terminal-installer) (recommended)     | None                        | Terminal, Apple Silicon        |
| [DMG from GitHub Releases](#dmg-and-the-open-anyway-steps)  | Yes, once, with extra steps | Browser, Apple Silicon         |
| [`npm install -g cowork-os`](#npm)                          | None                        | Node.js; builds the app locally |

## Why macOS blocks the DMG

CoWork OS release builds are ad hoc signed. They are not signed with an Apple Developer ID and not notarized by Apple, so Gatekeeper cannot verify them. When you open a copy that was downloaded in a browser, macOS 15 Sequoia and later show **"CoWork OS" Not Opened. Apple could not verify "CoWork OS" is free of malware** with only **Move to Trash** and **Done**. Control-click > **Open** no longer bypasses this; the only way through is **System Settings > Privacy & Security > Open Anyway**. macOS 13 and 14 show a similar dialog but still accept Control-click > **Open**.

Gatekeeper only evaluates files that carry the `com.apple.quarantine` extended attribute. Safari, Chrome, Firefox and every other browser attach it to downloads, and Archive Utility and the Finder propagate it from a DMG or ZIP to the app inside. `curl` does not attach it, and `ditto --noqtn` never propagates it. An app that reaches `/Applications` without that attribute launches like any locally built app. This is the mechanism the terminal installer relies on; it does not change any Gatekeeper setting and does not affect any other app on the Mac.

The app itself is identical in every method. Your settings and data live outside the app bundle and survive reinstalling or switching methods.

## Terminal installer

```bash
curl -fsSL https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/scripts/install-macos.sh | bash
```

The script ([`scripts/install-macos.sh`](../scripts/install-macos.sh)) does the following and stops at the first failed check without installing anything:

1. Confirms it is running on macOS 13 or later on an Apple Silicon Mac and that `curl`, `ditto`, `codesign` and `plutil` are available (all ship with macOS).
2. Downloads the release's updater metadata (`latest-mac.yml`) from GitHub Releases and picks the ZIP for this architecture.
3. Downloads the ZIP and checks its size and SHA-512 against the metadata.
4. Extracts it with `ditto --noqtn`, then verifies the app bundle's code signature with `codesign --verify --deep --strict` and checks its bundle identifier and version.
5. Copies the app into `/Applications`, or into `~/Applications` when `/Applications` is not writable, replacing an existing copy, and opens it.

Re-run the same command to update. If CoWork OS is running from the install location, the installer asks before quitting it. When replacing an existing copy, macOS may ask you to let Terminal manage apps; allow it, or move the old copy to the Trash in Finder first.

Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/scripts/install-macos.sh | bash -s -- --version 0.5.60 --no-launch
```

| Option              | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `--version X.Y.Z`   | Install a specific release instead of the latest one.                   |
| `--install-dir DIR` | Install somewhere other than `/Applications`.                           |
| `--no-launch`       | Do not open the app afterwards.                                         |
| `--yes`             | Quit a running copy without asking.                                     |
| `--dry-run`         | Show which release and file would be installed, and where.              |
| `--help`            | List every option and the matching `COWORK_INSTALL_*` environment variables. |

To read the script before running it, download it from the link above, open it in any editor, then run `bash install-macos.sh`.

To uninstall, delete `CoWork OS.app` from the install directory. Your data stays in your home folder.

Intel Macs: no Intel build is published, so the installer stops with a message. Use [npm](#npm), which builds the app on your machine, or an Apple Silicon Mac.

## DMG and the Open Anyway steps

If you prefer the DMG from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest):

1. Open the DMG and drag **CoWork OS** into **Applications**.

   <img src="../screenshots/macos-install/01-drag-to-applications.png" alt="CoWork OS DMG showing the app icon being dragged into Applications" width="480">

2. Open **CoWork OS** once. When macOS says `"CoWork OS" Not Opened`, click **Done**.

   <img src="../screenshots/macos-install/02-not-opened-warning.png" alt="macOS warning saying CoWork OS was not opened because Apple could not verify it" width="260">

3. Open **System Settings > Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to `"CoWork OS" was blocked to protect your Mac`.

   <img src="../screenshots/macos-install/03-privacy-security-open-anyway.png" alt="macOS Privacy and Security settings with the CoWork OS Open Anyway button highlighted" width="480">

4. Click **Open Anyway** in the confirmation dialog and authenticate.

   <img src="../screenshots/macos-install/04-confirm-open-anyway.png" alt="macOS confirmation dialog asking whether to open CoWork OS anyway" width="260">

Alternatively, remove the quarantine attribute from the copy in Applications and open it normally:

```bash
xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"
```

## npm

```bash
npm install -g cowork-os
cowork-os
```

npm downloads through Node.js, which does not attach the quarantine attribute, and the Electron runtime it fetches is likewise unquarantined, so there is no Gatekeeper dialog. This path compiles native modules on your machine, needs Node.js, and also works on Intel Macs. See the [README](../README.md#or-install-via-npm) for details.

## First start

Whichever method you used, the first start may ask for access to the `cowork-os Safe Storage` keychain item. That is the macOS keychain, not Gatekeeper. Enter your Mac login password and click **Always Allow** so CoWork OS can store local credentials securely.

<img src="../screenshots/macos-install/05-keychain-safe-storage.png" alt="macOS keychain prompt asking to allow CoWork OS safe storage access" width="480">

Then choose how to power AI; [Getting Started](getting-started.md) walks through the first task.

## For maintainers

Only Apple notarization removes the dialog for a browser-downloaded DMG, and notarization requires an Apple Developer Program membership. The signing certificate names the account holder: an **individual** membership puts the member's legal name in the `Developer ID Application` certificate, which anyone can read from the app with `codesign -dvv`, while an **organization** membership shows the organization's legal name instead and requires a registered legal entity with a D-U-N-S number. The packaging scripts already support a signed and notarized build when credentials are configured; see `scripts/mac-notarize.env.example` and `npm run package:mac`.

Until then, releases are built with `npm run package:mac:unsigned`, which ad hoc signs the app so that the bundle stays structurally valid and the **Open Anyway** route works. A Homebrew cask would not remove the dialog on its own, because Homebrew quarantines cask downloads by default unless the user passes `--no-quarantine`.

The macOS release smoke test (`scripts/smoke-desktop-artifacts.mjs`) runs the terminal installer against each build's ZIP and fails the build if the installed app's signature does not verify, the version is wrong, or the result carries the quarantine attribute. Unit tests for the installer's parsing and verification helpers live in `scripts/release/install-macos.test.mjs`.
