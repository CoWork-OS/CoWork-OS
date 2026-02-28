---
name: slack
description: "Use when you need to control Slack from CoWork-OSS via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs."
---

# Slack

## Purpose

Use when you need to control Slack from CoWork-OSS via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs.

## Routing

- Use when: Use when the user asks to use when you need to control Slack from CoWork-OSS via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Slack: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the slack skill for this request.
- Help me with slack.
- Use when the user asks to use when you need to control Slack from CoWork-OSS via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs.
- Slack: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use slack for unrelated requests.
- This request is outside slack scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 2221 characters.
- Runtime prompt is defined directly in `../slack.json`. 
