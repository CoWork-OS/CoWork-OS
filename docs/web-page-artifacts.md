# Web Page Artifacts

CoWork treats generated local web pages as first-class artifacts instead of plain HTML previews.

This page documents the current web artifact concept for generated `.html` / `.htm` files and built React-style output. The v1 experience is a sandboxed review surface: users can open a generated page in the task feed, inspect it in a resizable right sidebar or fullscreen mode, then request follow-up changes through the same composer used by spreadsheet, document, and presentation artifacts.

Web page artifacts are one surface of the broader [Everything Workbench](everything-workbench.md): generated knowledge-work files open in-place, can be reviewed in context, and keep the follow-up composer beside the artifact.

Live website testing uses a related but separate surface: the in-app browser workbench. Prompts such as "go to llmwizard.com and test the application as a normal user" open a visible browser session in the resizable right sidebar so the agent and user share the same page. Generated `.html` files remain durable web page artifacts; live URLs use browser automation.

## Supported Outputs

In-app preview:

- `.html`
- `.htm`
- built React/Vite/Next output entrypoints such as `dist/index.html`, `build/index.html`, or `out/index.html`

Recognized but not auto-built:

- React, Vite, or Next project folders
- React-style `package.json` files

If a React-style project is detected but no built `index.html` exists in `dist`, `build`, or `out`, CoWork shows a structured preview-unavailable state with folder/browser actions instead of starting a dev server or failing the file open.

V1 does not auto-run React, Vite, or Next dev servers. It previews local generated HTML and already-built output only.

## User Experience

When a task creates or updates a web page, the task feed renders a compact artifact card:

- web/browser-style icon
- filename
- `Web page · <format>` metadata, for example `Web page · HTML` or `Web page · HTM`
- primary `Open` button
- dropdown actions for `Open in browser`, `Open in folder`, and `Copy path`

Clicking the main `Open` action opens previewable local web pages in the right sidebar by default. Generated web rows expand by default so the artifact card is visible without clicking the `Output ready` row first.

The right sidebar can be resized by dragging its left edge. The resized width is shared with the other artifact workbenches and persisted globally, so later artifact opens use the last chosen width while keeping the main task pane above a mobile-sized minimum.

The sidebar viewer includes:

- header with filename, fullscreen toggle, and close button
- toolbar with format, copy, browser-open, and folder actions
- sandboxed iframe preview for generated HTML
- preview-unavailable state for React-style projects that need a build output

The fullscreen button promotes the same viewer into a full-app web preview workspace. Fullscreen mode keeps the preview available while preserving the functional follow-up composer and latest-turn/working context frame.

## Preview Model

Web preview extraction happens in the Electron process so the renderer receives iframe-ready content instead of reading workspace files directly.

Preview behavior:

- HTML/HTM files are read from disk and returned through `webPreview.htmlContent`.
- Local relative assets are inlined through the shared HTML asset pipeline where possible.
- The iframe uses a sandboxed preview mode.
- Built React/Vite/Next output is treated as normal HTML once `dist/index.html`, `build/index.html`, or `out/index.html` exists.
- React-style source projects without built output return `canPreview: false` plus a preview message explaining that build output is needed.

The preview contract is `FileViewerResult.data.webPreview`:

```ts
{
  format: "html";
  previewMode: "sandboxed_iframe";
  title?: string;
  htmlContent?: string;
  sourcePath: string;
  baseDir: string;
  projectRoot?: string;
  framework?: "react" | "vite" | "next" | "html";
  canPreview: boolean;
  previewMessage?: string;
}
```

The existing `htmlContent` field remains available for compatibility with older HTML preview paths.

## Fullscreen Follow-Up Flow

Fullscreen web mode uses the same follow-up model as the spreadsheet, document, and presentation artifact workbenches.

- Before a follow-up is sent, the context frame shows the latest relevant turn for the web artifact.
- After the user sends a prompt from fullscreen mode, the prompt box clears immediately and the frame switches to `Working for ...`.
- The expanded frame then shows only assistant messages and step status lines emitted after that prompt.
- Older creation-turn steps are intentionally filtered out after a follow-up begins.
- Step lines use smaller status text. Assistant messages use normal message text.
- The frame remains available after the follow-up completes and can be collapsed or expanded.

