# Taste: motion rules with numbers

Defaults you deviate from on purpose, not by accident. Adapted from [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT), where every number came from a shipped piece.

## Easing

| Curve | Use |
|---|---|
| `easeOut = bezier(0.16, 1, 0.3, 1)` | entrances, reveals, anything arriving |
| `easeIn = bezier(0.6, 0, 0.9, 0.35)` | exits: leave fast, don't linger |
| `easeInOut = bezier(0.65, 0, 0.35, 1)` | moves between two states (flip, dock, morph) |
| `bezier(0.55, 0, 0.2, 1.12)` | a value that overshoots and lands (a slider climbing to a level) |

Linear only for continuous motion: rotation, drift, ticking hands, a progress bar that is literally time.

```js
// CSS-style cubic-bezier as a pure function of x in [0, 1].
function bezier(x1, y1, x2, y2) {
  const f = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 30; i++) { t = (lo + hi) / 2; if (f(x1, x2, t) < x) lo = t; else hi = t; }
    return f(y1, y2, t);
  };
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
// Tween progress between two beats.
const prog = (t, t0, t1, ease = easeOut) => ease(clamp01((t - t0) / (t1 - t0)));
// Derive one animation from another value instead of giving it its own clock.
const band = (x, a, b) => clamp01((x - a) / (b - a));
```

## Springs (closed-form `spring()` from techniques.md)

| Feel | damping / stiffness / mass | For |
|---|---|---|
| default settle | 14 / 140 / 0.8 | general UI entering |
| heavy, calm | 15–20 / 140–240 / 0.6–1 | big panels, camera-sized moves |
| knob / notch | 12 / 190 / 0.75 | a control snapping to a step |
| pop | 9–11 / 200–230 / 0.7 | callouts, badges, success dots |
| elastic accent | 8 / 200 / 1 | one hero moment per film, not more |

Springs for things that feel physical (UI, objects, the cursor's targets). Bezier tweens for type and camera-like moves.

## Timing

- **Stagger:** words ~0.09s apart, list items and chips ~0.2–0.25s, rings and dots ~0.06s.
- **Word reveal** ≈ 0.8s through a mask (slide up out of a clip edge, slight tilt).
- **Exits are about half an entrance:** 0.35–0.55s against 0.7–1.25s, with `easeIn`.
- **Overlap scenes.** The next scene starts drawing before the previous one has fully left. A gap reads as loading.
- **Typing** ≈ 0.035s per character; an idle caret blinks at ~2.4 Hz.
- **Reading holds.** Every readable state holds after it settles: ≥ 1s for a short phrase, plus ~0.25s per word beyond three, and ≥ 2s for the final line or hook. Text never moves while it is meant to be read. When in doubt, hold longer and animate less: a 15s cut that flashes its text is worse than a 22s cut that lands it.

## Typography

- At most three families: a display face, a UI sans, a mono for labels, prompts and numbers.
- Display type is big (≈ 13% of the canvas width, e.g. 138px at 1080) with tight tracking (`-0.02em`) and `line-height: 1`.
- One accent per line: a single word in the accent color (or italic) carries the point.
- Mono labels: uppercase, `letter-spacing: 0.2–0.24em`, muted. They are decoration; anything the viewer must read goes big.
- **Phone test:** shrink a frame to 360px wide (a social feed). The key message must still read.

## Color

- Palette tokens defined once at the top of `film.html`; no new hex values inside scene code.
- One accent color, and it means something: the thing that changed, the answer, the winner. If everything is accent, nothing is.
- Drive light from state, not time: brightness or emphasis follows what the story is saying.

## Texture

- Keynote style (the default) stays clean: flat fills, real shadows, glass. No grain, glow or particles.
- Editorial, playful or sketchy styles may add texture: film grain (opacity ≈ 0.09, reseeded every other frame from a seeded RNG), a vignette, a dot grid drifting a few px/s, hand-drawn line boil that fades out as fidelity rises.
- Glow, bloom and particles belong to simulation films only (see `sims.md`).
- Nothing is dead-still: idle elements breathe (a ticking clock, a blinking caret, a slow drift).

## Continuity

- Persistent objects over cuts: one element travels through scenes and changes role.
- Every transition is motivated by an object on screen or a cursor action. No generic wipes.
- Use velocity: derive trails or squash from `value(t) − value(t − 1/fps)`.
- One hero moment per film. Build to it and land it on the drop; don't spend it early.

## Anti-patterns

- Everything entering at once, or everything with the same duration.
- Linear easing on anything that starts or stops.
- Text moving while it should be read.
- More than one focal point per frame.
- Important content within ~60px of the frame edge (safe area) unless it is intentionally cropped.
- An empty or black frame 0: feeds autoplay muted and frame 0 is the thumbnail.
