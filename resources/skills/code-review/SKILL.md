---
name: code-review
description: "Review code for best practices and potential issues"
---

# Code Review

## Purpose

Review code for best practices and potential issues

## Routing

- Use when: Use when a user explicitly asks for a code review, bug-risk sweep, or pre-merge feedback for a specific path.
- Do not use when: Don't use when the task is a broad architecture rewrite or only formatting fixes.
- Outputs: Findings grouped by severity and file-level recommendations.
- Success criteria: Returns prioritized issues with concrete fixes and no false-critical claims.

## Trigger Examples

### Positive

- Use the code-review skill for this request.
- Help me with code review.
- Use when a user explicitly asks for a code review, bug-risk sweep, or pre-merge feedback for a specific path.
- Code Review: provide an actionable result.

### Negative

- Don't use when the task is a broad architecture rewrite or only formatting fixes.
- Do not use code-review for unrelated requests.
- This request is outside code review scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file or folder to review |

## Runtime Prompt

- Current runtime prompt length: 320 characters.
- Runtime prompt is defined directly in `../code-review.json`. 
