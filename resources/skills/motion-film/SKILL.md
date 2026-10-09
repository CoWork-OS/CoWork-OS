---
name: motion-film
description: "Design and render a motion-design film entirely in code — launch videos, product promos, feature announcements, explainers, brand/event openers, social loops. One time-seeked HTML file rendered frame-by-frame with Playwright + ffmpeg; one continuous take, beat-synced to music."
version: "1.1.0"
license: MIT
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Motion Film

Make a polished motion-design film from code: a single HTML file whose every pixel is a pure function of time, rendered to MP4 with Playwright and ffmpeg. Works for any project — the craft is fixed, the story is designed per project.

Helper scripts are in `scripts/` (`{baseDir}` in the references means this skill's folder): `sheet.mjs` (contact sheets), `wave.mjs` (waveform + loudness), `beats.py` (tempo, downbeats, drop) and the `sfx` sound engine. The review loop, sound engine, simulation mode and taste rules are adapted from [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT, `scripts/LICENSE-claude-motion`).

- Techniques and pipeline: [references/techniques.md](references/techniques.md) — read before building.
- Motion rules with numbers (easing, springs, stagger, reading holds, type, color): [references/taste.md](references/taste.md) — read before designing.
- Visual self-review with contact sheets: [references/review-loop.md](references/review-loop.md) — mandatory before calling a film done.
- Sound sources, beat detection and the bundled generator engine: [references/sound.md](references/sound.md).
- Simulation mode (agents, particles, 3D fly-throughs): [references/sims.md](references/sims.md) — only when the idea is a simulation.
- Worked example (Apple-keynote launch film, 54 beats): [references/example-launch-film.md](references/example-launch-film.md) — use as the quality and density bar, not as a script.

## 1. Brief

Ask for what's missing; offer the default in brackets so the user can just say "defaults".

- **Project:** what it is, who it's for, the one thing the viewer should remember.
- **Kind of film:** launch, feature announcement, explainer, brand opener, social loop, other.
- **Format:** aspect [1:1, 1440x1440] (16:9 1920x1080 / 9:16 1080x1920 / 4:5 1440x1800), length [~25–30s], fps [60], loop [last frame = first frame].
- **Brand:** name/wordmark (a one-word verb works best), colors, fonts [warm off-white canvas, black UI, Archivo wdth 125 / 800 for the wordmark, Geist for UI].
- **Assets:** screenshots, photos (9–12 high-res is ideal), logos, footage. Use only what the user supplies or what is free for commercial use (Pexels footage, Mixkit SFX/music); never invent fake product UI the user didn't ask for.
- **Music:** a royalty-free track [~120 BPM, Mixkit]. Find its tempo, downbeats and drop with `scripts/beats.py` instead of asking; confirm them in the beat map. Or generated sound only / silent.
- **Style:** a reference (Apple keynote, Linear, Stripe, editorial, playful…) [Apple keynote, iOS 26 liquid glass]. If the idea is a simulation (agents, particles, a 3D machine), use simulation mode from `references/sims.md`.

## 2. Design (get approval before building)

1. **Story as a chain of transforms.** Write 4–6 acts. Each act ends in a shape that *becomes* the start of the next (a dot → a pill → a window → a card → a circle that floods the frame…). Pick the transforms from the project's own vocabulary:
   - App / SaaS → real UI flows driven by a cursor: clicks, drags, long-presses, scrolls, typing.
   - Developer tool → terminal/code typing, diffs, panels pushing in, logs becoming charts.
   - Physical product → photos, cutout shapes, product details, real-world footage.
   - Data / metrics → bars drawing across, numbers counting, charts morphing into each other.
   - Brand / event → typography-led: wordmark mechanics, letters springing, masks.
2. **Beat map.** Write every beat into `timeline.json` (techniques.md → Timeline) and the same as a table in `beat-map.md`: beat # · time · cursor action / trigger · what transforms · SFX. Something happens on every beat. Land the biggest reveal on the drop, put the quiet/real-world moment in the breakdown, bring the brand back on the returning beat. Budget reading holds (taste.md → Timing) for every line of text before fixing the length.
3. **Stills.** Render 3–5 stills at key moments (one per act) from a stub `seek(t)` and show them with the beat map. Wait for approval or changes.

## 3. Rules

- One continuous take. Each scene grows out of the last: objects transform; no cuts.
- Motion vocabulary: text rises from a mask line, icons spring up from zero, bars draw across, pages push forward, a solid shape fills the frame then shrinks into the next scene.
- Motivate changes: when there is UI, a cursor triggers every change with real clicks, drags and long-presses. Otherwise, the beat motivates it.
- Camera: zoom Screen Studio–style so each moment fills the frame; scale the cursor with the camera.
- **Reading holds:** every readable state holds after it settles: ≥ 1s for a short phrase, plus ~0.25s per word beyond three, ≥ 2s for the final line. Text never moves while it is meant to be read. Between holds, something is always in motion.
- Follow the numbers in `references/taste.md` (easing, springs, stagger, exits at about half an entrance, one accent color, one hero moment, safe area, frame 0 as the thumbnail).
- **Banned:** crossfades, blur-ins, brightness "developing", 3D flips, empty frames between scenes, anything that feels like a template. Particles and glows are banned too, except in simulation mode (`references/sims.md`).
- If the film loops, the last frame equals the first.

## 4. Build

1. One HTML file at the target resolution. Every time comes from `timeline.json` (`window.TL`); no start times hardcoded in scene code. Every style is computed from `t` inside `async seek(t)`: no CSS transitions/animations, timers, `Date.now()`, unseeded randomness, or state carried between frames.
2. Springs as closed-form step responses; one spring per target change so values stay pure functions of time.
3. Use the techniques in `references/techniques.md` (liquid glass, goo, iris, wordmark squeeze, floods, masks, footage) as the story needs them.
4. **Sound** (`references/sound.md`): downloaded SFX positioned by their measured peak, or generated with the bundled `sfx` engine from a cue sheet that reads `timeline.json`. Don't mix both kinds for the same event type. Start the song on a downbeat. Final mix at -14 LUFS, true peak ≤ -1 dBFS.

## 5. Render & QA

1. Playwright renders 4 subframes per output frame; ffmpeg `tmix` blends them to 60fps motion blur.
2. Run the review loop (`references/review-loop.md`) on half-resolution drafts: contact sheets at every beat with `scripts/sheet.mjs`, the checklist, fix, repeat until a full pass is clean.
3. On the final render: sheets again, then scan for single-frame pops (frame-difference spikes 3x higher than their neighbours). Fix and re-render.
4. Mux audio, check it with `scripts/wave.mjs` (hits on beat lines, -14 LUFS ±1), deliver the MP4, and show the user a few frames and the sheet that proves each fix.

## Routing

- Use when: the user asks for a launch video, product promo, feature announcement, motion graphics, animated explainer, brand/event opener, social loop, keynote-style film, a simulation-style video (agents, particles, a 3D fly-through), or "make a video with code".
- Do not use when: the user wants a reusable editor app (use `motion-editor`), a Manim math/algorithm explainer (use `manim-video`), a HyperFrames composition (use `hyperframes`), editing of existing live-action footage, or a model-generated video clip.
- Outputs: a time-seeked `film.html`, `timeline.json`, a render script, a beat map, approval stills, contact sheets, an optional cue sheet, and a muxed MP4 in the project folder.
- Success criteria: stills approved before the build; every frame a pure function of `t`; every time read from `timeline.json`; a clean review-loop pass on contact sheets; reading holds respected; no single-frame pops; MP4 delivered with audio at -14 LUFS (or silent if requested).

## Trigger Examples

### Positive

- Make a 30-second launch video for our app, keynote style.
- Create a motion graphics promo for this feature announcement.
- Make a video with code for our product launch, 9:16 for social.
- Use the motion-film skill for this request.

### Negative

- Build me a reusable keyframe timeline tool for my team.
- Explain the chain rule with an equation derivation.
- Cut the silences out of this podcast episode.
- Grab a still image at 00:12 from this clip.

## Parameters

| Name           | Type   | Required | Description                                                         |
| -------------- | ------ | -------- | ------------------------------------------------------------------- |
| project_brief  | string | No       | What the project is, who it's for, the one thing to remember        |
| film_kind      | select | No       | auto, launch, feature-announcement, explainer, brand-opener, social-loop |
| aspect         | select | No       | 1:1, 16:9, 9:16, 4:5                                                |
| length_seconds | string | No       | Target length in seconds (default ~25–30)                           |
| output_dir     | string | No       | Project folder (default `motion-film-project` in the workspace)     |

## Runtime Prompt

- Runtime prompt is defined directly in `../motion-film.json`.
