# Document Artifacts

CoWork treats task-created Word-style files as first-class artifacts instead of plain file links.

This page documents the current document artifact concept for local word-processing outputs produced by tasks. The richest in-app experience is for `.docx`: it opens directly in an editable document surface with a Google Docs-style toolbar and saves back to the same file. Other recognized Word-style formats are surfaced as document artifacts with best-effort preview and external-app/folder actions.

Document artifacts are one surface of the broader [Everything Workbench](everything-workbench.md): generated knowledge-work files open in-place, can be reviewed or lightly edited, and keep the follow-up composer beside the artifact.

Artifact creation, updates, attachment reads, and external-open actions remain
subject to the task's [access profile](access-profiles.md) and the normal
approval/export rules. The document viewer's local preview sandbox is a UI
boundary, not an additional permission grant; opening a file in Word, Pages,
or another external app is still an explicit cross-application action.

## User Experience

When a task creates or updates a Word-style document, the task feed renders a compact artifact card by default:

- Word-style document icon
- filename
- `Document · <format>` metadata, for example `Document · DOCX`, `Document · DOC`, `Document · RTF`, `Document · ODT`, or `Document · Pages`
- primary `Open` button
- dropdown options for installed document-capable apps and `Open in folder`

Clicking the main `Open` action opens supported local document previews in the right sidebar by default. The dropdown is reserved for explicit external app actions such as Microsoft Word, Pages, TextEdit, and folder reveal. Generated document rows expand by default so the artifact card is visible without clicking the `Output ready` row first.

The right sidebar can be resized by dragging its left edge. The resized width is persisted globally, so later artifact sidebar opens use the last chosen width while keeping the main task pane above a mobile-sized minimum.

The sidebar viewer includes:

- header with filename, fullscreen toggle, and close button
- toolbar with format, copy, external-open, folder, and save controls when applicable
- editable document surface for `.docx`
- read-only preview surface for non-editable formats

The fullscreen button promotes the same viewer into a full-app document workspace. Fullscreen mode keeps the document editable while preserving a task follow-up composer over the document, similar to the Codex artifact workflow used for spreadsheets.

## Editing Model

DOCX artifacts open directly in edit mode. They do not use the older block-selection modal as the primary editing flow.

The in-app editor supports the current lightweight document editing surface:

- click into the document and edit text directly
- use the top toolbar for undo/redo, style, font, size, bold, italic, underline, alignment, and list controls
- save changes back to the `.docx` file
- copy document text
- open the file externally for full Microsoft Word, Pages, or LibreOffice behavior

For everyday generated document work, this makes CoWork the default Word-style workspace instead of a separate Microsoft Word, Pages, or Google Docs session. Complex layout fidelity, comments, track changes, embedded objects, and advanced native document features still belong in external editors through the provided open actions.

## Fullscreen Follow-Up Flow

Fullscreen document mode has the same follow-up model as fullscreen spreadsheet mode.

- Before a follow-up is sent, the context frame shows the latest relevant turn for the document.
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

After a follow-up prompt completes, the document preview is refreshed from disk so the user sees the updated generated file without closing and reopening the artifact.

## File Reading And Saving

Document preview extraction happens in the Electron process so the renderer receives structured preview data instead of parsing document files in the UI.

Supported behavior by format:

- `.docx`, `.docm`, `.dotx`, `.dotm`: parsed with Mammoth for HTML/text preview and editable block metadata. Macros are ignored and embedded content is not executed. `.docx` can be saved back through the document update IPC.
- `.rtf`: parsed locally into best-effort plain text.
- `.odt`, `.ott`: unzipped with JSZip, then `content.xml` is parsed into best-effort text/paragraph/table content.
- `.doc`: conversion is attempted with available local converters such as macOS `textutil`, then LibreOffice `soffice` if installed. Missing converters return a structured preview-unavailable result instead of crashing the app.
- `.pages`: recognized as a document artifact, but opened externally or through folder actions unless a reliable local parser is added later.

Relevant implementation paths:

- `src/electron/ipc/handlers.ts`: `readFileForViewer` handles document preview data and document save IPC.
- `src/electron/utils/document-preview.ts`: builds renderer-ready document previews and converter fallback metadata.
- `src/electron/utils/document-writer.ts`: writes editable DOCX block data back to `.docx`.
- `src/electron/preload.ts`: exposes the optional `documentPreview` field on `FileViewerResult.data` and the document update IPC.
- `src/shared/document-formats.ts`: centralizes recognized document extensions, metadata labels, and in-app preview/edit support.
- `src/shared/document-preview.ts`: shared preview and editable block types.
- `src/renderer/components/DocumentArtifactCard.tsx`: task-feed document artifact card and open dropdown.
- `src/renderer/components/DocumentArtifactViewer.tsx`: sidebar/fullscreen document viewer, editor toolbar, save, external actions, and fullscreen composer.
- `src/renderer/App.tsx`: owns artifact sidebar/fullscreen layout state, persisted sidebar width, refresh keys, and fullscreen follow-up turn context.

The renderer still receives existing `content` / `htmlContent` fallbacks for compatibility, but the document artifact UI uses `documentPreview` when available.

## Artifact Detection

Document artifact cards are used for:

- `file_created` document outputs
- `file_modified` document outputs
- `artifact_created` document outputs
- primary completion outputs that point to recognized Word-style files

Recognized local Word-style artifact extensions are:

- `.docx`
- `.docm`
- `.dotx`
- `.dotm`
- `.doc`
- `.rtf`
- `.odt`
- `.ott`
- `.pages`

Non-document files keep the existing file viewer behavior unless they have their own specialized artifact surface.

## Test Coverage

Focused coverage lives in:

- `src/electron/utils/__tests__/document-preview.test.ts`
- `src/electron/utils/__tests__/document-writer.test.ts`
- `src/renderer/components/__tests__/document-artifact-card.test.ts`
- `src/renderer/components/__tests__/document-artifact-viewer.test.ts`

Recommended checks when changing this feature:

```bash
npx vitest run \
  src/electron/utils/__tests__/document-preview.test.ts \
  src/electron/utils/__tests__/document-writer.test.ts \
  src/renderer/components/__tests__/document-artifact-card.test.ts \
  src/renderer/components/__tests__/document-artifact-viewer.test.ts

npm run build:react
npm run build:electron
npm run type-check
```

`npm run type-check` should be run before merge, but it may surface unrelated repository-wide type issues if the working tree is already dirty.
