---
name: gog
description: "Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, and Slides."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Gog

## Purpose

Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, and Slides.

## Routing

- Use when: Use when the user asks to use the Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, or Slides.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Gog: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the gog skill for this request.
- Help me with gog.
- Use when the user asks to use the Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, or Slides.
- Gog: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use gog for unrelated requests.
- This request is outside gog scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 4964 characters.
- Runtime prompt is defined directly in `../gog.json`. 
