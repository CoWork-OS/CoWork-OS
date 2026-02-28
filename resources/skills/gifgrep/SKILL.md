---
name: gifgrep
description: "Search GIF providers with CLI/TUI, download results, and extract stills/sheets."
---

# Gifgrep

## Purpose

Search GIF providers with CLI/TUI, download results, and extract stills/sheets.

## Routing

- Use when: Use when the user asks to search GIF providers with CLI/TUI, download results, and extract stills/sheets.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Gifgrep: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the gifgrep skill for this request.
- Help me with gifgrep.
- Use when the user asks to search GIF providers with CLI/TUI, download results, and extract stills/sheets.
- Gifgrep: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use gifgrep for unrelated requests.
- This request is outside gifgrep scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1408 characters.
- Runtime prompt is defined directly in `../gifgrep.json`. 
