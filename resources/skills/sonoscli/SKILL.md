---
name: sonoscli
description: "Control Sonos speakers (discover/status/play/volume/group)."
---

# Sonoscli

## Purpose

Control Sonos speakers (discover/status/play/volume/group).

## Routing

- Use when: Use when the user asks to control Sonos speakers discover/status/play/volume/group.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Sonoscli: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the sonoscli skill for this request.
- Help me with sonoscli.
- Use when the user asks to control Sonos speakers discover/status/play/volume/group.
- Sonoscli: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use sonoscli for unrelated requests.
- This request is outside sonoscli scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 603 characters.
- Runtime prompt is defined directly in `../sonoscli.json`. 
