# Techniques & pipeline

## Determinism

Everything is a pure function of `t`. `window.seek = async (t) => { ...set every style... }`. If a value would "accumulate" (position after a drag, a counter), express it as a closed-form function of `t` instead. Any timestamp must be directly seekable in any order.

## Springs

Closed-form underdamped step response (0 → 1):

```js
function spring(t, { stiffness = 170, damping = 18, mass = 1 } = {}) {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t); // critically damped approx
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
}
```

Multiple targets: one spring per change, summed —
`value(t) = v0 + Σ (v_i − v_{i−1}) · spring(t − t_i)`. Stays pure, retargets smoothly.

## Liquid glass (iOS 26 style)

- Each glass element keeps its **own clone of the scene behind it** (don't use `backdrop-filter: url()` — Chromium misreads displacement maps there).
- Filter the clone with an SVG `feImage` displacement map: a rounded-rect signed distance field encoded into R/G.
- Run it through **three `feDisplacementMap`s at slightly different scales** (one per R/G/B channel) and recombine for chromatic edges.
- Add a rim light (thin inner highlight following the shape's edge, brighter on the light-facing side).
- Glass letters: draw each glyph to a canvas, compute a distance field per glyph, derive the displacement map, mask and highlights from it.

## Goo (liquid merge / pinch-off / droplets)

Blur the shapes, apply an alpha threshold (`feColorMatrix` with a steep alpha ramp), then **composite the sharp source on top** so glass/content stays crisp inside the goo silhouette.

## Iris

6 blades around a hexagonal aperture. Each blade polygon = its two aperture vertices, both edge extensions out past the frame, and the **short** arc between them on the outer circle. Rotate/scale the aperture with a spring to close/open.

## Wordmark squeeze (accordion into the period)

Move every letter toward the dot by the same factor and adjust its drawn width to match: narrow the `wdth` variable axis first, then scale the remainder, so letters stay in contact. Reverse it to spring the letters back out.

## Floods & fills

A shape that floods the frame must extend beyond the corners (radius ≥ half-diagonal) and take ~0.3s; otherwise half the screen changes in a single frame. Hold black for one beat max, then shrink into the next scene.

## Masks & text

- Text rises from a mask line: clip a container, translate the text from below the clip edge.
- Text swapping inside a morphing shape needs its own mask, separate from the shape's.
- `visibility: visible` on a child shows through a hidden parent — use `inherit`.

## Camera & cursor

Wrap the scene in a camera transform (translate + scale) driven by springs toward each moment's bounding box. Draw the cursor inside the camera so it scales with zoom; animate clicks as a quick scale-down/up plus a ripple; long-press = held scale-down.

## Footage

```bash
ffmpeg -i wall.mp4 -c:v libx264 -g 1 -crf 16 -an wall_intra.mp4
```

Load via `fetch → blob → URL.createObjectURL` (python `http.server` can't range-seek). In `seek(t)`: set `video.currentTime`, then `await new Promise(r => video.addEventListener('seeked', r, { once: true }))` before drawing.

## Assets readiness

Before frame 0: `await document.fonts.ready` and `await img.decode()` for every image.

## Sound

- Every event gets a downloaded SFX (Mixkit); never synthesized.
- Measure each SFX's peak offset (e.g. numpy over decoded samples) and place it so the peak lands on the event: `start = event_t − peak_offset`.
- Start the song on a downbeat; align the drop to the big reveal, the breakdown to the quiet moment.
- Mix with `adelay` + `amix`, then `loudnorm=I=-14:TP=-1:LRA=11`.

## Render

Render 4 subframes per output frame (240 frames/s for 60fps output) by calling `seek((frame*4 + sub) / 240)` and screenshotting the page at 1:1, then blend:

```bash
ffmpeg -framerate 240 -i frames/%06d.png \
  -vf "tmix=frames=4,select='eq(mod(n\,4)\,3)',setpts=N/(60*TB)" \
  -r 60 -c:v libx264 -pix_fmt yuv420p -crf 16 -movflags +faststart video.mp4
ffmpeg -i video.mp4 -i mix.wav -c:v copy -c:a aac -b:a 256k -shortest final.mp4
```

## QA

- Extract one frame per beat and compare against the beat map.
- Pops: compute mean abs difference between consecutive frames; flag frame i where `d[i] > 3 × mean(d[i−1], d[i+1])`. Inspect and fix each.
