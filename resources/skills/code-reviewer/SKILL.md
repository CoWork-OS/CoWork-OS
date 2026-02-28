---
name: code-reviewer
description: "Perform professional code review for local changes or GitHub pull requests."
---

# code-reviewer

## Purpose

Perform professional code review for local changes or GitHub pull requests.

## Routing

- Use when: Use for formal, structured review workflows on local diffs or GitHub PRs.
- Do not use when: Don't use for one-off formatting checks without code-quality feedback.
- Outputs: Findings grouped by severity with rationale and approval/revise recommendation.
- Success criteria: Covers correctness, maintainability, performance, security, and testability.

## Trigger Examples

### Positive

- Use the code-reviewer skill for this request.
- Help me with code-reviewer.
- Use for formal, structured review workflows on local diffs or GitHub PRs.
- code-reviewer: provide an actionable result.

### Negative

- Don't use for one-off formatting checks without code-quality feedback.
- Do not use code-reviewer for unrelated requests.
- This request is outside code-reviewer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 3052 characters.
- Runtime prompt is defined directly in `../code-reviewer.json`. 
