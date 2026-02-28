---
name: dependency-check
description: "Audit dependencies for updates and vulnerabilities"
---

# Dependency Check

## Purpose

Audit dependencies for updates and vulnerabilities

## Routing

- Use when: Use when requested to inspect dependency freshness, vulnerabilities, or deprecated packages.
- Do not use when: Don't use for single-file code changes without project dependency context.
- Outputs: Dependency audit table with stale versions, risk flags, and safe upgrade notes.
- Success criteria: Identifies package manager, flags vulnerability and deprecation signals, and gives practical upgrade sequencing.

## Trigger Examples

### Positive

- Use the dependency-check skill for this request.
- Help me with dependency check.
- Use when requested to inspect dependency freshness, vulnerabilities, or deprecated packages.
- Dependency Check: provide an actionable result.

### Negative

- Don't use for single-file code changes without project dependency context.
- Do not use dependency-check for unrelated requests.
- This request is outside dependency check scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 501 characters.
- Runtime prompt is defined directly in `../dependency-check.json`. 
