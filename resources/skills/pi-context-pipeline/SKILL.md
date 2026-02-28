---
name: pi-context-pipeline
description: "Orchestrate pi-finder and optional pi-librarian to produce a compact context pack and Codex kickoff prompt before coding."
---

# Pi-context-pipeline

## Purpose

Orchestrate pi-finder and optional pi-librarian to produce a compact context pack and Codex kickoff prompt before coding.

## Routing

- Use when: Use when users want a Finder plus Librarian pre-coding pipeline that narrows context and prepares a coding handoff prompt.
- Do not use when: Do not use for direct coding changes that are already scoped to a few known files.
- Outputs: A local scout report, optional GitHub scout report, a compact context pack, and a Codex kickoff prompt under {artifactDir}.
- Success criteria: Produces focused artifacts with cited files/lines and a clean coding handoff that avoids unrelated context reads.

## Trigger Examples

### Positive

- Use the pi-context-pipeline skill for this request.
- Help me with pi-context-pipeline.
- Use when users want a Finder plus Librarian pre-coding pipeline that narrows context and prepares a coding handoff prompt.
- Pi-context-pipeline: provide an actionable result.

### Negative

- Do not use for direct coding changes that are already scoped to a few known files.
- Do not use pi-context-pipeline for unrelated requests.
- This request is outside pi-context-pipeline scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| query | string | Yes | What to implement or investigate |
| scope_hint | string | No | Optional local directories/files/symbols to prioritize |
| repo_hints | string | No | Optional external repo hints (owner/repo list) |
| owner_hints | string | No | Optional org/user hints for GitHub research |
| run_librarian | boolean | No | Whether to include GitHub research in addition to local scouting |
| max_search_results | number | No | Maximum GitHub search results requested by librarian |

## Runtime Prompt

- Current runtime prompt length: 2187 characters.
- Runtime prompt is defined directly in `../pi-context-pipeline.json`. 
