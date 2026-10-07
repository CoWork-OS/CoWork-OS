---
name: motion-editor
description: "Build a local, offline motion-design editor app (After Effects / Screen Studio-lite) with scenes, layers, keyframes, spring easing, presets, stagger, a cursor layer, timeline, undo/redo, save/open, and deterministic MP4 export via Playwright + ffmpeg. The deliverable is the editor itself, not a video."
version: "1.0.0"
license: MIT
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Motion Editor

## Before starting

Confirm the target folder and the user's OS (adapt shortcuts: Ctrl on Windows/Linux, Cmd on macOS). Phases span many steps: keep a `PROGRESS.md` in the project noting what's built and which verifications passed. If an essential ambiguity remains, ask the user — the requirements below take priority over any outside source.

<goal>
Build a local motion-design editor app. The deliverable is the EDITOR ITSELF, not a video.
Do NOT invent a video concept, create demo content, or render anything automatically.
On first launch, open an empty project. Rendering happens only when the user clicks Export.
</goal>

<environment>
- Windows, macOS or Linux; Node 20+, ffmpeg available in PATH.
- Stack: Vite + React + TypeScript frontend, small local Node (Express) server for filesystem access and render jobs. Zustand for state, zod for project schema validation.
- No AI/API calls at runtime. Editing, playback, undo/redo, saving must work fully offline.
- Run: `npm install && npm run dev`. CLI render: `npm run render -- <projectFolder> <out.mp4>`.
- If you deviate from this stack, justify it in README.
</environment>

<architecture>
- Single source of truth: project.json (schema-validated).
- One pure function `renderFrame(project, timeSec, ctx, scale)` draws a frame on Canvas 2D. Used by BOTH preview and export.
- Output depends only on (project, time): no Date.now(), no unseeded Math.random(), no CSS animations, no rAF-accumulated state. Any timestamp must be directly seekable.
- Preview renders scaled to viewport (devicePixelRatio-aware). Export renders at full project resolution.
- Text and vector graphics must stay crisp at 4K (render at target resolution, never upscale a bitmap of the canvas).
</architecture>

<data_model>
- Project: settings {durationSec=15, aspect=16:9, width=3840, height=2160, fps=30, background}, scenes[], assets[] {id, originalName, relativePath, type, hash}.
- Scene: id, name, start, duration, layers[] (array order = z-order).
- Layer: id, type (text | image | shape | cursor), name, visible, locked, start, duration (relative to scene), anchor, x, y, scale, rotation, opacity, type-specific props.
  Text props: content, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, align, color.
- Keyframes per property: [{time, value, easing}].
- Easing: linear, ease-in/out/in-out, custom cubic-bezier, spring {stiffness, damping, mass}.
- Animation presets (slide/fade/scale in & out with direction, distance, delay, duration, easing) GENERATE regular editable keyframes. Re-applying a preset replaces them and is undoable.
- Stagger: applied to a multi-selection; params: order (forward / reverse / seeded random), interval. Offsets layer start times.
</data_model>

<phase_1_core>
Build and verify ALL of this before starting Phase 2:
1. Project settings: duration, aspect ratio (16:9, 9:16, 1:1, 4:5, custom), resolution, fps. Changing them never deletes layers.
2. Asset import (button + drag&drop): PNG, JPG, WebP, SVG, fonts (TTF/OTF/WOFF2). Originals copied byte-for-byte, never modified.
3. Add text and shapes. Scenes: create, duplicate, rename, reorder, delete.
4. Layers panel: reorder, show/hide, lock, rename, duplicate, delete.
5. Preview: click to select, drag to move, handles to scale/rotate, Shift to constrain. Selection stays synced across preview, timeline, and properties panel.
6. Timeline: scene blocks with draggable boundaries, layer bars with draggable start/end, keyframe diamonds draggable in time, playhead scrubbing, zoom.
7. Properties panel: transform, opacity, typography, alignment, spacing, color; per-property keyframe toggle at playhead; easing picker with live curve preview. Plain-language labels; tooltip on every non-obvious control explaining what it changes.
8. Playback: play/pause, replay, loop, Space, frame step with ←/→, time + frame counter. Any parameter change updates the preview instantly.
9. Undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) for every edit; one drag = one history step.
10. Save/Open: project folder `<name>.motion/` with project.json + assets/. Unsaved-changes dot in title + warning on close. Missing assets show a placeholder with a "Relink" button. Also export/import the whole project as a single .zip.
</phase_1_core>

