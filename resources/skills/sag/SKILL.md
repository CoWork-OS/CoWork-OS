---
name: sag
description: "ElevenLabs text-to-speech with mac-style say UX."
---

# Sag

## Purpose

ElevenLabs text-to-speech with mac-style say UX.

## Routing

- Use when: Use when the user asks to elevenLabs text-to-speech with mac-style say UX.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Sag: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the sag skill for this request.
- Help me with sag.
- Use when the user asks to elevenLabs text-to-speech with mac-style say UX.
- Sag: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use sag for unrelated requests.
- This request is outside sag scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1761 characters.
- Runtime prompt is defined directly in `../sag.json`. 
