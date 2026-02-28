---
name: blogwatcher
description: "Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI."
---

# Blogwatcher

## Purpose

Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.

## Routing

- Use when: Use when the user asks to monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Blogwatcher: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the blogwatcher skill for this request.
- Help me with blogwatcher.
- Use when the user asks to monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.
- Blogwatcher: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use blogwatcher for unrelated requests.
- This request is outside blogwatcher scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 832 characters.
- Runtime prompt is defined directly in `../blogwatcher.json`. 
