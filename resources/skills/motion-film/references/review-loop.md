# Review loop

You can't watch the film, but you can look at frames. Never report a film as done without looking at contact sheets of the current render. Adapted from [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT).

Scripts live in `{baseDir}/scripts/`; run them from the film project folder so `timeline.json` resolves.

## Loop

1. **Draft render:** half resolution, 1 subframe per frame (no `tmix`), `-crf 28` → `draft.mp4`. Fast enough to repeat many times.
2. **Contact sheets:** `node {baseDir}/scripts/sheet.mjs --video draft.mp4` takes one frame per timeline beat, 0.3s after it so motion has settled, tiles them 4×2 into `sheets/beats-N.png`, and labels each tile with its timestamp.
3. Open every sheet image and go through the checklist below.
4. Zoom in on anything suspicious:
   - `node {baseDir}/scripts/sheet.mjs --video draft.mp4 --from 3 --to 5 --every 0.2` scrubs a transition,
   - `node {baseDir}/scripts/sheet.mjs --video draft.mp4 3.7 3.75 3.8` grabs exact moments,
   - `seek(t)` plus a full-resolution screenshot for one frame you need to inspect closely.
5. Fix, then go back to step 1. Stop when a full pass finds nothing.
6. **Final:** full render (4 subframes + `tmix`), then sheets of the final MP4, the pop scan (techniques.md → QA), and `node {baseDir}/scripts/wave.mjs film.mp4` for sound.

## Checklist

Composition
- One focal point per frame. If two things compete, one of them waits.
- Nothing collides or overlaps unintentionally, especially mid-transition where an exiting and an entering element share space.
- Safe area: nothing important within ~60px of an edge.
- Frame 0 is a real image, not black or empty (it is the thumbnail).
- If the film loops, the last frame matches frame 0.

Type
- Nothing clipped by a mask, container or the frame when it shouldn't be.
- The key message reads when the tile is shrunk to phone width (~360px).
- Text isn't moving while it is meant to be read.

Timing
- Each readable state holds long enough (taste.md → Timing). If a tile mid-hold shows text still animating, the hold is too short.
- Scenes overlap instead of cutting to empty frames.
- Exits are faster than entrances.
- The hero moment lands on the drop.

Consistency
- Only palette colors; the accent marks the point of the frame.
- The same element looks the same in every scene it appears in.
- Keynote style: no glow, particles or blur-ins crept in.

Sound (after `wave.mjs`)
- Transients sit on (or a hair after) the coral beat lines in `wave.png`. A hit between lines means a hardcoded time or a stale WAV.
- −14 LUFS ±1, true peak ≤ −1 dBFS on the final MP4.

## Report

In `render-report.md` and the final message, say what you checked, what you fixed, and which sheet shows it. Don't claim a fix you haven't re-rendered and looked at.
