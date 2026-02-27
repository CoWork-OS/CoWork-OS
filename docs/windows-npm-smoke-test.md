# Windows npm Smoke-Test Checklist

Use this checklist to validate the npm installation path (`npm install -g cowork-os`) on a clean Windows machine before release.

## Scope

- Install path: npm global install (not GitHub `.exe` installer)
- Platforms: Windows 11 x64 and Windows 11 ARM64
- Goal: verify first-run setup, launch, and basic task execution

## 1. Environment Prep (Clean State)

Run in **Command Prompt** from `%USERPROFILE%`:

```bat
cd /d %USERPROFILE%
taskkill /F /IM "CoWork OS.exe" /T 2>NUL
taskkill /F /IM electron.exe /T 2>NUL
taskkill /F /IM node.exe /T 2>NUL
set npm_config_runtime=
set npm_config_target=
set npm_config_disturl=
set npm_config_arch=
rmdir /S /Q "%APPDATA%\npm\node_modules\cowork-os" 2>NUL
del /Q "%APPDATA%\npm\cowork-os.cmd" 2>NUL
del /Q "%APPDATA%\npm\coworkctl.cmd" 2>NUL
del /Q "%APPDATA%\npm\coworkd.cmd" 2>NUL
del /Q "%APPDATA%\npm\coworkd-node.cmd" 2>NUL
```

Pass criteria:
- No running CoWork/Electron/Node processes remain.
- No stale global install directory remains.

## 2. Install From npm

```bat
cd /d %USERPROFILE%
npm install -g cowork-os@latest --no-audit --no-fund
npm ls -g cowork-os --depth=0
```

Pass criteria:
- Install succeeds.
- Reported version matches intended release tag.

## 3. First Launch and Native Setup

```bat
cd /d %USERPROFILE%
cowork-os
```

Pass criteria:
- Setup completes without exiting to prompt with `Native setup failed`.
- If on ARM64, fallback logs may appear, but launch still succeeds.
- No `ERR_FILE_NOT_FOUND ... dist/renderer/index.html`.

## 4. Basic UI Smoke

Check manually:
- Main window renders (no permanent black/blank screen).
- Top bar action icons are in expected location on Windows.
- You can create a new session/task.
- Settings screen opens.

Pass criteria:
- UI is interactive and stable for at least 2 minutes.

## 5. Functional Task Smoke

Run one simple prompt in a test workspace, for example:
- "Create a file named `smoke-test.txt` with text `ok`."

Pass criteria:
- Task executes and completes.
- File is created in the selected workspace.

## 6. Restart and Persistence

Close app, then relaunch:

```bat
taskkill /F /IM "CoWork OS.exe" /T 2>NUL
cd /d %USERPROFILE%
cowork-os
```

Pass criteria:
- App reopens successfully.
- Previous session/task list still loads.

## 7. Uninstall/Reinstall Regression Check

```bat
cd /d %USERPROFILE%
npm uninstall -g cowork-os
npm install -g cowork-os@latest --no-audit --no-fund
cowork-os
```

Pass criteria:
- Uninstall does not fail with `EBUSY`.
- Reinstall and relaunch both succeed.

## 8. Record Results

Capture in release notes/PR comment:
- Windows version + CPU architecture (x64/ARM64)
- Node and npm versions (`node -v`, `npm -v`)
- Installed `cowork-os` version
- Pass/fail per checklist section
- Any startup log snippets for failures
