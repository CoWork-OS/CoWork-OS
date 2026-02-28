---
name: bluebubbles
description: "Build or update the BlueBubbles external channel plugin for CoWork-OSS (extension package, REST send/probe, webhook inbound)."
---

# Bluebubbles

## Purpose

Build or update the BlueBubbles external channel plugin for CoWork-OSS (extension package, REST send/probe, webhook inbound).

## Routing

- Use when: Use when the user asks to build or update the BlueBubbles external channel plugin for CoWork-OSS extension package, REST send/probe, webhook inbound.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Bluebubbles: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the bluebubbles skill for this request.
- Help me with bluebubbles.
- Use when the user asks to build or update the BlueBubbles external channel plugin for CoWork-OSS extension package, REST send/probe, webhook inbound.
- Bluebubbles: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use bluebubbles for unrelated requests.
- This request is outside bluebubbles scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2136 characters.
- Runtime prompt is defined directly in `../bluebubbles.json`. 
