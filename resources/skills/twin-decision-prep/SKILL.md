---
name: twin-decision-prep
description: "Assemble data, options, and analysis for a pending decision. Presents trade-offs and recommendations without making the decision. Used by digital twin personas to reduce decision fatigue."
---

# Decision Preparation Package

## Purpose

Assemble data, options, and analysis for a pending decision. Presents trade-offs and recommendations without making the decision. Used by digital twin personas to reduce decision fatigue.

## Routing

- Use when: Use when preparing analysis for a decision, architecture choice, technology selection, or any trade-off evaluation.
- Do not use when: Don't use when the user has already made a decision and just needs implementation help.
- Outputs: Structured decision package with options, trade-offs, and recommendation
- Success criteria: Package presents clear options with honest trade-offs and sufficient data for an informed decision

## Trigger Examples

### Positive

- Use the twin-decision-prep skill for this request.
- Help me with decision preparation package.
- Use when preparing analysis for a decision, architecture choice, technology selection, or any trade-off evaluation.
- Decision Preparation Package: provide an actionable result.

### Negative

- Don't use when the user has already made a decision and just needs implementation help.
- Do not use twin-decision-prep for unrelated requests.
- This request is outside decision preparation package scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| decision_topic | string | Yes | The decision to prepare for (e.g., 'Migrate from REST to GraphQL', 'Choose between Redis and Memcached for caching') |
| num_options | select | No | Number of options to analyze |

## Runtime Prompt

- Current runtime prompt length: 1027 characters.
- Runtime prompt is defined directly in `../twin-decision-prep.json`. 
