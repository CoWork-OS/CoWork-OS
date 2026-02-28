---
name: local-places
description: "Search for places (restaurants, cafes, etc.) via Google Places API proxy on localhost."
---

# Local-places

## Purpose

Search for places (restaurants, cafes, etc.) via Google Places API proxy on localhost.

## Routing

- Use when: Use when the user asks to search for places restaurants, cafes, etc. via Google Places API proxy on localhost.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Local-places: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the local-places skill for this request.
- Help me with local-places.
- Use when the user asks to search for places restaurants, cafes, etc. via Google Places API proxy on localhost.
- Local-places: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use local-places for unrelated requests.
- This request is outside local-places scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2167 characters.
- Runtime prompt is defined directly in `../local-places.json`. 
