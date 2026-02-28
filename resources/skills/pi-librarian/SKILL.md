---
name: pi-librarian
description: "GitHub research subagent for Pi that uses gh workflows to find and cite relevant repo files before implementation."
---

# Pi-librarian

## Purpose

GitHub research subagent for Pi that uses gh workflows to find and cite relevant repo files before implementation.

## Routing

- Use when: Use when users ask to research external GitHub repositories, compare implementation patterns, or gather cited repo evidence before coding.
- Do not use when: Do not use for local-workspace-only discovery or when GitHub access is unnecessary; use pi-finder-subagent instead.
- Outputs: A cited GitHub research report in {artifactDir}/librarian-report.md plus an actionable summary in {artifactDir}/librarian-summary.md.
- Success criteria: Librarian returns concrete repositories, file paths with citations, and clear unknowns/access limits that guide implementation decisions.

## Trigger Examples

### Positive

- Use the pi-librarian skill for this request.
- Help me with pi-librarian.
- Use when users ask to research external GitHub repositories, compare implementation patterns, or gather cited repo evidence before coding.
- Pi-librarian: provide an actionable result.

### Negative

- Do not use for local-workspace-only discovery or when GitHub access is unnecessary; use pi-finder-subagent instead.
- Do not use pi-librarian for unrelated requests.
- This request is outside pi-librarian scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| query | string | Yes | What to research across GitHub repos |
| repo_hints | string | No | Optional repo list hints, e.g. owner/repo pairs |
| owner_hints | string | No | Optional owner/org hints |
| max_search_results | number | No | Maximum gh search results to request |

## Runtime Prompt

- Current runtime prompt length: 1003 characters.
- Runtime prompt is defined directly in `../pi-librarian.json`. 
