---
name: openai-whisper
description: "Local speech-to-text with the Whisper CLI (no API key)."
---

# Openai-whisper

## Purpose

Local speech-to-text with the Whisper CLI (no API key).

## Routing

- Use when: Use when the user asks to local speech-to-text with the Whisper CLI no API key.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Openai-whisper: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the openai-whisper skill for this request.
- Help me with openai-whisper.
- Use when the user asks to local speech-to-text with the Whisper CLI no API key.
- Openai-whisper: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use openai-whisper for unrelated requests.
- This request is outside openai-whisper scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 380 characters.
- Runtime prompt is defined directly in `../openai-whisper.json`. 
