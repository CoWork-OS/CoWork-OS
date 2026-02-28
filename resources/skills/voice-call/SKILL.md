---
name: voice-call
description: "Initiate outbound phone calls via ElevenLabs Agents."
---

# Voice Call

## Purpose

Initiate outbound phone calls via ElevenLabs Agents.

## Routing

- Use when: Use when the user asks to initiate outbound phone calls via ElevenLabs Agents.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Voice Call: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the voice-call skill for this request.
- Help me with voice call.
- Use when the user asks to initiate outbound phone calls via ElevenLabs Agents.
- Voice Call: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use voice-call for unrelated requests.
- This request is outside voice call scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 930 characters.
- Runtime prompt is defined directly in `../voice-call.json`. 
