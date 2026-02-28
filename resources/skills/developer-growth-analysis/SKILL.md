---
name: developer-growth-analysis
description: "Analyze recent coding patterns and generate a personalized developer growth report."
---

# developer-growth-analysis

## Purpose

Analyze recent coding patterns and generate a personalized developer growth report.

## Routing

- Use when: Use when the user asks to analyze recent coding patterns and generate a personalized developer growth report.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from developer-growth-analysis: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the developer-growth-analysis skill for this request.
- Help me with developer-growth-analysis.
- Use when the user asks to analyze recent coding patterns and generate a personalized developer growth report.
- developer-growth-analysis: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use developer-growth-analysis for unrelated requests.
- This request is outside developer-growth-analysis scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 897 characters.
- Runtime prompt is defined directly in `../developer-growth-analysis.json`. 
