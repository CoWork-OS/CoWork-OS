---
name: manim-video
description: "Plan, scaffold, and render Manim Community Edition explainer videos for math, algorithms, technical concepts, and data stories."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Manim Video

## Purpose

Build production-ready Manim CE explainer videos with a stronger workflow than a plain prompt: dependency preflight, deterministic project scaffolding, render helpers, and artifact manifests.

## Routing

- Use when: Use when the user asks to create a Manim animation, 3Blue1Brown-style explainer, animated math walkthrough, equation derivation, algorithm visualization, technical concept video, or animated data story.
- Do not use when: Do not use for live-action editing, generic marketing motion graphics, static diagrams, or requests that only want conceptual brainstorming without renderable outputs.
- Outputs: A workspace-local Manim project with `plan.md`, `script.py`, render helpers, and run artifacts.
- Success criteria: The project is scaffolded, the script is renderable, dependency gaps are called out, and the next render command is explicit.

## Trigger Examples

### Positive

- Make a 3Blue1Brown-style Manim video explaining gradient descent.
- Build a Manim animation that walks through Dijkstra's algorithm.
- Create an animated equation derivation video in Manim CE.
- Use the manim-video skill for this request.

### Negative

- Edit this talking-head video and add B-roll.
- Design a static system diagram for this architecture review.
- Brainstorm three animation concepts, but do not create code or project files.
- Do not use manim-video for unrelated copywriting or generic video-editing work.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| topic | string | Yes | What the animation should explain or visualize |
| mode | select | No | Video pattern: auto, concept-explainer, equation-derivation, algorithm-visualization, data-story, architecture-diagram, paper-explainer, 3d-visualization |
| audience | string | No | Target audience for pacing and explanation depth |
| target_length_seconds | string | No | Approximate runtime in seconds |
| output_dir | string | No | Workspace-relative or absolute project directory |
| voiceover | select | No | Whether to scaffold a voiceover script |

## Workflow Notes

- Run `scripts/setup.sh` first. This is mandatory before claiming the project is render-ready.
- Use `scripts/bootstrap_project.py` to create or refresh the initial project shape instead of hand-rolling boilerplate.
- Keep `plan.md` and `script.py` aligned. If the scene list changes, update both.
- Default to draft render quality first. Production render is the last step, not the first.

## Reference Map

- `references/full-guidance.md`: planning rubric, scene design rules, code patterns, render flow, and review checklist
- `references/troubleshooting.md`: install issues, LaTeX/render failures, and debug moves
- `scripts/setup.sh`: environment preflight for Python, Manim, LaTeX, and ffmpeg
- `scripts/bootstrap_project.py`: deterministic scaffold generator for a new Manim project

## Runtime Prompt

- Runtime prompt is defined directly in `../manim-video.json`.
