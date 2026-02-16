# Pi Finder + Librarian Playbook

This repo now includes three bundled skills:

- `pi-finder-subagent`
- `pi-librarian`
- `pi-context-pipeline` (orchestrates both)

## Why this helps

Large coding tasks often waste context on broad file reads. This pipeline narrows discovery first, then hands coding agents a strict file shortlist.

## Setup

```bash
npm i -g @mariozechner/pi-coding-agent
pi install npm:pi-finder-subagent
pi install npm:pi-librarian
gh auth login   # needed only for librarian mode
```

## Recommended flow

1. Run `pi-context-pipeline` with a concrete `query`.
2. Keep `run_librarian=false` unless external GitHub patterns are actually needed.
3. Use `artifacts/.../context-pack.md` and `codex-kickoff.txt` as the coding handoff.
4. Only expand scope if the context pack still has unresolved blockers.

## Guardrails

- Keep Finder output to max 12 local files.
- Require file paths + line ranges in reports.
- Prefer explicit unknowns over speculative guesses.
- Avoid starting implementation before discovery artifacts are written.

## Fast commands (manual mode)

Local discovery only:

```bash
pi --no-session --tools read,grep,find,ls,bash -e npm:pi-finder-subagent -p "Use finder to locate auth entrypoints and token validation code. Return max 12 files with line ranges."
```

GitHub discovery:

```bash
pi --no-session --tools read,grep,find,ls,bash -e npm:pi-librarian -p "Use librarian to find robust webhook signature verification patterns in known OSS repos. Include cited files and line ranges."
```

