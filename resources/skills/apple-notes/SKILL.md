---
name: apple-notes
description: "Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks CoWork-OSS to add a note, list notes, search notes, or manage note folders."
---

# Apple-notes

## Purpose

Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks CoWork-OSS to add a note, list notes, search notes, or manage note folders.

## Routing

- Use when: Use when the user asks to manage Apple Notes via the memo CLI on macOS create, view, edit, delete, search, move, and export notes.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Outputs: Outcome from Apple-notes: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the apple-notes skill for this request.
- Help me with apple-notes.
- Use when the user asks to manage Apple Notes via the memo CLI on macOS create, view, edit, delete, search, move, and export notes.
- Apple-notes: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Do not use apple-notes for unrelated requests.
- This request is outside apple-notes scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1390 characters.
- Runtime prompt is defined directly in `../apple-notes.json`. 