After a follow-up prompt completes, the web preview is refreshed from disk only when the relevant HTML or build output is updated or the task completes. During active follow-up work, the current preview stays visible instead of immediately reloading stale content.

The fullscreen composer reuses the main task composer behavior:

- `+` opens the file picker and attaches files to the follow-up
- attached files render as removable chips
- image attachments are passed as image inputs when possible
- the model label opens the same model dropdown used in the main task view
- the microphone uses the same voice input hook and inserts the transcript into the prompt
- send works for text-only, attachment-only, or text plus attachments

## Relationship To Live Canvas

Web page artifacts and Live Canvas are related but separate surfaces.

- **Web page artifacts** are durable task outputs on disk, such as `index.html` or `dist/index.html`. They are opened from task output cards, the artifact sidebar, fullscreen artifact mode, or file preview paths.
- **Live Canvas** is an active agent workspace for iterative HTML/CSS/JavaScript sessions, snapshots, checkpoints, and canvas-specific tooling.

Use web page artifacts when the task produced a local output file that should be reviewed or revised. Use Live Canvas when the agent is actively building or iterating inside a live visual workspace.

## Relationship To Browser Workbench

Web page artifacts and browser-use testing are intentionally different:

- **Web page artifacts** are local files created or updated by a task. They open from artifact cards into a sandboxed iframe preview and refresh only after the relevant output changes or the follow-up task completes.
- **Browser workbench sessions** are live websites or local app URLs being used, clicked, filled, tested, or screenshotted by the agent. They open in a visible Electron webview in the same resizable right sidebar and use a persistent workspace browser profile.
- `Open in browser` on a web artifact still means the external system browser.
- Browser-use prompts can load a generated page into the browser workbench when the user explicitly asks to test it as a live site, but the default artifact-card open path remains the iframe artifact viewer.
- Signed-in external Chrome control remains explicit through Chrome DevTools attach or profile options. The embedded workbench does not silently reuse system Chrome cookies.

## Implementation Files

- `src/shared/web-page-formats.ts`: recognized web artifact extensions and metadata labels.
- `src/shared/web-page-preview.ts`: shared preview contract.
- `src/electron/utils/html-preview-assets.ts`: local HTML asset inlining.
- `src/electron/utils/web-preview.ts`: HTML/build-output preview extraction and React-style project detection.
- `src/electron/ipc/handlers.ts`: `readFileForViewer` web preview branch.
- `src/electron/preload.ts`: optional `webPreview` field on `FileViewerResult.data`.
- `src/renderer/components/WebArtifactCard.tsx`: task-feed web artifact card and dropdown.
- `src/renderer/components/WebArtifactViewer.tsx`: sidebar/fullscreen web viewer, iframe preview, actions, and fullscreen composer integration.
- `src/renderer/components/BrowserWorkbenchView.tsx`: visible browser workbench for live URL testing and browser automation.
- `src/renderer/App.tsx`: shared artifact sidebar/fullscreen state, persisted sidebar width, and follow-up refresh behavior.
- `src/renderer/components/MainContent.tsx`: generated-output detection and inline web artifact card rendering.
- `src/renderer/styles/index.css`: artifact card/viewer and web preview styling.

## Verification

Focused tests:

```bash
npx vitest run \
  src/electron/utils/__tests__/web-preview.test.ts \
  src/renderer/components/__tests__/web-artifact-card.test.ts \
  src/renderer/components/__tests__/web-artifact-viewer.test.ts
```

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
```

Manual smoke checks:

- Generate a small `.html` file.
- Confirm the compact web page card appears without expanding a hidden output row.
- Click **Open** and verify the right-sidebar iframe preview opens.
- Use the dropdown to open in browser, open in folder, and copy the path.
- Toggle fullscreen and verify the follow-up composer and latest-turn/working context frame remain functional.
- Submit a follow-up edit and confirm the preview refreshes after the HTML or built output is updated.
- Open a React-style project without `dist/index.html`, `build/index.html`, or `out/index.html` and confirm the preview-unavailable message is shown instead of starting a dev server.