<phase_2_advanced>
- Spring easing UI, stagger UI, animation presets UI.
- Cursor layer: path points draggable in preview, target positions, editable click times with click ripple, path smoothing.
</phase_2_advanced>

<export>
- "Export MP4" button → server launches headless Chromium (Playwright) on a render-only page with NO editor UI, calls renderFrame for every frame, pipes raw frames into ffmpeg: libx264, yuv420p, CRF 16, -movflags +faststart.
- Wait for document.fonts.ready and all images decoded before frame 0.
- Progress bar + cancel button. Same pipeline available via CLI.
- If ffmpeg is not found, show a clear error with the install step and the exact CLI command to render the saved project.
</export>

<out_of_scope_v1>
Audio, video clips as layers, scene transitions, blur/effects, AI generation, cloud sync. Mark them as "Not available" in UI if referenced anywhere; no dead buttons.
</out_of_scope_v1>

<verification>
Actually run these, do not just claim them:
- Unit tests: interpolation, every easing type, determinism (render the same t twice → identical pixels).
- Playwright e2e test: new project → import fixture image → place it → add keyframes on x and opacity → move second keyframe in time → scrub to midpoint and screenshot → undo (value reverts) → redo → save → reload app → open project → deep-compare project.json (scenes, layers, keyframes, settings, asset refs) and confirm assets load.
- Export test: 3-second 1080p project → MP4 → extract first, middle, last frames with ffmpeg → compare to renderFrame output at the same timestamps (pixel diff below threshold).
</verification>

<deliverable>
Working app + source + README with: install, run, editing basics, save/open, export (UI and CLI).
README must contain "Works (tested)", "Not implemented", "Known limitations". List as working ONLY what passed the tests above.
</deliverable>

## Related

The spring formula and render/QA pipeline in `references/techniques.md` (shared with the `motion-film` skill) apply here too (closed-form springs keep `renderFrame` pure; subframe blending can be added to export later).

## Routing

- Use when: the user asks to build a motion editor, animation editor, keyframe timeline app, or a tool for making motion-design videos.
- Do not use when: the user wants a single finished film (use `motion-film`), a Manim explainer (use `manim-video`), or edits to existing video footage.
- Outputs: a working Vite + React + Express editor app with tests, a `PROGRESS.md`, and a README with "Works (tested)", "Not implemented", and "Known limitations".
- Success criteria: Phase 1 verified before Phase 2; unit, e2e and export tests actually run and pass; README lists as working only what passed.

## Trigger Examples

### Positive

- Build me a motion-design editor app with a keyframe timeline.
- Create an After Effects-lite animation editor that exports MP4.
- Make a local Screen Studio-style tool for making motion videos.
- Use the motion-editor skill for this request.

### Negative

- Render our launch film for Friday's announcement.
- Explain binary search trees with an equation-style walkthrough.
- Cut the silences out of this podcast episode.
- Write release notes for the new version.

## Parameters

| Name       | Type   | Required | Description                                                      |
| ---------- | ------ | -------- | ---------------------------------------------------------------- |
| output_dir | string | No       | App folder (default `motion-editor` in the workspace)            |
| phase      | select | No       | auto, phase-1-core, phase-2-advanced, export                     |

## Runtime Prompt

- Runtime prompt is defined directly in `../motion-editor.json`.
