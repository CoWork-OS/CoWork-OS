---
name: cli-anything
description: Drive desktop apps (LibreOffice, GIMP, Blender, Inkscape, Audacity, Draw.io, Kdenlive, Shotcut, Krita, FreeCAD, MuseScore) headless through CLI-Anything harnesses with JSON output, instead of clicking through the app window with native_app.
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source-author: "HKUDS"
  source: https://github.com/HKUDS/CLI-Anything
  pinned-commit: 34f519533bc175d2fe287ab8316b0dd99bb9cc43
---

# CLI-Anything

CLI-Anything harnesses are Python command-line tools named `cli-anything-<app>`. Each one
drives the app's real backend (headless LibreOffice, Blender's bpy, Pillow/GIMP batch, sox,
melt) and prints JSON with `--json`. They make the same file edits as clicking through the
app, but scripted, repeatable and verifiable.

## When to use

- The user wants a file produced or edited with one of the apps below, or in that app's
  format (ODF documents, layered GIMP images, `.blend` scenes, Inkscape SVG, Draw.io
  diagrams, audio/video edits).
- Prefer a harness over `native_app` UI control for that work. Use `native_app` only when
  the user asks to operate or watch the app's window, or the harness lacks the operation.
- Do not use when the task forbids scripting, for Photoshop (use the local Photoshop
  route), or when CoWork's built-in document tools already cover a plain DOCX/XLSX/PPTX
  request that does not name one of these apps.

## 1. Find installed harnesses

```bash
for d in ${PATH//:/ } "$HOME/.local/bin"; do ls "$d"/cli-anything-* 2>/dev/null; done | sort -u
```

## 2. Install a missing harness (ask first)

Installing runs third-party code from GitHub. Ask the user before installing, name the
harness, and install the pinned commit with uv (falls back to `python3 -m pip install --user`):

```bash
uv tool install --python 3.11 \
  "git+https://github.com/HKUDS/CLI-Anything.git@34f519533bc175d2fe287ab8316b0dd99bb9cc43#subdirectory=<dir>/agent-harness"
```

| App | `<dir>` | Command | Also needs |
|-----|---------|---------|------------|
| LibreOffice Writer/Calc/Impress | `libreoffice` | `cli-anything-libreoffice` | LibreOffice (`soffice`) for PDF/DOCX/XLSX/PPTX export |
| GIMP | `gimp` | `cli-anything-gimp` | add `--with Pillow` (not declared upstream); GIMP optional |
| Blender | `blender` | `cli-anything-blender` | Blender |
| Inkscape | `inkscape` | `cli-anything-inkscape` | Inkscape |
| Audacity | `audacity` | `cli-anything-audacity` | sox |
| Draw.io | `drawio` | `cli-anything-drawio` | draw.io desktop for export |
| Kdenlive / Shotcut | `kdenlive` / `shotcut` | `cli-anything-kdenlive` / `cli-anything-shotcut` | melt |
| Krita, FreeCAD, MuseScore, OBS Studio, Zotero, Calibre | same name (`obs-studio`) | `cli-anything-<dir>` | the app |

Keep uv's default bin directory (`~/.local/bin`). CoWork's sandboxed shell only puts
standard locations on PATH (`~/.local/bin`, Homebrew, `bin` directories in your home folder).
A harness installed anywhere else gives "command not found" in run_command.

On macOS, install a missing app with Homebrew only after the user agrees, for example
`brew install --cask libreoffice`. Remove a harness with `uv tool uninstall <package>`.

## 3. Run commands

- Always pass `--json`, and run one subcommand per call. Never start the bare command or
  `repl`: that opens an interactive REPL and hangs.
- Keep state in a project file in the workspace: create it with `-o <abs path>`, then pass
  `--project <abs path>` to every later command. Each command saves the project.
- Read `cli-anything-<app> <group> <command> --help` before guessing flags.
- Do not use shell here-documents (`python3 - <<'PY'`): the sandboxed shell cannot create
  their temp files. Use `python3 -c '...'` or write a script file into the workspace.
- Failure: exit code 1 with `{"error": ..., "type": ...}` on stdout, or a Python traceback.
  Read the error, fix the arguments, and do not retry blindly.

LibreOffice example:

```bash
L=cli-anything-libreoffice; P="$PWD/memo.lo-cli.json"
$L --json document new --type writer -n memo -o "$P"
$L --json --project "$P" writer add-heading -t "Q4 Plan" -l 1
$L --json --project "$P" writer add-paragraph -t "Summary text"
$L --json --project "$P" export render "$PWD/memo.pdf" -p pdf --overwrite
```

GIMP example:

```bash
G=cli-anything-gimp; P="$PWD/banner.gimp-cli.json"
$G --json project new -w 1200 -h 630 -bg "#1e293b" -o "$P"
$G --json --project "$P" layer new -n accent --type solid -w 1200 -h 120 --fill "#f97316"
$G --json --project "$P" layer set 0 offset_y 510
$G --json --project "$P" layer new -n title --type image -w 1200 -h 630 --fill transparent
$G --json --project "$P" draw text -l 0 -t "Launch" --x 80 --y 240 --size 72 --color "#ffffff"
$G --json --project "$P" export render "$PWD/banner.png" -p png --overwrite
```

## Known harness bugs (pinned commit)

- LibreOffice `export render` uses the `odt` preset unless you pass `-p`, whatever the file
  extension says. Exporting a Calc project to `budget.ods` without `-p ods` silently writes
  an empty Writer file. Always pass `-p` matching the extension (`odt`, `ods`, `odp`, `pdf`,
  `docx`, `xlsx`, `pptx`, `csv`, `html`, `text`).
- LibreOffice Calc formulas from `calc set-cell --formula` evaluate to `Err:510`/`#VALUE!`
  in LibreOffice and in XLSX. Compute values yourself and write them with `--type float`;
  mention that the cells hold values, not live formulas.
- GIMP `--type text` layers draw their `text` property at 24 px in the top-left corner,
  and `layer set` cannot change it. For titles, use a transparent `--type image` layer
  plus `draw text` (as in the example) and leave text layers out.
- GIMP renders through Pillow when GIMP is absent; without Pillow it fails with
  "Neither GIMP nor Pillow is available".

## 4. Verify the output

The JSON from a command acknowledges that it ran, not that the result is right. Check the
saved file before reporting success:

- Images: `cli-anything-gimp --json media probe <file>` for size and format, then view it.
- Documents: re-import with `cli-anything-libreoffice --json document open <file> -o <new project>`
  and read cells with `calc get-cell` or content with `writer list`, or convert to CSV/text
  with `soffice --headless --convert-to csv`.
- Confirm the type with `file <output>`.

Report the output paths, which harness and version produced them, and any limits you hit.
