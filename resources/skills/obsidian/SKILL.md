---
name: obsidian
description: "Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli."
---

# Obsidian

## Purpose

Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli.

## Routing

- Use when: Use when the user asks to work with Obsidian vaults plain Markdown notes and automate via obsidian-cli.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Obsidian: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the obsidian skill for this request.
- Help me with obsidian.
- Use when the user asks to work with Obsidian vaults plain Markdown notes and automate via obsidian-cli.
- Obsidian: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use obsidian for unrelated requests.
- This request is outside obsidian scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1952 characters.
- Runtime prompt is defined directly in `../obsidian.json`. 
