# Runtime Migration Session Notes

This note records the implementation work completed in this session so the current codebase state is documented in one place.

## What changed

### Shared turn runtime
- Added a canonical `TurnKernel` for task steps, follow-ups, chat-mode child turns, subagents, and verification flows.
- Moved turn progression, recovery, and completion ownership into the kernel so executor paths no longer duplicate the same iteration logic.
- Unified follow-up completion handling so terminal state, completion fields, and the triggering follow-up text are persisted together.

### Tool scheduling
- Added a metadata-driven `ToolScheduler` with explicit scheduler specs and scope resolution.
- Concurrency-safe read tools batch together automatically while conflicting or write-scoped tools serialize.
- Tool execution preflight, ordering, and post-batch result projection now flow through one scheduler entrypoint.

### Graph-backed orchestration
- Added a normalized orchestration graph engine and persistence layer for delegated work.
- `spawn_agent`, `orchestrate_agents`, workflow phase runs, collaborative team runs, and ACP task delegation now resolve through graph-backed dispatch and status projection.
- Graph node state and timeline events are now the source of truth for delegated work instead of scattered one-off execution paths.

### Worker roles, verification, and summaries
- Added internal worker roles for `researcher`, `implementer`, `verifier`, and `synthesizer`.
- Replaced the lightweight verification flow with a stricter read-only verifier that emits a normalized verdict and report.
- Added semantic tool-batch summaries so completed batches can show a concise label alongside the structured timeline row.

### Completion and UI projection
- Completion relays now compose from `resultSummary`, semantic batch summaries, and verifier output.
- Task completion views now surface follow-up trigger text, semantic summaries, verifier verdicts, and verification reports.
- Screenshot-heavy visual refinement loops render more compactly in summary mode so the task feed stays readable.

## User-visible effects

- Follow-up messages such as `open the webpage in canvas` are now visible in the timeline as explicit follow-up events.
- Long-running Canvas refinement work still produces multiple snapshots when the agent is iterating, but the UI now collapses screenshot output more gracefully.
- Sidebar task state and task-detail completion state now stay aligned after follow-up completion.

## Related docs

- [Architecture](../architecture.md)
- [Project Status](../project-status.md)
- [Agent Teams Contract](../agent-teams-contract.md)
- [Live Canvas](../live-canvas.md)
- [Operator Runtime Visibility](../operator-runtime-visibility.md)
- [Mission Control](../mission-control.md)
