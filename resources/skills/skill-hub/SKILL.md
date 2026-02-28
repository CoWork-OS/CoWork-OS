---
name: skill-hub
description: "Use the skill-hub CLI to search, install, update, and publish agent skills from skill-hub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed skill-hub CLI."
---

# skill-hub

## Purpose

Use the skill-hub CLI to search, install, update, and publish agent skills from skill-hub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed skill-hub CLI.

## Routing

- Use when: Use when the user asks to use the skill-hub CLI to search, install, update, and publish agent skills from skill-hub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed skill-hub CLI.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from skill-hub: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the skill-hub skill for this request.
- Help me with skill-hub.
- Use when the user asks to use the skill-hub CLI to search, install, update, and publish agent skills from skill-hub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed skill-hub CLI.
- skill-hub: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use skill-hub for unrelated requests.
- This request is outside skill-hub scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 993 characters.
- Runtime prompt is defined directly in `../skill-hub.json`. 
