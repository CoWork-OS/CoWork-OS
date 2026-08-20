---
name: simplify
description: "Improve existing work with focused simplification passes across code, writing, research, operations, or general tasks."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Simplify

## Purpose

Improve existing work quality while preserving intent and behavior.

## Routing

- Use when: Use when the user asks to simplify or tighten existing outputs, code, docs, reports, plans, or runbooks without changing core intent.
- Do not use when: Do not use when the user requests net-new content generation from scratch or asks for parallel migrations across many independent targets (use batch).
- Outputs: A simplified, higher-signal result plus explicit before/after deltas and tradeoffs.
- Success criteria: The output is materially clearer or leaner while preserving original intent/behavior and keeping changes verifiable.

## Trigger Examples

### Positive

- Run /simplify on this patch and make it cleaner without changing behavior.
- Tighten this report, then run /simplify.
- Simplify this runbook for on-call use.
- Use simplify to reduce noise in this proposal.

### Negative

- Migrate 300 files from one framework to another in parallel.
- Create a new strategy memo from scratch on a topic we have not covered.
- Install and configure a brand new integration end-to-end.
- Use batch for broad multi-target migrations instead of simplify.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| objective | string | No | What to simplify; if empty, use current task context |
| domain | select | No | Task domain |
| scope | select | No | Simplification scope |

## Guidance

- Read [references/full-guidance.md](references/full-guidance.md) for domain-specific pass checklists and output templates.
- Preserve behavior/meaning by default; optimize clarity and maintainability.

## Runtime Prompt

- Runtime prompt is defined in `../simplify.json`.
