---
name: pi-finder-subagent
description: "Read-only local workspace scout subagent for Pi. Use it to narrow context to relevant files/snippets before implementation."
---

# Pi-finder-subagent

## Purpose

Read-only local workspace scout subagent for Pi. Use it to narrow context to relevant files/snippets before implementation.

## Routing

- Use when: Use when users ask to scout the local repository, identify relevant files/snippets, or reduce context before coding.
- Do not use when: Do not use for remote GitHub-first research across external repositories; use pi-librarian instead.
- Outputs: A cited local-file shortlist with line ranges plus a saved report at {artifactDir}/finder-report.md.
- Success criteria: Finder completes with concrete file paths, line ranges, and focused next steps that reduce implementation context.

## Trigger Examples

### Positive

- Use the pi-finder-subagent skill for this request.
- Help me with pi-finder-subagent.
- Use when users ask to scout the local repository, identify relevant files/snippets, or reduce context before coding.
- Pi-finder-subagent: provide an actionable result.

### Negative

- Do not use for remote GitHub-first research across external repositories; use pi-librarian instead.
- Do not use pi-finder-subagent for unrelated requests.
- This request is outside pi-finder-subagent scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| query | string | Yes | What to find in the local workspace |
| scope_hint | string | No | Optional directories/files/symbols to prioritize |

## Runtime Prompt

- Current runtime prompt length: 775 characters.
- Runtime prompt is defined directly in `../pi-finder-subagent.json`. 
