---
name: openai-whisper-api
description: "Transcribe audio via OpenAI Audio Transcriptions API (Whisper)."
---

# Openai-whisper-api

## Purpose

Transcribe audio via OpenAI Audio Transcriptions API (Whisper).

## Routing

- Use when: Use when the user asks to transcribe audio via OpenAI Audio Transcriptions API Whisper.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Openai-whisper-api: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the openai-whisper-api skill for this request.
- Help me with openai-whisper-api.
- Use when the user asks to transcribe audio via OpenAI Audio Transcriptions API Whisper.
- Openai-whisper-api: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use openai-whisper-api for unrelated requests.
- This request is outside openai-whisper-api scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 796 characters.
- Runtime prompt is defined directly in `../openai-whisper-api.json`. 
