---
name: novelist
description: Create chaptered long-form fiction with worldbuilding, outlining, drafting, revision, and optional packaging when the user asks for a novel or novella.
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Novelist

## Goal
- Produce a complete long-form fiction pipeline with minimal back-and-forth.
- Default to doing the work, not repeatedly asking for permission between phases.
- Leave a durable workspace trail that can be resumed cleanly.

## Inputs
- Required: `seed`
- Optional with defaults: `genre`, `target_words`, `chapter_count`, `packaging`, `canon_mode`

If the user invoked `/novelist` without optional parameters, use the defaults and continue.
If `seed` is missing, ask only for the seed and pause.

## Artifact Root
- Write everything under `artifacts/skills/novelist/`

Expected files:
- `brief.md`
- `world.md`
- `characters.md`
- `outline.md`
- `voice.md`
- `canon.md`
- `progress.json`
- `chapters/chapter-XX-title.md`
- `revision-notes.md`
- `manuscript_complete.md`
- `manifest.md`
- Optional packaged outputs such as `.epub` and `.pdf`

## Operating Mode
- Resume if artifacts already exist.
- Do not restart completed phases unless the user explicitly asks for a rewrite.
- Do not ask for chapter-by-chapter approval.
- Ask at most one extra question only when a single missing decision would materially change the manuscript.

## Workflow
1. Create or refresh `brief.md`.
   - Capture premise, protagonist, stakes, setting, tone, target length, and packaging plan.
   - If the request references an existing franchise, mark whether this is `fanfiction` or `inspired-by`.

2. Create prewriting artifacts.
   - `world.md`: setting, factions, technology/magic rules, political pressures.
   - `characters.md`: core cast, motives, conflicts, arcs.
   - `voice.md`: prose rules, pacing, dialogue texture, taboo phrasing to avoid.
   - `canon.md`: continuity constraints, timeline anchors, terminology.
   - `outline.md`: chapter-by-chapter plan with purpose and cliffhangers.

3. Draft the manuscript.
   - Write full chapter files in order.
   - Keep chapter titles stable once created.
   - Update `progress.json` with chapter count, estimated word count, and current phase.
   - If a chapter already exists, preserve it unless a later revision explicitly requires edits.

4. Assemble and revise.
   - Build `manuscript_complete.md` from the chapter files.
   - Write `revision-notes.md` with continuity fixes, pacing fixes, and weak spots addressed.
   - Perform at least one revision pass on the assembled manuscript before packaging.

5. Package without improvising.
   - Prefer built-in generators over handwritten scripts.
   - Use `generate_epub` for ebook export.
   - Use `generate_document` for PDF only after `manuscript_complete.md` is ready.
   - Covers are optional. Do not block packaging on missing cover art unless the user explicitly requested illustrated covers.

6. Stop conditions for failures.
   - If packaging fails, inspect the exact error once and retry once with a grounded adjustment.
   - If it still fails, stop retrying.
   - Record the failure cause and recovery attempt in `manifest.md`.
   - Deliver the manuscript and any successful outputs instead of looping.

## Franchise Requests
- If the user asks for an established universe, label the result clearly as fan fiction or an unofficial derivative work.
- Preserve internal continuity for the requested universe, but do not claim official canon.

## Completion Criteria
- `manuscript_complete.md` exists.
- `manifest.md` exists and lists files produced plus remaining blockers.
- At least one packaged output exists if packaging was requested; otherwise the manifest must record the exact blocker.

## Final Response
- Report:
  - total manuscript word count
  - chapter count
  - packaged outputs created
  - exact blocker text for anything missing
