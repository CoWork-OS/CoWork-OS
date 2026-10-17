# Windows Installation

CoWork OS ships a 64-bit Windows installer. There are three ways to install it. Pick the PowerShell installer unless you have a reason not to: it verifies the download against the published checksum and avoids the SmartScreen prompt a browser download gets.

| Method                                                    | SmartScreen prompt | Needs                         |
| --------------------------------------------------------- | ------------------ | ----------------------------- |
| [PowerShell installer](#powershell-installer) (recommended) | None             | PowerShell 5.1 or later       |
| [Installer from GitHub Releases](#installer-and-smartscreen) | Yes, once        | Browser                       |
| [`npm install -g cowork-os`](#npm)                        | None               | Node.js; builds native modules |

## PowerShell installer

Open **PowerShell** (not as administrator) and run:

```powershell
irm https://coworkosapp.com/install.ps1 | iex
```

`coworkosapp.com/install.ps1` serves [`scripts/install-windows.ps1`](../scripts/install-windows.ps1) from the `main` branch. It stops at the first failed check without installing anything:

1. Downloads the release's updater metadata (`latest.yml`) from GitHub Releases and reads the installer name and SHA-512 from it.
2. Downloads `CoWork-OS-Setup-<version>.exe` and checks its SHA-512 against the metadata.
3. Runs the installer silently for the current user, so no administrator prompt appears, then opens CoWork OS.

On Windows on ARM (for example Windows 11 on an Apple Silicon Mac or a Snapdragon laptop), the same command installs the x64 build, which Windows runs through its built-in x64 emulation.

Re-run the same command to update. To pass options, run the script as a script block:

```powershell
& ([scriptblock]::Create((irm https://coworkosapp.com/install.ps1))) -Version 0.5.60 -NoLaunch
```

| Option            | Effect                                                     |
| ----------------- | ---------------------------------------------------------- |
| `-Version X.Y.Z`  | Install a specific release instead of the latest one.      |
| `-NoLaunch`       | Do not open the app afterwards.                            |
| `-DryRun`         | Show which release and file would be installed.            |
| `-Help`           | List every option and the matching `COWORK_INSTALL_*` environment variables. |

To read the script before running it, download it from the link above, open it in any editor, then run `powershell -ExecutionPolicy Bypass -File install-windows.ps1`. The script does not change SmartScreen, Defender or execution-policy settings.

## Installer and SmartScreen

CoWork OS installers are not code signed. Windows SmartScreen shows **Windows protected your PC** for unsigned programs downloaded in a browser, because the browser marks the file as coming from the internet. If you download `CoWork-OS-Setup-<version>.exe` from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest):

1. Run the installer. When SmartScreen appears, click **More info**.
2. Check that the **App** line shows `CoWork-OS-Setup-<version>.exe` (the publisher shows as unknown because the file is unsigned), then click **Run anyway**.

You can compare the file with the published checksum first: the `sha512` value in the release's `latest.yml` is the base64 SHA-512 of the installer.

```powershell
[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes("$HOME\Downloads\CoWork-OS-Setup-0.5.60.exe")))
```

### Antivirus warnings

Some antivirus products flag new, unsigned Electron installers on reputation alone, before many people have downloaded a given build. These are false positives. If your antivirus quarantines the installer, check the checksum as above, then restore it or use the PowerShell installer or npm. Please [open an issue](https://github.com/CoWork-OS/CoWork-OS/issues/new) with the product name and the detection name so we can report the false positive to the vendor.

## npm

```powershell
npm install -g cowork-os
cowork-os
```

- Run `npm install -g cowork-os` and `npm uninstall -g cowork-os` from `%USERPROFILE%` or another neutral folder, **not** from `%APPDATA%\npm\node_modules\cowork-os`, to avoid `EBUSY` lock errors.
- On Windows ARM64, the first launch may take longer while native modules are rebuilt; setup falls back to x64 Electron emulation when ARM64 prebuilds are unavailable.
- If the native rebuild fails, install [Visual Studio Build Tools 2022 (C++)](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and Python 3, then retry.
- If startup logs show `ERR_FILE_NOT_FOUND ... dist/renderer/index.html`, reinstall the latest package and see [Troubleshooting](troubleshooting.md).

## Uninstall

Open **Settings > Apps > Installed apps**, find **CoWork OS**, and choose **Uninstall**. Your settings and data stay in your user profile. Some updates that add native dependencies need a full uninstall before reinstalling; the release notes say when.

## First start

Choose how to power AI; [Getting Started](getting-started.md) walks through the first task.
