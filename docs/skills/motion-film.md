# Motion Film Skill

`motion-film` is a bundled CoWork OS skill for designing and rendering a motion-design film entirely in code: one HTML file whose every pixel is a pure function of time, rendered frame-by-frame to MP4 with Playwright and ffmpeg.

It is designed for:

- product launch films and keynote-style reveals
- feature announcements and product promos
- animated explainers for apps, developer tools, data, or physical products
- brand and event openers
- looping social clips (1:1, 9:16, 4:5)

It is not the right tool for:

- building a reusable editor app — use [`motion-editor`](motion-editor.md)
- math, equation, or algorithm explainers — use [`manim-video`](manim-video.md)
- authoring or editing a HyperFrames composition — use `hyperframes`
- trimming or editing existing live-action footage
- model-generated video clips — use the built-in video generation providers

## How To Use It

`motion-film` ships with the app and is available globally in every workspace — there is nothing to install from the Skill Store. Ask in natural language or call it by name:

```text
Make a 30-second keynote-style launch video for our app.
```

```text
Use the motion-film skill to create a 9:16 social loop announcing our new sync feature. Brand colours are #0B0B0F and #F5F1EA, music at 120 BPM.
```

```text
/motion-film
```

Good requests include:

- what the project is, who it's for, and the one thing the viewer should remember
- the kind of film (launch, feature announcement, explainer, brand opener, social loop)
- format: aspect ratio, length, whether it should loop
- brand: wordmark, colours, fonts
- assets: screenshots, photos, logos, footage you supply
- music: a royalty-free track, its BPM, and where the drop and breakdown are — or "silent"
- a style reference (Apple keynote, Linear, Stripe, editorial, playful)

If you leave things out, the skill asks once and offers defaults you can accept with "defaults": 1:1 at 1440x1440, ~25–30s, 60fps, looping, a warm off-white canvas with black UI, Apple-keynote style.

## Parameters

| Name             | Type   | Description                                                                 |
| ---------------- | ------ | --------------------------------------------------------------------------- |
| `project_brief`  | string | What the project is, the audience, and the one thing to remember            |
| `film_kind`      | select | `auto`, `launch`, `feature-announcement`, `explainer`, `brand-opener`, `social-loop` |
| `aspect`         | select | `1:1`, `16:9`, `9:16`, `4:5`                                                |
| `length_seconds` | string | Approximate target length                                                   |
| `output_dir`     | string | Project folder; defaults to `motion-film-project` in the workspace          |

## Workflow

1. **Brief** — gather project, format, brand, assets, music, and style.
2. **Design (approval gate)** — the story is written as 4–6 acts where each act ends in a shape that becomes the start of the next (a dot becomes a pill, a window, a card, a circle that floods the frame). A beat map table lists beat, time, trigger, transform, and SFX. 3–5 stills are rendered from a stub `seek(t)`. **The skill stops here until you approve or request changes.**
3. **Build** — one HTML file at the target resolution. All styles are computed inside `async seek(t)`; springs are closed-form, so any timestamp is seekable in any order.
4. **Sound** — a downloaded SFX per event positioned by its measured peak, the song starting on a downbeat, loudness normalised to -14 LUFS.
5. **Render & QA** — Playwright renders 4 subframes per output frame and ffmpeg `tmix` blends them into 60fps motion blur. One frame per beat is checked against the beat map, and single-frame pops (frame-difference spikes 3x their neighbours) are fixed and re-rendered before audio is muxed.

### Style rules

- One continuous take: objects transform instead of cutting.
- When there is UI, a cursor motivates every change with real clicks, drags, and long-presses; the camera zooms Screen Studio–style.
- Banned: crossfades, blur-ins, brightness "developing", 3D flips, particles, glows, holds longer than 1s.
- Assets are only what you supply or what is free for commercial use; the skill does not invent product UI you didn't ask for.

## Outputs

In the project folder: the time-seeked `film.html`, the render script, the approval stills, and the final MP4.

Run artifacts under the task artifact directory:

- `beat-map.md` — acts, beats, transforms, SFX, assets and their licences
- `render-report.md` — render command, per-beat check, pop scan results

## Dependencies

- Node 20+
- Playwright with Chromium (`npx playwright install chromium`)
- `ffmpeg` in `PATH`

Without ffmpeg or Playwright the skill can still produce the brief, beat map, and HTML film, and reports the exact missing dependency instead of rendering.

## Related Skills

- [`motion-editor`](motion-editor.md) — build a reusable editor for making films like these by hand
- [`manim-video`](manim-video.md) — deterministic technical/math animation
- `video-frames` — extract stills or clips from an existing video

## Where The Source Lives

- `resources/skills/motion-film.json` — runtime manifest and routing
- `resources/skills/motion-film/SKILL.md` — full authoring guide
- `resources/skills/motion-film/references/techniques.md` — determinism, springs, liquid glass, goo, iris, floods, masks, footage, render pipeline
- `resources/skills/motion-film/references/example-launch-film.md` — worked 54-beat launch film used as the quality bar

When editing the skill, run `npm run skills:check`.
