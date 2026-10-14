# Local Photoshop document editing

CoWork can inspect and revise an existing layered PSD through local background Photoshop scripting. Use `npm run dev` for development acceptance; no VM, SSH connection, separate test package, or shell authority is required.

The installed, licensed Photoshop application executes fixed commands. It can start in the background. This route requires an unlocked macOS session and normal Automation consent. It is an experimental, bounded document route, not generic mouse/keyboard automation or unrestricted Photoshop scripting.

## Supported edits

Use `local_photoshop_read` to read a source PSD's file hash, dimensions, layer tree, exact nested name paths, editable text, font size/color, visibility, opacity, and bounds. The read explicitly opens a private file snapshot as Photoshop format and restores the previously active document. Layer classification uses explicit branches compatible with Photoshop’s ExtendScript engine; its chained conditional expressions can differ from current JavaScript engines.

Create an `application_operation` with capability `photoshop.document.edit` and route `local.photoshop.edit.v1`. Supply `app: "photoshop"`, `sourcePath`, the reader's `sourceSha256`, fresh revised `path` and PNG `exportPath`, and `changes`. Source/output resource references are derived when omitted.

| Operation | Fields besides `op` and `layerPath` |
| --- | --- |
| `set_text` | One or more of `contents`, `fontSize` in points, and RGB hexadecimal `color` |
| `set_visibility` | `visible` |
| `set_opacity` | `opacity`, 0–100 |
| `rename_layer` | `name` |
| `translate_layer` | `x`, `y` in pixels; leaf layers only |

A nested layer path is an array such as `["Campaign", "Headline"]`. Operations apply sequentially; a later operation targeting a renamed layer uses its new name. Unsupported filters, resizing, raster replacement, arbitrary code, in-place overwrites, and group translation are not offered.

## Execution and verification

The backend checks read authority for the source and write authority for both outputs before app access, then again after any approval. The source hash binds the edit to the inspected file version. An already-open source with unsaved changes is refused. Missing, ambiguous, fully locked, or incorrectly typed targets are refused before mutation whenever detectable during preparation.

The route opens a private copy of the source, applies bounded changes, saves a fresh layered PSD and a PNG, and closes only that owned document. It restores Photoshop's dialog mode, ruler units and previously active document. The source file and its open document are not edited. Files are bounded to 32 MiB for snapshot/readback; PSD version 1 is supported.

Verification reopens snapshots of the saved source and output, checks the requested layer model and preserved structure, confirms the unchanged source hash, validates PSD/PNG dimensions and hashes, and then registers only the revised outputs. PNGs use the shared inline-image delivery path. Text glyph bounds can change with text edits; verification checks text/style/baseline position instead. Opacity allows only the rounding introduced by its one-byte PSD representation.

A dispatched edit is never replayed. Lost replies or partial outputs are reconciled against the original output paths. A missing file or failed readback is not permission to execute the edit again. The same prepared-change review mechanism remains available for user-requested drafts or consequential commitments. Preparation is journaled as an operation proposal; it does not require a placeholder workspace file. The verified native operation satisfies the edit step’s artifact contract without an additional generic `edit_file` or `write_file` call. Verification of an original edit operation is read-only; the final reply checks artifact presence and does not rewrite or copy an already verified image.

## Development validation

Regression coverage is in `src/electron/applications/__tests__/photoshop-document-edit.test.ts`, with shared routing, permission, native pilot and prompt checks. Acceptance uses a natural prompt in the `npm run dev` app and separately checks the saved files and inline result.
