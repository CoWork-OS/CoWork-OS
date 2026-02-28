---
name: openhue
description: "Control Philips Hue lights/scenes via the OpenHue CLI."
---

# Openhue

## Purpose

Control Philips Hue lights/scenes via the OpenHue CLI.

## Routing

- Use when: Use when the user asks to control Philips Hue lights/scenes via the OpenHue CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Openhue: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the openhue skill for this request.
- Help me with openhue.
- Use when the user asks to control Philips Hue lights/scenes via the OpenHue CLI.
- Openhue: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use openhue for unrelated requests.
- This request is outside openhue scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 639 characters.
- Runtime prompt is defined directly in `../openhue.json`. 
