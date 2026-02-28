---
name: research-last-days
description: "Research a topic from the past X days using web search. Specify the number of days or let it be inferred from your prompt."
---

# Last X Days Research

## Purpose

Research a topic from the past X days using web search. Specify the number of days or let it be inferred from your prompt.

## Routing

- Use when: Use when the user asks to research what happened recently on a topic, look up news from the last N days, or find recent trends and discussions.
- Do not use when: Do not use for planning documents, high-level strategy, or non-executable discussion.
- Outputs: Summary of recent findings with trends, patterns, and actionable insights.
- Success criteria: Returns concrete findings from the specified time period with sources and no fabricated results.

## Trigger Examples

### Positive

- Use the research-last-days skill for this request.
- Help me with last x days research.
- Use when the user asks to research what happened recently on a topic, look up news from the last N days, or find recent trends and discussions.
- Last X Days Research: provide an actionable result.

### Negative

- Do not use for planning documents, high-level strategy, or non-executable discussion.
- Do not use research-last-days for unrelated requests.
- This request is outside last x days research scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| topic | string | Yes | The topic to research (e.g., 'AI agents', 'prompting techniques', 'Apple announcements') |
| days | number | No | Number of days to look back (e.g., 1, 7, 14, 30, 90). Defaults to 7. |
| tool | select | No | Target AI tool for the prompts (optional context) |

## Runtime Prompt

- Current runtime prompt length: 1668 characters.
- Runtime prompt is defined directly in `../research-last-days.json`. 
