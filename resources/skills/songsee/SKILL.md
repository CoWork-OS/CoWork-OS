---
name: songsee
description: "Generate spectrograms and feature-panel visualizations from audio with the songsee CLI."
---

# Songsee

## Purpose

Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.

## Routing

- Use when: Use when the user asks to generate spectrograms and feature-panel visualizations from audio with the songsee CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Songsee: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the songsee skill for this request.
- Help me with songsee.
- Use when the user asks to generate spectrograms and feature-panel visualizations from audio with the songsee CLI.
- Songsee: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use songsee for unrelated requests.
- This request is outside songsee scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 758 characters.
- Runtime prompt is defined directly in `../songsee.json`. 
