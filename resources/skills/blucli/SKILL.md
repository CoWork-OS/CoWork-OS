---
name: blucli
description: "BluOS CLI (blu) for discovery, playback, grouping, and volume."
---

# Blucli

## Purpose

BluOS CLI (blu) for discovery, playback, grouping, and volume.

## Routing

- Use when: Use when the user asks to bluOS CLI blu for discovery, playback, grouping, and volume.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Blucli: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the blucli skill for this request.
- Help me with blucli.
- Use when the user asks to bluOS CLI blu for discovery, playback, grouping, and volume.
- Blucli: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use blucli for unrelated requests.
- This request is outside blucli scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 503 characters.
- Runtime prompt is defined directly in `../blucli.json`. 
