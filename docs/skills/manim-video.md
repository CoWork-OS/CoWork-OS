# Manim Video Skill

`manim-video` is a bundled CoWork OS skill for planning, scaffolding, and optionally rendering technical explainer videos with Manim Community Edition.

It is designed for:

- animated math walkthroughs
- equation derivations
- algorithm visualizations
- technical concept explainers
- architecture build-up animations
- animated data stories
- 3Blue1Brown-style educational videos

It is not the right tool for:

- live-action editing
- stock-footage montage
- generic marketing motion graphics
- static diagrams or slide decks
- brainstorming-only requests with no renderable output

## What The Skill Does

Compared with a plain imported `SKILL.md`, CoWork’s bundled `manim-video` integration adds a stronger local workflow:

- dependency preflight through `resources/skills/manim-video/scripts/setup.sh`
- deterministic project scaffolding through `resources/skills/manim-video/scripts/bootstrap_project.py`
- workspace-local outputs instead of an ephemeral prompt-only answer
- explicit draft-vs-production render flow
- run artifacts for project review and handoff

The skill scaffolds a Manim project with:

- `plan.md`
- `script.py`
- `concat.txt`
- `render.sh`
- optional `voiceover.md`

It also expects run artifacts under the current task artifact directory:

- `project-manifest.md`
- `render-checklist.md`
- `review-notes.md`

## How To Use It

`manim-video` is a built-in bundled skill. There is nothing to install from the Skill Store.

The easiest way to use it is to ask directly in natural language, for example:

```text
Create a 3Blue1Brown-style Manim video explaining gradient descent.
```

```text
Build a Manim animation that visualizes Dijkstra's algorithm step by step.
```

```text
Use the manim-video skill to create an animated equation derivation for the chain rule.
```

Good requests usually include:

- the topic
- the audience
- the target length
- whether voiceover should be included
- whether you want only scaffolding or actual rendering

Example:

```text
Use the manim-video skill to create a 75-second concept explainer for gradient descent aimed at software engineers. Scaffold the full project in this workspace and render only draft quality first.
```

## Invocation Model

`manim-video` follows CoWork’s additive skill runtime.

- The original task stays canonical.
- The skill adds execution context and scoped directives.
- It does not replace the user’s task with a synthetic prompt.

See [Skills Runtime Model](../skills-runtime-model.md).

## Parameters

The bundled manifest supports these inputs:

- `topic`: what the animation explains or visualizes
- `mode`: `auto`, `concept-explainer`, `equation-derivation`, `algorithm-visualization`, `data-story`, `architecture-diagram`, `paper-explainer`, or `3d-visualization`
- `audience`: target audience for pacing and explanation depth
- `target_length_seconds`: approximate runtime
- `output_dir`: workspace-relative or absolute output directory
- `voiceover`: `auto`, `on`, or `off`

If `output_dir` is omitted, the skill defaults to a local `manim-video-project` directory in the current workspace.

## Project Workflow

The skill’s expected flow is:

1. Run the setup preflight.
2. Read the bundled guidance and troubleshooting references.
3. Bootstrap the project skeleton.
4. Write or update `plan.md` and `script.py`.
5. Render draft quality first if execution is requested and dependencies are satisfied.
6. Review clarity, pacing, and scene transitions.
7. Only then move to production quality.

The generated `script.py` uses one `Scene` subclass per beat and shared constants at the top of the file.

## Dependencies

The skill checks for:

- Python 3.10+
- Manim Community Edition in the active Python environment
- `ffmpeg`
- a LaTeX engine such as `pdflatex`
- `dvisvgm` when available

You can run the same preflight manually:

```bash
bash resources/skills/manim-video/scripts/setup.sh
```

On a machine where Manim is missing, the skill still remains useful for planning and project scaffolding, but draft rendering will not be available until the dependency is installed.

## Generated Files

### `plan.md`

Contains:

- topic and audience
- target runtime
- visual language
- scene breakdown
- pacing notes
- review checklist

### `script.py`

Contains:

- shared palette and typography constants
- one Manim scene class per beat
- scaffolded timing and cleanup patterns
- renderable scene names such as `Scene01Hook`

### `render.sh`

Provides the standard entry points:

- `bash render.sh draft`
- `bash render.sh production`
- `bash render.sh still Scene02Intuition`

## Recommended Prompt Patterns

Use this skill when the output should teach through motion.

Strong fits:

- “Explain backpropagation with animated geometry.”
- “Animate how a binary heap changes during insert and extract-min.”
- “Turn this research paper’s core method into a short visual explainer.”
- “Build an animated architecture diagram showing request flow through our system.”

Weak fits:

- “Edit this podcast clip.”
- “Make a generic product promo video.” — use [`motion-film`](motion-film.md)
- “Create a static diagram.”

## Related Features And Skills

- [Features](../features.md): product-wide runtime and skills overview
- [Use Cases](../use-cases.md): copy-paste prompts that include `manim-video`
- [Use Case Showcase](../showcase.md): example workflows powered by the skill
- [Skill Store & External Skills](../skill-store-and-external-skills.md): explains why this one is bundled and available immediately
- [`motion-film`](motion-film.md): for launch videos, promos, and other motion-design films rendered in code
- `video-frames`: for extracting stills or clips from an existing video, not generating a new animation
- built-in video generation providers: better for model-generated video clips, not deterministic technical animation

## Where The Source Lives

Bundled skill files:

- `resources/skills/manim-video.json`
- `resources/skills/manim-video/SKILL.md`
- `resources/skills/manim-video/references/full-guidance.md`
- `resources/skills/manim-video/references/troubleshooting.md`
- `resources/skills/manim-video/scripts/setup.sh`
- `resources/skills/manim-video/scripts/bootstrap_project.py`

## Development Notes

When editing the bundled skill itself, run:

```bash
python3 -m py_compile resources/skills/manim-video/scripts/bootstrap_project.py
bash resources/skills/manim-video/scripts/setup.sh
npm run skills:check
```
