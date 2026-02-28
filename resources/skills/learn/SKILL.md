---
name: learn
description: "Manually record an insight, correction, preference, or rule that the agent should remember for future tasks."
---

# Learn

## Purpose

Manually record an insight, correction, preference, or rule that the agent should remember for future tasks.

## Routing

- Use when: Use when the user explicitly wants to teach the agent something, record a preference, save a correction, or store a rule for future tasks.
- Do not use when: Don't use for general conversation, one-time instructions that don't need to be remembered, or when the user is just chatting.
- Outputs: Persisted learning in memory system and .cowork/MEMORY.md file.
- Success criteria: Learning is stored in memory and written to .cowork/MEMORY.md with confirmation to the user.

## Trigger Examples

### Positive

- Use the learn skill for this request.
- Help me with learn.
- Use when the user explicitly wants to teach the agent something, record a preference, save a correction, or store a rule for future tasks.
- Learn: provide an actionable result.

### Negative

- Don't use for general conversation, one-time instructions that don't need to be remembered, or when the user is just chatting.
- Do not use learn for unrelated requests.
- This request is outside learn scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| what | string | Yes | The insight, correction, preference, or rule to remember |
| category | select | No | Type of learning |

## Runtime Prompt

- Current runtime prompt length: 1153 characters.
- Runtime prompt is defined directly in `../learn.json`. 
