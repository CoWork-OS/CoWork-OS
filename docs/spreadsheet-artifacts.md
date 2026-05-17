# Spreadsheet Artifacts

CoWork treats task-created spreadsheet files as first-class artifacts instead of plain file links.

This page documents the current spreadsheet concept for local spreadsheet outputs produced by tasks. Editable in-app spreadsheet mode currently supports `.xlsx`, `.xls`, `.xlsm`, `.csv`, and `.tsv`. Native or app-owned formats such as `.numbers`, `.gsheet`, `.ods`, and `.xlsb` are recognized as spreadsheet artifacts, but they open through their owning app/service or folder action rather than being parsed into the local grid.

Spreadsheet artifacts are one surface of the broader [Everything Workbench](everything-workbench.md): generated knowledge-work files open in-place, can be reviewed or lightly edited, and keep the follow-up composer beside the artifact.

## User Experience

When a task creates a spreadsheet, the task feed renders a compact artifact card:

- spreadsheet file icon
- filename
- `Spreadsheet · <format>` metadata, for example `Spreadsheet · XLSX`, `Spreadsheet · CSV`, or `Spreadsheet · Numbers`
- primary `Open` button
- dropdown options for installed spreadsheet-capable apps and `Open in folder`

Clicking the main `Open` action opens supported editable spreadsheets in the right sidebar by default. For native app-owned formats that cannot be parsed locally, the same action opens the file externally. The right sidebar can be resized by dragging its left edge. The resized width is persisted globally, so later spreadsheet sidebar opens use the last chosen width while keeping the main task pane above a mobile-sized minimum.

The sidebar viewer includes:

- header with filename, fullscreen toggle, and close button
- toolbar with file type, working zoom selector, add-row/add-column, copy, and save controls
- formula/address row
- Excel-like grid with sticky row and column headers
- sheet tabs when the workbook has multiple sheets

The fullscreen button promotes the same viewer into a full-app spreadsheet workspace. Fullscreen mode keeps the spreadsheet usable while preserving a task follow-up composer over the grid, similar to the Codex artifact workflow.

## Spreadsheet Interaction

The in-app spreadsheet viewer is intentionally more capable than a static preview:

- select individual cells
- drag-select ranges
- select a full column by clicking the column header
- select a full row by clicking the row header
- copy the selected cell/range/row/column as tab-separated text
- show a short `Copied` confirmation after copy
- edit cells inline by double-clicking or typing into the formula row
- add rows and columns
- save edits back to the workbook
- change zoom with the toolbar selector

The grid preserves enough workbook information for review and light editing:

- sheet names and active sheet
- used row/column bounds
- display values
- formula result display, with formula metadata retained for tooltips/formula row
- empty cells inside the visible bounds
- basic font/fill/alignment styles used for headers and table-like sheets
- column widths

For everyday generated workbook and table work, this makes CoWork the default spreadsheet workspace instead of a separate Excel, Numbers, or Google Sheets session. Advanced native-only spreadsheet behavior such as macros, complex pivot modeling, and deep cloud collaboration still belongs in external apps through the provided open actions.

## Fullscreen Follow-Up Flow

Fullscreen spreadsheet mode has a task context frame above the composer.

- Before a follow-up is sent, it shows the latest relevant turn for the spreadsheet.
- After the user sends a prompt from fullscreen mode, it switches to `Working for ...`.
- The expanded frame then shows only assistant messages and step status lines emitted after that prompt.
- Older creation-turn steps are intentionally filtered out after a follow-up begins.
- Step lines use smaller status text. Assistant messages use normal message text.
- The frame remains available after the follow-up completes and can be collapsed or expanded.

The fullscreen composer reuses the main task composer behavior:

- `+` opens the file picker and attaches files to the follow-up
- attached files render as removable chips
- image attachments are passed as image inputs when possible
- the model label opens the same model dropdown used in the main task view
- the microphone uses the same voice input hook and inserts the transcript into the prompt
- send works for text-only, attachment-only, or text plus attachments

## File Reading And Saving

Spreadsheet preview extraction happens in the Electron process so the renderer receives structured sheet data instead of parsing spreadsheet files in the UI.

Supported behavior by format:

- `.xlsx`, `.xls`, `.xlsm`: parsed with `exceljs` into structured workbook previews and saved back through the spreadsheet update IPC.
- `.csv`, `.tsv`: parsed with a quoted-field delimited parser into the same sheet preview shape and saved back using the original delimiter.
- `.numbers`, `.gsheet`, `.ods`, `.xlsb`: recognized as spreadsheet artifacts and shown with the same card/dropdown, but opened externally because the app does not currently include reliable local parsers for those native/app-owned formats.

Relevant implementation paths:

- `src/electron/ipc/handlers.ts`: `readFileForViewer` handles editable spreadsheet files and returns structured preview data.
- `src/electron/utils/spreadsheet-preview.ts`: builds renderer-ready workbook and delimited-file previews.
- `src/electron/preload.ts`: exposes the optional `spreadsheetPreview` field on `FileViewerResult.data` and the spreadsheet update IPC.
- `src/shared/spreadsheet-formats.ts`: centralizes recognized spreadsheet extensions, in-app editable formats, and metadata labels.
- `src/shared/spreadsheet-preview.ts`: shared preview types and column-letter helpers.
- `src/renderer/components/SpreadsheetArtifactCard.tsx`: task-feed spreadsheet artifact card and open dropdown.
- `src/renderer/components/SpreadsheetArtifactViewer.tsx`: sidebar/fullscreen spreadsheet viewer, editing, copy, zoom, save, and fullscreen composer.
- `src/renderer/App.tsx`: owns spreadsheet sidebar/fullscreen layout state, persisted sidebar width, and fullscreen follow-up turn context.

The renderer still receives the existing tab-separated `content` fallback for compatibility, but the spreadsheet UI uses `spreadsheetPreview` when available.

Saving uses the structured preview state and writes the updated file through Electron IPC. Workbook formats are saved as workbooks; CSV/TSV files are saved as delimited text with their original delimiter.

## Artifact Detection

Spreadsheet artifact cards are used for:

- `file_created` spreadsheet outputs
- `artifact_created` spreadsheet outputs
- primary completion outputs that point to recognized spreadsheet files

Non-spreadsheet files keep the existing file viewer behavior unless they have their own specialized artifact surface.

## Test Coverage

Focused coverage lives in:

- `src/electron/utils/__tests__/spreadsheet-preview.test.ts`
- `src/renderer/components/__tests__/spreadsheet-artifact-card.test.ts`
- `src/renderer/components/__tests__/spreadsheet-artifact-viewer.test.ts`

Recommended checks when changing this feature:

```bash
npx vitest run \
  src/electron/utils/__tests__/spreadsheet-preview.test.ts \
  src/renderer/components/__tests__/spreadsheet-artifact-card.test.ts \
  src/renderer/components/__tests__/spreadsheet-artifact-viewer.test.ts

npm run build:react
npm run type-check
```

`npm run type-check` should be run before merge, but it may surface unrelated repository-wide type issues if the working tree is already dirty.
