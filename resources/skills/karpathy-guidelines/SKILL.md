---
name: karpathy-guidelines
description: "Surgical execution guardrails for coding, debugging, review, and refactor tasks"
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Surgical Task Guidelines

## Purpose

Keep execution scoped, simple, and verifiable for coding, debugging, review, refactor, and file-editing tasks.

## Routing

- Use when: Use for coding, debugging, review, refactor, build, test, release, or file-editing tasks where scope control and verification matter.
- Do not use when: Do not use for pure brainstorming, broad strategy, or requests where the user explicitly asks for expansive ideation rather than execution.
- Outputs: A focused task result with assumptions, scoped changes, verification evidence, and unrelated issues kept separate.
- Success criteria: The result satisfies the user's request with minimal relevant changes, no drive-by edits, and clear verification evidence.

## Trigger Examples

### Positive

- Use the karpathy-guidelines skill for this request.
- Fix this bug without refactoring unrelated modules.
- Review this patch and point out overcomplicated or unnecessary changes.
- Refactor this file surgically while preserving behavior.
- Implement this feature and verify the narrowest relevant test passes.

### Negative

- Brainstorm ten moonshot product directions.
- Write a broad strategy memo with multiple speculative options.
- Do not use karpathy-guidelines for unrelated requests.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 621 characters.
- Runtime prompt is defined directly in `../karpathy-guidelines.json`. 
