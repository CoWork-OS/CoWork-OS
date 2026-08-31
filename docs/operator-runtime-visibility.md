# Operator Runtime Visibility

Operator Runtime Visibility is the productized surface for the learning-loop, recall, command-tool, terminal, and router work that now ships in CoWork OS. The goal is not to add a second learning system. It is to make the existing memory, Dreaming, playbook, skill-promotion, command-tool, terminal, and routing subsystems visible after every task, while keeping CoWork OS centered on its core surfaces: desktop control plane, channels, inbox, devices, and governed automation.

## What users see

### 1. Task learning is visible

Every task completion now emits a standardized learning event that can show:

- memory captured or skipped
- Dreaming candidates proposed from recent memory/session evidence
- playbook reinforcement or no-op
- skill proposal created, approved, rejected, or pending review
- evidence links behind each step
- Chronicle-backed `screen_context` evidence when a task used recent-screen context
- a dedicated **Chronicle screen context used** learning-progress step
- next action when human review is needed
- semantic tool-batch labels and verifier verdict/report fields when the task completed through the delegated runtime

The task detail panel in Mission Control is the primary surface for this progression. The same event stream also feeds activity feeds and task history so learning is visible outside the task panel.

### 2. Recall is unified

Recall now behaves like one search surface instead of several separate searches. The default experience is “search everything” across:

- tasks
- task messages
- files
- workspace notes
- memory entries
- screen context
- knowledge-graph context

Results are normalized into one envelope with source type, object id, timestamp, rank, and snippet. The same ranking and dedup logic powers both the UI and prompt/context injection so operator search and runtime recall stay aligned.

### 3. Command-tool and terminal sessions keep operator state

Persistent shell sessions and real terminal tabs are first-class operator workflows:

- cwd, environment deltas, aliases, and session state are retained per task/workspace
- commands can run in a long-lived session instead of starting from a fresh process every time
- reset and new-session controls remain available
- one-shot shell execution stays as the fallback path for commands that are incompatible or unsafe for persistent sessions
- lifecycle events are auditable and recoverable
- humans can open multiple xterm.js + node-pty terminal tabs in the workspace for direct interactive CLI work
- terminal tabs support native shell editing, Tab completion, arrows, Ctrl+C, interactive prompts, resizing, and close controls

This makes long-running terminal work feel like a real session instead of a chain of unrelated commands, and it keeps direct CLI operations inside the same super-app workspace as agent tasks, artifacts, browser testing, approvals, and memory.

Agent command-tool calls and terminal tabs still use the active [access
profile](access-profiles.md). The profile is visible in task/runtime metadata,
and changing to a narrower profile prevents further agent command use without
changing the human terminal's direct-control semantics.

### 4. Routing decisions are legible

The task UI now exposes live provider/model state so users can see:

- active provider
- active model
- routing reason
- fallback chain
- whether a retry or fallback occurred
- which skills were shortlisted for this task
- which skills were actually applied
- follow-up trigger messages and summary-mode completion relays for delegated or orphaned follow-up work

Automatic routing remains automatic, but it is now observable by default. Manual overrides and multi-LLM judge flows are still supported.

### 5. Applied skills stay separate from the task request

Skill execution is now visible without obscuring the original task:

- the task header and initial user bubble continue to show the canonical prompt
- applied skills render in a separate **Applied skills** surface
- runtime events explain whether a skill was shortlisted, applied, reused, or blocked
- skill guidance is additive context, not a hidden rewritten task prompt

This is important for trust. Operators can tell what they asked for, what skills CoWork layered on top, and why.

## What stays core to CoWork OS

Operator Runtime Visibility is an observability and operator-experience upgrade, not a replacement for the existing product identity.

CoWork OS still centers on:

- desktop control plane (including **computer use**: governed `screenshot`/`click`/`type_text` sessions with platform helpers and **Esc** abort — see [Computer use](computer-use.md))
- channels and inbox
- devices and remote execution
- governed automation and approvals
- local-first execution and security-first defaults

The new surfaces make the runtime easier to trust and understand without changing the underlying product model.

Chronicle is part of this visibility story:

- it does **not** create a second memory subsystem
- Dreaming candidates stay in the same memory-review model instead of becoming a separate memory subsystem
- it makes recent-screen evidence inspectable when it influenced a task
- it keeps passive raw frames local and ephemeral, while promoted task-used observations appear as normal runtime evidence and recall
- when background Chronicle memory generation is enabled, the resulting `screen_context` memories stay visible through the same memory and recall surfaces instead of a Chronicle-only UI

## Related docs

- [Computer use](computer-use.md)
- [Terminal Tabs](terminal-tabs.md)
- [Chronicle](chronicle.md)
- [Dreaming](dreaming.md)
- [Features](features.md)
- [Skills Runtime Model](skills-runtime-model.md)
- [Mission Control](mission-control.md)
- [Evolving Agent Intelligence](evolving-agent-intelligence.md)
- [OpenClaw / CoWork comparison](openclaw-comparison.md)
- [Changelog](changelog.md)
