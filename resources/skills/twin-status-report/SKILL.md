---
name: twin-status-report
description: "Generate a concise status report from recent activity, tasks, commits, and conversations. Used by digital twin personas to prepare standup updates and progress summaries."
---

# Status Report Generator

## Purpose

Generate a concise status report from recent activity, tasks, commits, and conversations. Used by digital twin personas to prepare standup updates and progress summaries.

## Routing

- Use when: Use when generating status updates, standup reports, progress summaries, or sprint reviews.
- Do not use when: Don't use for detailed technical analysis or code review.
- Outputs: Markdown status report organized by completion status
- Success criteria: Report covers all active work streams with clear status and action items

## Trigger Examples

### Positive

- Use the twin-status-report skill for this request.
- Help me with status report generator.
- Use when generating status updates, standup reports, progress summaries, or sprint reviews.
- Status Report Generator: provide an actionable result.

### Negative

- Don't use for detailed technical analysis or code review.
- Do not use twin-status-report for unrelated requests.
- This request is outside status report generator scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| period | string | No | Time period to cover |
| audience | select | No | Who the report is for |

## Runtime Prompt

- Current runtime prompt length: 544 characters.
- Runtime prompt is defined directly in `../twin-status-report.json`. 
