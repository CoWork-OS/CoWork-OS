# CoWork OS Architecture

CoWork OS is a local-first desktop runtime for AI-assisted task execution, background operator loops, and multi-surface automation.

## Core Architecture

- **Electron main process**: task orchestration, agent runtime, heartbeat orchestration, IPC, and tool execution
- **React renderer**: desktop UI, Mission Control, task timeline, settings, and monitoring surfaces
- **Tool and connector layer**: file, shell, browser, web, native integrations, MCP connectors, and remote execution
- **Local persistence**: SQLite, local files, knowledge graph state, run records, and workspace-kit contracts in `.cowork/`
- **Runtime visibility surfaces**: the task runtime emits learning progression, unified recall, persistent shell, and live routing events into Mission Control and the renderer so operator state stays visible instead of hidden in services
- **Completion hardening**: verified-mode evidence bundles, step-intent alignment/decomposition heuristics, and read-only entropy sweeps make completion checks more explicit without mutating the task's final result

## Heartbeat V3

Heartbeat v3 is the default background automation architecture.

- **Signal ledger**: ambient changes, mentions, manual wakes, and awareness events emit normalized heartbeat signals instead of accumulating raw wake requests
- **Pulse**: cheap, deterministic, non-LLM state reduction that evaluates merged signals, due proactive work, checklist cadence, foreground contention, and dispatch guardrails
- **Dispatch**: escalation lane invoked only when Pulse decides the situation warrants user-visible or task-visible work
- **Run records**: every Pulse and Dispatch execution is tracked, and any heartbeat-created task is linked back to its originating heartbeat run
- **Defer and compress**: foreground manual work suppresses churn by compressing pending signals into resumable deferred state instead of growing a queue

See [Heartbeat v3](heartbeat-v3.md) for the detailed runtime contract.

## Workspace Kit

The `.cowork/` workspace kit holds durable human-edited operating context.

- `BOOTSTRAP.md` is a one-time onboarding checklist
- `HEARTBEAT.md` is reserved for recurring heartbeat checklist work
- project-scoped context lives under `.cowork/projects/<projectId>/`

## Repo Landmarks

- `src/electron/`: main-process runtime, services, database, scheduling, monitoring
- `src/renderer/`: React UI and settings surfaces
- `src/shared/`: shared contracts and types
- `docs/`: product and architecture documentation
- `.cowork/`: local workspace operating context

## Update Rule

If defaults, behavior, or architecture change, update this file in the same PR.
