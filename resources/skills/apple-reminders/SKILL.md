---
name: apple-reminders
description: "Manage Apple Reminders via the `remindctl` CLI on macOS (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output."
---

# Apple-reminders

## Purpose

Manage Apple Reminders via the `remindctl` CLI on macOS (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output.

## Routing

- Use when: Use when the user asks to manage Apple Reminders via the remindctl CLI on macOS list, add, edit, complete, delete. Supports lists, date filters, and JSON/plain output.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments.
- Outputs: Outcome from Apple-reminders: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the apple-reminders skill for this request.
- Help me with apple-reminders.
- Use when the user asks to manage Apple Reminders via the remindctl CLI on macOS list, add, edit, complete, delete. Supports lists, date filters, and JSON/plain output.
- Apple-reminders: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using this in non-macOS environments.
- Do not use apple-reminders for unrelated requests.
- This request is outside apple-reminders scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1852 characters.
- Runtime prompt is defined directly in `../apple-reminders.json`. 
