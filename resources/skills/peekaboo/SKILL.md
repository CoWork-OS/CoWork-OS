---
name: peekaboo
description: "Capture and automate macOS UI with the Peekaboo CLI."
---

# Peekaboo

## Purpose

Capture and automate macOS UI with the Peekaboo CLI.

## Routing

- Use when: Use when the user asks to capture and automate macOS UI with the Peekaboo CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Peekaboo: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the peekaboo skill for this request.
- Help me with peekaboo.
- Use when the user asks to capture and automate macOS UI with the Peekaboo CLI.
- Peekaboo: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use peekaboo for unrelated requests.
- This request is outside peekaboo scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 832 characters.
- Runtime prompt is defined directly in `../peekaboo.json`. 
