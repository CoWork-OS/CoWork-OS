---
name: codex-cli
description: "Run OpenAI Codex CLI as a background agent — detect, install, configure, and execute tasks via codex exec."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# codex-cli

## Purpose

Detect, install, configure, and run the OpenAI Codex CLI (`codex`) as an autonomous background agent for code editing, PR review, issue fixing, and one-shot automation tasks.

## Routing

- Use when: User wants to run Codex CLI, asks for "codex agent", "spin up codex", "codex review", "codex fix", or wants to execute a coding task using the OpenAI Codex CLI specifically.
- Do not use when: The request is for planning, discussion, or non-executable output.
- Outputs: Task result from Codex CLI agent, or setup instructions if CLI is not installed/configured.
- Success criteria: Codex CLI executes the requested task and returns output, or user is guided to install/configure it.

## Trigger Examples

### Positive

- "Spin up a Codex agent to review PR #55"
- "Use Codex CLI to fix this bug"
- "Run codex on this issue"
- "Launch a codex agent"
- "codex exec: add error handling to the API"

### Negative

- "Review this code" (generic — doesn't specify Codex CLI)
- "Explain how Codex works" (no execution needed)
- "Write a plan for this feature" (planning only)

## Runtime Prompt

- Runtime prompt is defined directly in `../codex-cli.json`.
