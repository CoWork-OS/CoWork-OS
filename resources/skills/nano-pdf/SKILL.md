---
name: nano-pdf
description: "Edit PDFs with natural-language instructions using the nano-pdf CLI."
---

# Nano-pdf

## Purpose

Edit PDFs with natural-language instructions using the nano-pdf CLI.

## Routing

- Use when: Use when the user asks to edit PDFs with natural-language instructions using the nano-pdf CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Nano-pdf: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the nano-pdf skill for this request.
- Help me with nano-pdf.
- Use when the user asks to edit PDFs with natural-language instructions using the nano-pdf CLI.
- Nano-pdf: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use nano-pdf for unrelated requests.
- This request is outside nano-pdf scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 430 characters.
- Runtime prompt is defined directly in `../nano-pdf.json`. 
