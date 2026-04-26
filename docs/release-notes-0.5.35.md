# Release Notes 0.5.35

This page summarizes the product and engineering changes included in `0.5.35`, following `v0.5.34`.

## Summary

Release `0.5.35` expands CoWork's durable runtime model in three visible directions: reusable managed agents, optional external-memory integration through Supermemory, and much better trace/debug visibility for task execution. It also simplifies the main-task turn-budget model, adds a new bundled `novelist` skill, improves task-event playback and daily briefing quality, and fixes the clean-install regression that had broken `npm run release:smoke`.

## New Features

- **Managed Agents and Managed Sessions**: CoWork now includes a first-class managed-agent layer with versioned definitions, durable managed-session plumbing, control-plane methods/events, and Mission Control/runtime surfaces that observe the same underlying task graph. [Learn more](managed-agents.md)
- **Optional Supermemory integration**: Supermemory can now operate as an external memory lane with setup flows, tool handlers, runtime metadata, policy exposure, Memory Hub controls, and prompt-time profile context injection while CoWork's local memory system remains primary. [Learn more](supermemory.md)
- **Task Trace Debugger**: the app now ships with a trace-debugger surface for inspecting task trace requests, projections, formatting, and renderer-side trace tabs. This makes runtime reasoning and failure triage much more visible during long or complex tasks.
- **Bundled `novelist` skill**: the default skill bundle now includes a novelist workflow and related starter-mission support for narrative and long-form drafting use cases.
- **CoWork School**: the docs now include a beginner-friendly [CoWork School guide](cowork-school.md) to help users ramp into the product's runtime model and core workflows more quickly.

## Enhancements

- **Explicit-only turn budgets**: main interactive tasks no longer inherit implicit strategy-derived `maxTurns` windows. Tasks are uncapped by default unless a flow sets `maxTurns` or `windowTurnCap` explicitly, while lifetime safety fuses and existing recovery safeguards stay in place. [Learn more](execution-runtime-model.md)
- **Clearer runtime ownership and telemetry**: runtime/session docs and telemetry now distinguish explicit capped runs from default-unbounded execution more clearly, which makes Mission Control, support, and debugging output more truthful. [Learn more](session-runtime.md)
- **Renderer task-event playback**: task-event handling now batches, throttles, derives replacement state more aggressively, and includes perf-oriented fixture coverage so larger task histories remain smoother to browse and replay.
- **Mission Control and settings surfaces**: Mission Control board actions, labels, and card summaries were refreshed, and Settings/Memory Hub now expose Supermemory controls, trace-debugger settings, and provider-specific failover controls more cleanly.
- **Workflow Intelligence documentation**: the former Subconscious concept is now documented as Workflow Intelligence: Memory as source of truth, Heartbeat as scheduler, Reflection as internal evaluation, and Suggestions as the reviewable user-facing output. [Learn more](workflow-intelligence.md)
- **Briefing quality**: daily briefings now prioritize higher-signal context and filter low-signal automation noise more aggressively, so summary output stays closer to what operators actually need.
- **Provider failover configuration**: the LLM stack and settings surface now support provider-specific failover chains and clearer failover behavior.
- **Release validation**: packaging guidance and artifact checks now better enforce consistent release filenames and local installer validation.

## Fixes

- **Clean release smoke installs**: the Electron runtime was restored to installed dependencies so `npm run release:smoke` no longer falls back into dependency bootstrap during a clean consumer install.
- **Chat-session MCP discovery**: MCP tool discovery now works correctly inside chat sessions.
- **Workspace path recovery**: stale absolute file paths can now be remapped into the active workspace more reliably during file reads.
- **Executor/runtime edge cases**: completion evidence handling, pending skill-parameter handling, iCloud execution routing, and permissive JSON Schema handling for tool definitions were tightened.
- **Remote shadow-task cleanup**: remote task pruning now deletes only rows that are actually covered by the fetched remote window.

## Upgrade Notes

- Long-running main tasks now behave differently by default: unless a workflow explicitly sets `maxTurns` or `windowTurnCap`, the run is treated as uncapped and governed by lifetime and recovery safeguards instead of an implicit turn window.
- Supermemory remains optional and additive. Existing local memory, recall, and prompt behavior continue to work without it.
- Local macOS packaging on machines without `Developer ID Application` credentials or notarization environment variables still produces ad hoc signed validation builds rather than notarized distribution builds.

## References

- [Changelog](changelog.md) - full version history
- [Managed Agents](managed-agents.md) - managed agent lifecycle and runtime model
- [Supermemory](supermemory.md) - external memory integration
- [Workflow Intelligence](workflow-intelligence.md) - always-on memory, heartbeat, reflection, suggestions, and feedback learning
- [Execution Runtime](execution-runtime-model.md) - task execution and turn-budget behavior
- [Session Runtime](session-runtime.md) - ownership and task-session state model

This page is the canonical high-level summary for the changes included in `0.5.35`.
