# Sound

Silent motion graphics look unfinished. Every film gets sound unless the user asks for silent.

## Sources

Pick per film, and don't mix both kinds for the same event type (all clicks downloaded, or all clicks generated):

- **Downloaded SFX and music** (Mixkit, Pexels, or the user's own): the most realistic. Position each SFX by its measured peak (techniques.md → Sound).
- **Generated with the bundled `sfx` engine:** pure Python stdlib, no samples, no licences, works offline, identical output on every run. Use it when downloads aren't possible, when the user wants nothing third-party, or when no downloaded sound fits. Ported from [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT).

A music track is still the backbone of a beat-synced film. The engine's `pad()` can stand in for one when there is no track, but say so in the brief.

## Finding the beats of a track

```bash
python3 {baseDir}/scripts/beats.py music/track.mp3 --duration 30 --start auto -o beats.json
```

It decodes with ffmpeg and finds the tempo, beat grid, downbeats, kicks, energy per bar and the drop. With `--start auto` it picks a window where the drop lands ~40% into the film, snapped to a bar; all times in `beats.json` are relative to that window, and `start` is where to cut the song. Use it instead of asking the user for BPM and drop timing, then confirm the result in the beat map. Keep `beats.json` separate from `timeline.json`, and copy the moments you build on into the timeline as named beats.

## Cue sheet (generated sound)

One Python file per film, reading the same `timeline.json` as the picture:

```python
from sfx.synth import click, pop, whoosh, chime, riser, impact

TIMELINE = "timeline.json"
OUT = "sfx.wav"
TARGET_LUFS = -14.0

def score(mix, tl):
    a1 = tl["a1"]
    mix.put(a1["title"], whoosh(0.4, 500, 2400, peak=0.45), 0.12)
    for i, t in enumerate(a1["items"]):
        mix.put(t, pop(900 + i * 150, 400), 0.3, pan=-0.4 + i * 0.3)
    mix.typing(a1["typeStart"], a1["typeEnd"], chars=24)
```

```bash
PYTHONPATH={baseDir}/scripts python3 -m sfx --list          # generators and what each is for
PYTHONPATH={baseDir}/scripts python3 -m sfx cues.py         # render → mastered sfx.wav
```

- `mix.put(t, samples, gain, pan)`: `t` always comes from `tl`, never a typed number. Offsets from a beat (`a1["exit"] + 0.05`) are fine.
- `mix.typing(start, end, chars)`: one humanized keystroke per character.
- `mix.put_stereo(t, left, right, gain)`: stereo sources such as `pad()`.
- Mastering is automatic: soft-clip and gain to `TARGET_LUFS` with the true peak kept ≤ −2 dBFS (room for AAC overshoot). A sparse mix of short hits can't reach −14 without crushing; the engine then comes out quieter and says so. Fix it with sustained sound (a pad, longer tails), not by forcing it.
- To mix with a music track, render the cue sheet, then `amix` it with the song and `loudnorm` the result as in techniques.md.

## Visual event → sound

| On screen | Generator | Notes |
|---|---|---|
| Typing | `mix.typing()` | jitter ±4–6 ms, random gain |
| Word or line reveal | `whoosh()` + `blip()` on the landing | short, airy |
| Badge, chip, callout pops in | `pop()` | raise pitch across a sequence |
| Cursor click, control snaps to a step | `click()` (+ `blip()` in key) | |
| Sketch or draw-on | `scratch()` | |
| Build-up | `riser()` | ends exactly on the hit; one per film |
| Success, arrival | `chime()` | chord in key |
| Hero transition | `whoosh()` in, `impact()` on the hit | one impact per film |
| Under everything | `pad()` with an `envelope()` | duck it under the hero transition |

Accent, don't narrate: not every motion needs a sound. Continuous motion (drift, grain, rotation) stays silent.

## Levels and space

- Hero hits: gain 0.25–0.35. Supporting sounds: 0.08–0.2. Pad: ~0.03, ducked ~65% under the hero transition.
- Pan follows on-screen position (−1 left … +1 right); sequences sweep across the stereo field.
- One key for every tonal sound (match the music's key if there is a track); pitch rises with progress and resolves on the payoff.

## Adding a generator

If a sound is missing, write it into a copy of the engine in the project folder, not into the bundled skill. A generator is a function returning a list of floats at `SR`, with what it's for in the first docstring line. Use the module-level `random` so renders stay reproducible; build airy sounds on `bandnoise()`. `sfx/dsp.py` has oscillators, filters, delays and reverb for longer beds.

## Verify

```bash
node {baseDir}/scripts/wave.mjs sfx.wav       # wave.png with beat lines + loudness
node {baseDir}/scripts/wave.mjs film.mp4      # loudness of what you'll actually deliver
```
