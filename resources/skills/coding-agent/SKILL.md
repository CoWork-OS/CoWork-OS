---
name: coding-agent
description: "Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control."
---

# Coding-agent

## Purpose

Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.

## Routing

- Use when: Use when the user asks to run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Outputs: Outcome from Coding-agent: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the coding-agent skill for this request.
- Help me with coding-agent.
- Use when the user asks to run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control.
- Coding-agent: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Do not use coding-agent for unrelated requests.
- This request is outside coding-agent scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 982 characters.
- Runtime prompt is defined directly in `../coding-agent.json`. 
