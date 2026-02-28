---
name: summarize-folder
description: "Create a summary of all files in a folder"
---

# Summarize Folder

## Purpose

Create a summary of all files in a folder

## Routing

- Use when: Use when the user asks to create a summary of all files in a folder.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Summarize Folder: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the summarize-folder skill for this request.
- Help me with summarize folder.
- Use when the user asks to create a summary of all files in a folder.
- Summarize Folder: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use summarize-folder for unrelated requests.
- This request is outside summarize folder scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Folder path to summarize |

## Runtime Prompt

- Current runtime prompt length: 372 characters.
- Runtime prompt is defined directly in `../summarize-folder.json`. 
