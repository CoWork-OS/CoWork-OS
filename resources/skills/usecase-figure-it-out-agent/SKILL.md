---
name: usecase-figure-it-out-agent
description: "Run resilient multi-tool problem solving with explicit fallback strategy and auditable execution notes."
---

# Figure It Out Agent

## Purpose

Run resilient multi-tool problem solving with explicit fallback strategy and auditable execution notes.

## Routing

- Use when: Use when the user asks to solve a task autonomously with fallback behavior when tools fail.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Figure It Out Agent: attempt log, verified result status, and fallback handoff plan when blocked.
- Success criteria: Applies explicit fallback logic, reports evidence-based outcomes, and preserves approval boundaries for risky actions.

## Trigger Examples

### Positive

- Use the usecase-figure-it-out-agent skill for this request.
- Help me with figure it out agent.
- Use when the user asks to solve a task autonomously with fallback behavior when tools fail.
- Figure It Out Agent: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-figure-it-out-agent for unrelated requests.
- This request is outside figure it out agent scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| objective | string | Yes | Task objective to complete |
| fallback_budget | number | No | Maximum fallback attempts after primary attempt |
| external_action_policy | select | No | Policy for external irreversible actions |
| completion_bar | select | No | How strict to be before calling task complete |

## Runtime Prompt

- Current runtime prompt length: 1160 characters.
- Runtime prompt is defined directly in `../usecase-figure-it-out-agent.json`. 
