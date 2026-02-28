---
name: summarize
description: "Summarize or extract text/transcripts from URLs, podcasts, and local files (great fallback for “transcribe this YouTube/video”)."
---

# Summarize

## Purpose

Summarize or extract text/transcripts from URLs, podcasts, and local files (great fallback for “transcribe this YouTube/video”).

## Routing

- Use when: Use when the user asks to summarize or extract text/transcripts from URLs, podcasts, and local files great fallback for “transcribe this YouTube/video”.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Summarize: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the summarize skill for this request.
- Help me with summarize.
- Use when the user asks to summarize or extract text/transcripts from URLs, podcasts, and local files great fallback for “transcribe this YouTube/video”.
- Summarize: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use summarize for unrelated requests.
- This request is outside summarize scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1616 characters.
- Runtime prompt is defined directly in `../summarize.json`. 
