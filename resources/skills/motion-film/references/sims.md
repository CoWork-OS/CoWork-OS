# Simulation mode

Some films are simulations, not motion graphics: hundreds of agents with their own rules, particles that collide, a 3D machine the camera flies through. Same pipeline (one HTML file, `seek(t)`, Playwright + ffmpeg), different rules. Adapted from the web-sims pipeline in [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT).

## When

- Many moving things with their own behaviour (agents, crawlers, flocks, packets on a network).
- A 3D object or machine the camera orbits, cuts away or flies through.
- Anything easier to write as canvas or three.js than as DOM layout.

Films about UI, type and timed reveals stay in the default (keynote) mode. A film can be mostly keynote with one simulation act; apply these rules to that act only.

## What changes from keynote mode

- **Lifted:** particles, glow, bloom, grain, and cuts between camera chapters (a camera that flies through the object counts as continuity).
- **Kept:** determinism, reading holds, one focal point, safe area, frame 0 as the thumbnail, one hero moment on the drop, the review loop.
- **Default format:** 4:5 at 1080×1350 CSS px, rendered at a device scale factor of 4/3 → 1440×1800, 60fps, 20–24s.

## Contract

- **Simulate once, render purely.** Anything stateful (agents, paths, collisions, steering) is simulated at load at a fixed 60 Hz step into typed arrays. `seek(t)` only reads those arrays and draws frame `t` from scratch.
- No `Math.random` inside `seek`: seed an RNG (e.g. mulberry32) at setup. No `Date`, no state carried between frames; the renderer calls `seek` at arbitrary times.
- Signal readiness only after the simulation and assets are done; the renderer waits for it before frame 0.
- three.js and fonts inlined or bundled so the file works offline.
- With a music track, pass `beats.json` (scripts/beats.py) in and snap doublings, chapter changes and the hero moment to `beats`, `downbeats` and `drop`.

## Workflow

1. Agree the idea, the hero moment and the length. Put chapters, the hero moment and camera keys in `timeline.json`.
2. Build the simulation and a `seek(t)`, then render a stills sheet at every beat before the full capture (review-loop.md).
3. Check the sheet: frame 0 already busy and beautiful, one focal point, nothing blown out by bloom, text readable on a phone, labels never covering the subject.
4. Sound: a music track, a generated bed (sound.md, `sfx/dsp.py` for longer beds), or both mixed.
5. Capture without subframe blending if per-frame cost is high (60fps of a sim already reads smoothly); otherwise use the standard 4-subframe render.

## Lessons

- Bloom eats detail: keep emissive and additive layers under ~1.0 and raise them only for the hero moment.
- One NaN pixel can black out the whole frame through bloom: clamp `pow()` bases in shaders.
- Glossy metal under a low sun gives white streaks: roughness ≥ 0.45 and `envMapIntensity` ≈ 0.5 on big surfaces.
- One hero object beats a crowd. If parts hide the subject, move them away or fade them.
- Chapters with a one-line caption each, and labels with real numbers, make a simulation read as an explanation, not eye candy.
- A camera that flies *through* the object is worth more than ten orbits.
- Invented content only (no real people, brands or domains; use `.example` domains) unless the user supplies the real thing.
