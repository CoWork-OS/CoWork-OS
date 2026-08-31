# Presentation Artifacts and PPTX Preview

CoWork treats generated PowerPoint decks as first-class presentation artifacts. The current model is review-first: users can inspect slides in the task feed, a resizable right sidebar, or fullscreen mode, then request changes through the same follow-up composer used for spreadsheet and document artifacts. Direct slide editing controls are not part of v1.

Presentation artifacts are one surface of the broader [Everything Workbench](everything-workbench.md): generated knowledge-work files open in-place, can be reviewed in context, and keep the follow-up composer beside the artifact.

Presentation generation, local reads/writes, attachment access, preview
rendering, and external-open actions remain subject to the task's [access
profile](access-profiles.md) and normal approval/export rules. The slide viewer
is a review surface, not an additional permission grant; it cannot widen
filesystem, command-tool, network, or external-app access.

## Supported Formats

In-app preview:

- `.pptx`

Recognized PowerPoint-style artifacts with external-app and folder actions:

- `.ppt`
- `.pptm`
- `.potx`
- `.potm`
- `.ppsx`
- `.ppsm`

The shared detection and labels live in `src/shared/presentation-formats.ts`. Cards are labeled as `Presentation · PPTX`, `Presentation · PPT`, and so on.

## Artifact Surfaces

Generated presentations can appear from `file_created`, `file_modified`, `artifact_created`, task primary-output metadata, and assistant text that mentions a local presentation path such as `artifacts/output.pptx`.

The task feed renders a compact presentation card:

- orange PowerPoint-style icon
- filename
- `Presentation · <format>` metadata
- default **Open** action
- dropdown actions for external apps and **Open in folder**

For `.pptx`, default **Open** routes to the in-app right-sidebar preview. For legacy or non-previewable PowerPoint formats, default opening falls back to the external app path.

## Viewer Experience

The reusable viewer is split between:

- `src/renderer/components/PresentationArtifactViewer.tsx`
- `src/renderer/components/PresentationViewer.tsx`

Sidebar mode:

- opens in the persisted resizable artifact sidebar
- keeps the main task feed visible to the left
- includes fullscreen and close controls
- shows deck-level copy, external open, and folder actions

Fullscreen mode:

- expands the presentation viewer across the app content area
- keeps the functional follow-up composer overlay
- keeps the latest-turn or working context frame above the composer
- filters the context frame after a follow-up so only events emitted after that prompt are shown
- refreshes the active preview when a matching presentation output event is emitted

Viewer layout:

- slide thumbnails in the left rail
- previous/next navigation and a slide counter in the top toolbar
- zoom selector
- a white canvas with the active slide top-aligned and centered
- rendered slide image when available
- text fallback when rendered images are not available yet
- speaker notes below the slide

## Loading Model

Presentation preview loading is intentionally two-phase so opening a deck is fast.

Fast phase:

- parses the `.pptx` package directly
- extracts slide titles, text, and speaker notes
- reuses already-cached slide PNGs when present
- returns immediately without invoking expensive renderers

Render phase:

- renders missing slide PNGs in the background
- updates the open viewer in place when high-fidelity images are ready
- shares in-flight rendering work across sidebar/fullscreen opens
- reuses cached slide images when reopening the same deck

The preview state is exposed through `presentationPreview.renderStatus`:

- `cached`: all available slide images were loaded from cache
- `rendering`: text/notes are visible while image rendering continues
- `rendered`: the full image render finished
- `text_only`: text/notes are available but image rendering did not produce slides
- `failed`: preview extraction or rendering failed in a recoverable way

`renderMessage` can explain the current state, for example `Rendering slide previews...`.

## IPC Contract

`readFileForViewer` accepts:

```ts
{
  presentationRenderMode?: "fast" | "full";
}
```

`fast` returns text, notes, and cached images only. `full` runs the renderer pipeline and returns the enriched preview.

`FileViewerResult.data.presentationPreview` includes deck metadata, slide count, render status, and slide entries. Rendered slides prefer `imageUrl` so cached PNGs can be served as local preview media URLs instead of embedding every image as base64. `imageDataUrl` remains as a compatibility fallback.

The media URL helper is exported from `src/electron/media/index.ts`, and the CSP allows `media:` images in renderer surfaces.

## Rendering Pipeline

The preview service is `src/electron/utils/PptxPreviewService.ts`.

Render priority:

1. Codex bundled `@oai/artifact-tool` presentation renderer.
2. Local `soffice` conversion to PDF plus `pdftoppm` page rendering.
3. Text-only slide and speaker-note preview.

`PptxPreviewService` is used as a singleton from the Electron IPC layer so render cache and in-flight render dedupe are shared across preview surfaces.

The cached PNGs live under the existing PPTX preview cache. The cache manifest lets fast mode reuse already-rendered slide images without rerunning artifact-tool or LibreOffice.

## Generation Model

Both presentation generation tool names route through the shared generator:

- `generate_presentation`
- `create_presentation`

The shared generator is `src/electron/utils/document-generators/pptx-generator.ts`.

Generation behavior:

- uses Codex's bundled `@oai/artifact-tool` runtime first
- falls back to `pptxgenjs` when the bundled runtime is missing or fails
- registers the generated `.pptx` as a task artifact with the correct MIME type

The bundled `kami` skill remains available for explicit editorial slide-deck workflows when the user asks for Kami by name. General presentation generation should use the native presentation tools and Codex presentation runtime by default.

## Follow-Up Editing

Presentation artifacts do not expose direct slide-edit controls in v1. Edits happen through follow-up prompts:

1. The user opens the deck in fullscreen mode.
2. The user describes a change in the functional composer.
3. The agent updates or regenerates the `.pptx`.
4. The viewer waits until the follow-up work completes, then reloads `readFileForViewer` for the matching deck.
5. The preview shows fresh text immediately and refreshed slide images when rendering completes.

This keeps the deck review experience responsive without introducing a partial PowerPoint clone.

## Implementation Files

- `src/shared/presentation-formats.ts`
- `src/electron/utils/PptxPreviewService.ts`
- `src/electron/utils/document-generators/pptx-generator.ts`
- `src/electron/utils/codex-artifact-tool-runtime.ts`
- `src/electron/ipc/handlers.ts`
- `src/electron/preload.ts`
- `src/electron/media/media-protocol.ts`
- `src/renderer/components/PresentationArtifactCard.tsx`
- `src/renderer/components/PresentationArtifactViewer.tsx`
- `src/renderer/components/PresentationViewer.tsx`
- `src/renderer/components/InlinePresentationPreview.tsx`
- `src/renderer/styles/index.css`

## Verification

Focused tests:

```bash
npx vitest run \
  src/electron/utils/__tests__/PptxPreviewService.test.ts \
  src/renderer/components/__tests__/presentation-artifact-card.test.ts \
  src/renderer/components/__tests__/presentation-artifact-viewer.test.ts
```

Build checks:

```bash
npm run build:react
npm run build:electron
npm run type-check
```

Manual smoke checks:

- Generate a small `.pptx` deck.
- Confirm the compact presentation card appears without expanding a hidden output row.
- Click **Open** and verify the right-sidebar viewer opens.
- Confirm slide text or cached images appear immediately.
- Confirm rendered slide images replace text fallback after background rendering.
- Toggle fullscreen and verify the follow-up composer and latest-turn/working context frame remain functional.
- Submit a follow-up edit and confirm the preview refreshes after the deck is updated.
