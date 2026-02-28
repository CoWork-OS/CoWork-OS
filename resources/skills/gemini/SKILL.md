---
name: gemini
description: "Gemini CLI for one-shot Q&A, summaries, and generation."
---

# Gemini

## Purpose

Gemini CLI for one-shot Q&A, summaries, and generation.

## Routing

- Use when: Use when the user asks to gemini CLI for one-shot Q&A, summaries, and generation.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Outputs: Outcome from Gemini: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the gemini skill for this request.
- Help me with gemini.
- Use when the user asks to gemini CLI for one-shot Q&A, summaries, and generation.
- Gemini: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Do not use gemini for unrelated requests.
- This request is outside gemini scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 434 characters.
- Runtime prompt is defined directly in `../gemini.json`. 
