---
name: openai-image-gen
description: "Batch-generate images via OpenAI Images API. Random prompt sampler + `index.html` gallery."
---

# Openai-image-gen

## Purpose

Batch-generate images via OpenAI Images API. Random prompt sampler + `index.html` gallery.

## Routing

- Use when: Use when the user asks to batch-generate images via OpenAI Images API. Random prompt sampler + index.html gallery.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Openai-image-gen: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the openai-image-gen skill for this request.
- Help me with openai-image-gen.
- Use when the user asks to batch-generate images via OpenAI Images API. Random prompt sampler + index.html gallery.
- Openai-image-gen: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use openai-image-gen for unrelated requests.
- This request is outside openai-image-gen scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2643 characters.
- Runtime prompt is defined directly in `../openai-image-gen.json`. 
