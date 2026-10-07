# Motion Editor Skill

`motion-editor` is a bundled CoWork OS skill for building a local, offline motion-design editor app — an After Effects / Screen Studio-lite with scenes, layers, keyframes, spring easing, presets, stagger, a cursor layer, a timeline, undo/redo, save/open, and deterministic MP4 export.

**The deliverable is the editor itself, not a video.** The skill does not invent a video concept, create demo content, or render anything automatically.

It is designed for:

- building a keyframe/timeline animation tool you or your team can reuse
- an offline, no-API alternative to commercial motion tools for product videos
- a starting point you can extend with your own layer types or export targets

It is not the right tool for:

- producing a single finished film or promo — use [`motion-film`](motion-film.md)
- math or algorithm explainers — use [`manim-video`](manim-video.md)
- editing existing video footage

## How To Use It

`motion-editor` ships with the app and is available globally in every workspace — there is nothing to install. Ask in natural language or call it by name:

```text
Build me a motion-design editor app with a keyframe timeline and MP4 export.
```

```text
Use the motion-editor skill to build the editor in ./tools/motion-editor. I'm on macOS.
```

```text
/motion-editor
```

The skill confirms the target folder and your OS (to use Cmd vs Ctrl shortcuts), then works phase by phase. It keeps a `PROGRESS.md` in the app folder, so a long build can be resumed in a later task with "continue the motion editor".

## Parameters

| Name         | Type   | Description                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| `output_dir` | string | App folder; defaults to `motion-editor` in the workspace                     |
| `phase`      | select | `auto`, `phase-1-core`, `phase-2-advanced`, `export` — focus area for this run |

## What Gets Built

**Stack:** Vite + React + TypeScript, Zustand, zod, and a small Express server for filesystem access and render jobs. No AI or network calls at runtime.

**Architecture:** `project.json` is the single source of truth. One pure function, `renderFrame(project, timeSec, ctx, scale)`, draws every frame on Canvas 2D and is shared by preview and export, so the preview is exactly what gets exported.

**Phase 1 — core** (fully verified before Phase 2 starts):

- project settings (duration, aspect, resolution, fps)
- asset import (PNG, JPG, WebP, SVG, TTF/OTF/WOFF2), originals copied byte-for-byte
- text and shape layers; scenes (create, duplicate, rename, reorder, delete)
- layers panel, direct manipulation in the preview, synced selection
- timeline with scene blocks, layer bars, draggable keyframes, scrubbing, zoom
- properties panel with per-property keyframes and an easing picker with live curve preview
- playback, frame stepping, undo/redo (one drag = one step)
- save/open as a `<name>.motion/` folder, missing-asset relink, `.zip` export/import

**Phase 2 — advanced:** spring easing, stagger, and animation presets UIs; a cursor layer with editable path, click times, and click ripples.

**Export:** Playwright launches headless Chromium on a render-only page and pipes frames to ffmpeg (libx264, yuv420p, CRF 16, faststart). Progress bar, cancel, and the same pipeline from the CLI.

**Out of scope for v1:** audio, video layers, scene transitions, blur/effects, AI generation, cloud sync — shown as "Not available" rather than dead buttons.

## Verification

The skill must actually run, not just claim:

- unit tests for interpolation, every easing type, and determinism (same `t` → identical pixels)
- a Playwright end-to-end test: new project → import → keyframes → scrub → undo/redo → save → reload → deep-compare `project.json`
- an export test: a 3-second 1080p project rendered to MP4, with first/middle/last frames compared against `renderFrame`

The app's README must contain "Works (tested)", "Not implemented", and "Known limitations", and lists as working only what passed.

## Running The Result

```bash
npm install && npm run dev
```

```bash
npm run render -- <projectFolder> <out.mp4>
```

Requires Node 20+ and `ffmpeg` in `PATH`. If ffmpeg is missing, the app shows the install step and the exact CLI command instead of failing silently.

## Related Skills

- [`motion-film`](motion-film.md) — render a single film directly in code; shares the spring formula and render/QA pipeline
- [`manim-video`](manim-video.md) — deterministic technical/math animation

## Where The Source Lives

- `resources/skills/motion-editor.json` — runtime manifest and routing
- `resources/skills/motion-editor/SKILL.md` — the binding build spec
- `resources/skills/motion-editor/references/techniques.md` — closed-form springs and render pipeline (kept in sync with `motion-film`)

When editing the skill, run `npm run skills:check`.
