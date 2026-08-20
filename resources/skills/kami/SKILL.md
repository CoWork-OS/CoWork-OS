---
name: kami
description: Typeset professional documents with the Kami editorial design system when the user explicitly asks for Kami by name.
version: "1.0.0"
license: MIT
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source-author: Tw93
---

# Kami

## Purpose

Typeset professional documents with the Kami editorial design system only when
the user explicitly asks for Kami, the Kami skill, or the Kami editorial design
system by name. Generic presentation, document, report, resume, PDF, and
PowerPoint requests should use the native artifact tools instead.

This CoWork bundle ports the upstream [Kami](https://github.com/tw93/Kami) skill into a bundled skill with a workspace-local scaffold flow. The goal is to keep the strong visual system available on request while avoiding edits to bundled templates under `resources/skills/`.

## Licensing Note

- Upstream Kami is MIT licensed.
- This bundled port includes the open English font assets used by the upstream project.
- This bundled port does **not** ship the proprietary Chinese serif font `TsangerJinKai02-W04.ttf`.
- Chinese HTML templates in this port are patched to rely on system serif fallbacks by default.
- If a user has a licensed copy of that font and wants to use it, they can add it to the scaffolded project intentionally.

## Supported Outputs

- `one-pager`
- `long-doc`
- `letter`
- `portfolio`
- `resume`
- `slides`
- `diagram-architecture`
- `diagram-flowchart`
- `diagram-quadrant`

## Project Layout

The CoWork wrapper scaffolds a workspace-local project with a stable shape:

- `templates/` for document or slide source files
- `diagrams/` for standalone diagram HTML
- `fonts/` for bundled open fonts and optional user-supplied licensed fonts
- `outputs/` for rendered PDF and PPTX files
- `manifest.json` for scaffold metadata

Edit only the scaffolded project files. Do not edit bundled files under this skill directory.

## Workflow

1. Resolve document type and language before creating files.
2. Run `scripts/setup.sh` to detect local render support.
3. Run `scripts/bootstrap_project.py` to scaffold a workspace-local project.
4. Read the smallest useful reference set:
   - `CHEATSHEET.md` or `CHEATSHEET.en.md` for light edits
   - `references/design*.md` for new documents or larger layout work
   - `references/writing*.md` for section structure and editorial tone
   - `references/production*.md` for rendering issues
   - `references/diagrams*.md` for standalone diagram work
5. If the user gives raw notes, distill them before styling:
   - extract facts and metrics
   - classify them into the target section structure
   - identify what is missing
   - ask once instead of inventing missing claims
6. Keep the visual system intact. Favor content edits and small layout adjustments over broad CSS reinvention.
7. Render HTML-based outputs with `scripts/render_html.py`.
8. Render slides with `scripts/render_slides.mjs`, pointing it at the scaffolded `slides.mjs` or `slides-en.mjs` source file and the project's `outputs/` directory.

## Design Constraints

- Parchment background, never pure white
- Ink-blue as the only accent color
- Warm neutrals, no cool gray UI defaults
- Serif carries the hierarchy
- Tight editorial spacing, not loose slideware spacing
- Avoid glossy UI flourishes, hard shadows, and loud gradients

## Chinese Font Rule

When upstream references mention `TsangerJinKai02`, treat that as an optional licensed upgrade, not a bundled requirement in this CoWork port. Default to the patched fallbacks already present in the scaffolded Chinese HTML templates unless the user explicitly provides a licensed font file.

## Reference Map

- `CHEATSHEET.md` / `CHEATSHEET.en.md`: quick style and template reference
- `references/design.md` / `design.en.md`: visual rules and layout tokens
- `references/writing.md` / `writing.en.md`: section structure and editorial guidance
- `references/production.md` / `production.en.md`: rendering and export troubleshooting
- `references/diagrams.md` / `diagrams.en.md`: standalone diagram guidance
- `scripts/bootstrap_project.py`: scaffold workspace-local source files
- `scripts/render_html.py`: render a source HTML file to PDF with placeholder checks
- `scripts/render_slides.mjs`: render slide source to `output.pptx` and optionally `output.pdf`
- `scripts/setup.sh`: preflight local document-render dependencies
- `scripts/build.py`: upstream bundle build/verification helper retained for reference

## Runtime Prompt

- Runtime prompt is defined directly in `../kami.json`.
