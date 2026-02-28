---
name: tmux
description: "Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output."
---

# Tmux

## Purpose

Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.

## Routing

- Use when: Use when the user asks to remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Outputs: Outcome from Tmux: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the tmux skill for this request.
- Help me with tmux.
- Use when the user asks to remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output.
- Tmux: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead. Avoid using in non-interactive environments unless automation can fully satisfy prompts.
- Do not use tmux for unrelated requests.
- This request is outside tmux scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 3942 characters.
- Runtime prompt is defined directly in `../tmux.json`. 
