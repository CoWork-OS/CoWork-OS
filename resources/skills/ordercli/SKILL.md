---
name: ordercli
description: "Foodora-only CLI for checking past orders and active order status (Deliveroo WIP)."
---

# Ordercli

## Purpose

Foodora-only CLI for checking past orders and active order status (Deliveroo WIP).

## Routing

- Use when: Use when the user asks to foodora-only CLI for checking past orders and active order status Deliveroo WIP.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Ordercli: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the ordercli skill for this request.
- Help me with ordercli.
- Use when the user asks to foodora-only CLI for checking past orders and active order status Deliveroo WIP.
- Ordercli: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use ordercli for unrelated requests.
- This request is outside ordercli scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1606 characters.
- Runtime prompt is defined directly in `../ordercli.json`. 
