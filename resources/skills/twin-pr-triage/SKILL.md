---
name: twin-pr-triage
description: "Scan open pull requests, assess risk and complexity, and build a prioritized review queue. Used by digital twin personas to reduce PR review cognitive load."
---

# PR Triage & Review Queue

## Purpose

Scan open pull requests, assess risk and complexity, and build a prioritized review queue. Used by digital twin personas to reduce PR review cognitive load.

## Routing

- Use when: Use when triaging open pull requests, building a review queue, or assessing PR backlog health.
- Do not use when: Don't use for performing actual code reviews or making merge decisions.
- Outputs: Prioritized PR review queue with risk assessments
- Success criteria: All open PRs listed with accurate risk and priority assessment

## Trigger Examples

### Positive

- Use the twin-pr-triage skill for this request.
- Help me with pr triage & review queue.
- Use when triaging open pull requests, building a review queue, or assessing PR backlog health.
- PR Triage & Review Queue: provide an actionable result.

### Negative

- Don't use for performing actual code reviews or making merge decisions.
- Do not use twin-pr-triage for unrelated requests.
- This request is outside pr triage & review queue scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| stale_hours | number | No | Hours after which a PR is considered stale |

## Runtime Prompt

- Current runtime prompt length: 763 characters.
- Runtime prompt is defined directly in `../twin-pr-triage.json`. 
