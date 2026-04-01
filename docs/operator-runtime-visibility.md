# Operator Runtime Visibility

Operator Runtime Visibility is the productized surface for the learning-loop, recall, shell, and router work that now ships in CoWork OS. The goal is not to add a second learning system. It is to make the existing memory, playbook, skill-promotion, and routing subsystems visible after every task, while keeping CoWork OS centered on its core surfaces: desktop control plane, channels, inbox, devices, and governed automation.

## What users see

### 1. Task learning is visible

Every task completion now emits a standardized learning event that can show:

- memory captured or skipped
- playbook reinforcement or no-op
- skill proposal created, approved, rejected, or pending review
- evidence links behind each step
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
- knowledge-graph context

Results are normalized into one envelope with source type, object id, timestamp, rank, and snippet. The same ranking and dedup logic powers both the UI and prompt/context injection so operator search and runtime recall stay aligned.

### 3. Shell sessions keep operator state

Persistent shell sessions are now a first-class operator workflow:

- cwd, environment deltas, aliases, and session state are retained per task/workspace
- commands can run in a long-lived session instead of starting from a fresh process every time
- reset and new-session controls remain available
- one-shot shell execution stays as the fallback path for commands that are incompatible or unsafe for persistent sessions
- lifecycle events are auditable and recoverable

This makes long-running terminal work feel like a real session instead of a chain of unrelated commands.

### 4. Routing decisions are legible

The task UI now exposes live provider/model state so users can see:

- active provider
- active model
- routing reason
- fallback chain
- whether a retry or fallback occurred
- follow-up trigger messages and summary-mode completion relays for delegated or orphaned follow-up work

Automatic routing remains automatic, but it is now observable by default. Manual overrides and multi-LLM judge flows are still supported.

## What stays core to CoWork OS

Operator Runtime Visibility is an observability and operator-experience upgrade, not a replacement for the existing product identity.

CoWork OS still centers on:

- desktop control plane (including **macOS computer use**: governed `computer_*` sessions with overlay, **Esc** abort, and per-app consent — see [Computer use (macOS)](computer-use.md))
- channels and inbox
- devices and remote execution
- governed automation and approvals
- local-first execution and security-first defaults

The new surfaces make the runtime easier to trust and understand without changing the underlying product model.

## Related docs

- [Computer use (macOS)](computer-use.md)
- [Features](features.md)
- [Mission Control](mission-control.md)
- [Evolving Agent Intelligence](evolving-agent-intelligence.md)
- [OpenClaw / CoWork comparison](openclaw-comparison.md)
- [Changelog](changelog.md)
