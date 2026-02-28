---
name: security-audit
description: "Check code for common security vulnerabilities"
---

# Security Audit

## Purpose

Check code for common security vulnerabilities

## Routing

- Use when: Use when the user asks to check code for common security vulnerabilities.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Security Audit: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the security-audit skill for this request.
- Help me with security audit.
- Use when the user asks to check code for common security vulnerabilities.
- Security Audit: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use security-audit for unrelated requests.
- This request is outside security audit scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to file or folder to audit |

## Runtime Prompt

- Current runtime prompt length: 497 characters.
- Runtime prompt is defined directly in `../security-audit.json`. 
