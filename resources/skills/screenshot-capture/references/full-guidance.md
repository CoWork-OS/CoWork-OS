# Screenshot Capture

Use this skill when the quality of the work depends on getting a screenshot from the right place with the right save location.

## Save-Location Rules

Follow these save-location rules every time:

1. If the user specifies a path, save there.
2. If the user asks for a screenshot without a path, save to the OS default screenshot location.
3. If Codex needs a screenshot for its own inspection, save to the temp directory.

When reporting results, always include the saved file path.

## Tool Priority

Prefer tool-specific screenshot capabilities when available.

Examples:

- Use a Figma MCP/skill for Figma files.
- Use Playwright or other browser tools for browser or Electron apps.

Use this skill when:

- The user explicitly asks for screenshots.
- You need a whole-system desktop capture.
- A tool-specific capture cannot get what you need.

Otherwise, treat this skill as the default for desktop apps without a better-integrated capture tool.

## macOS Permission Preflight

On macOS, run the preflight helper once before window or app capture.

It checks Screen Recording permission, explains why it is needed, and requests it in one place.

The helpers route Swift's module cache to:

```bash
$TMPDIR/codex-swift-module-cache
```

To avoid multiple sandbox approval prompts, combine preflight and capture in one command when possible:

```bash
bash <path-to-skill>/scripts/ensure_macos_permissions.sh && \
python3 <path-to-skill>/scripts/take_screenshot.py --app "Codex"
```

For Codex inspection runs, keep the output in temp:

```bash
bash <path-to-skill>/scripts/ensure_macos_permissions.sh && \
python3 <path-to-skill>/scripts/take_screenshot.py --app "<App>" --mode temp
```

Use the bundled scripts to avoid re-deriving OS-specific commands.

## macOS and Linux

Run the helper from the repo root:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py
```

Common patterns:

Default location:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py
```

Temp location:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --mode temp
```

Explicit location:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --path output/screen.png
```

App/window capture by app name (macOS only; substring match is OK; captures all matching windows):

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --app "Codex"
```

Specific window title within an app (macOS only):

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --app "Codex" --window-name "Settings"
```

List matching window ids before capturing (macOS only):

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --list-windows --app "Codex"
```

Pixel region:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --mode temp --region 100,200,800,600
```

Focused or active window:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --mode temp --active-window
```

Specific window id:

```bash
python3 <path-to-skill>/scripts/take_screenshot.py --window-id 12345
```

The script prints one path per capture. When multiple windows or displays match, it prints multiple paths, one per line, and adds suffixes like `-w<windowId>` or `-d<display>`. View each path sequentially with the image viewer tool, and only manipulate images if needed or requested.

## Multi-Display Behavior

On macOS, full-screen captures save one file per display when multiple monitors are connected.

On Linux and Windows, full-screen captures use the virtual desktop, meaning all monitors in one image. Use `--region` to isolate a single display when needed.

## Linux Prerequisites and Selection Logic

The helper automatically selects the first available tool:

- `scrot`
- `gnome-screenshot`
- ImageMagick `import`

If none are available, ask the user to install one of them and retry.

Coordinate regions require `scrot` or ImageMagick `import`.

`--app`, `--window-name`, and `--list-windows` are macOS-only. On Linux, use `--active-window` or provide `--window-id` when available.

## Windows

Use the PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1
```

Common patterns:

Default location:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1
```

Temp location:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1 -Mode temp
```

Explicit path:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1 -Path "C:\Temp\screen.png"
```

Pixel region:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1 -Mode temp -Region 100,200,800,600
```

Active window:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1 -Mode temp -ActiveWindow
```

Specific window handle:

```powershell
powershell -ExecutionPolicy Bypass -File <path-to-skill>/scripts/take_screenshot.ps1 -WindowHandle 123456
```

## Direct OS Commands

Use these when you cannot run the helpers.

### macOS

Full screen to a specific path:

```bash
screencapture -x output/screen.png
```

Pixel region:

```bash
screencapture -x -R100,200,800,600 output/region.png
```

Specific window id:

```bash
screencapture -x -l12345 output/window.png
```

Interactive selection or window pick:

```bash
screencapture -x -i output/interactive.png
```

### Linux

Full screen:

```bash
scrot output/screen.png
gnome-screenshot -f output/screen.png
import -window root output/screen.png
```

Pixel region:

```bash
scrot -a 100,200,800,600 output/region.png
import -window root -crop 800x600+100+200 output/region.png
```

Active window:

```bash
scrot -u output/window.png
gnome-screenshot -w -f output/window.png
```

## Error Handling

On macOS, run `bash <path-to-skill>/scripts/ensure_macos_permissions.sh` first to request Screen Recording in one place.

If you see `screen capture checks are blocked in the sandbox`, `could not create image from display`, or Swift module cache permission errors in a sandboxed run, rerun the command with escalated permissions.

If macOS app or window capture returns no matches, run `--list-windows --app "AppName"` and retry with `--window-id`, and make sure the app is visible on screen.

If Linux region or window capture fails, check tool availability with `command -v scrot`, `command -v gnome-screenshot`, and `command -v import`.

If saving to the OS default location fails with permission errors in a sandbox, rerun the command with escalated permissions.

Always report the saved file path in the response.
