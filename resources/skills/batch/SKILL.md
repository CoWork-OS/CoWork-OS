---
name: batch
description: "Plan and execute parallel, repeatable migrations across code, docs, research artifacts, ops configs, or mixed task sets."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Batch

## Purpose

Plan and execute repeatable work across many independent targets in parallel.

## Routing

- Use when: Use when the user asks to run parallelizable migrations or repeated transformations across many independent targets in any domain.
- Do not use when: Do not use for single-target quality polishing (use simplify) or when the request is purely conceptual with no execution intent.
- Outputs: A parallel execution plan, per-target outcomes, validations, and explicit next actions.
- Success criteria: Work is partitioned, executed with bounded parallelism, validated per target, and summarized with clear blockers/safety boundaries.

## Trigger Examples

### Positive

- Use /batch migrate src/ from Solid to React.
- Run /batch to update all policy docs to the new template.
- Batch-convert these reports and validate each output.
- Apply this config migration across all environments in parallel.

### Negative

- Clean up this one function for readability.
- Improve this single memo's tone and clarity.
- Discuss migration options without executing any changes.
- Use simplify for one-off quality tuning instead of batch.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| objective | string | Yes | Batch objective to execute across multiple targets |
| domain | select | No | Task domain |
| parallel | number | No | Maximum parallel workers (1-8) |
| external | select | No | Policy for external side effects |

## Guidance

- Read [references/full-guidance.md](references/full-guidance.md) for partitioning, safety, and output structure.
- Keep legacy queue/review skills active; use this skill for broad migration-style work.

## Runtime Prompt

- Runtime prompt is defined in `../batch.json`.
