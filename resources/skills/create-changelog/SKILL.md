---
name: create-changelog
description: "Generate changelog from git commits"
---

# Create Changelog

## Purpose

Generate changelog from git commits

## Routing

- Use when: Use when the user asks to generate changelog from git commits.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Create Changelog: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the create-changelog skill for this request.
- Help me with create changelog.
- Use when the user asks to generate changelog from git commits.
- Create Changelog: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use create-changelog for unrelated requests.
- This request is outside create changelog scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| commits | select | Yes | Number of commits to include |

## Runtime Prompt

- Current runtime prompt length: 405 characters.
- Runtime prompt is defined directly in `../create-changelog.json`. 
