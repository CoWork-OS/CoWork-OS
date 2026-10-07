# Release Notes 0.5.12

This page summarizes the product changes included in `0.5.12`, based on changes merged after `v0.5.11` on 2026-03-20.

## Overview

The 0.5.12 release restructures the heartbeat system into a signal-driven Pulse/Dispatch pipeline, introduces the Ideas panel as a curated workflow entry point, adds Azure Anthropic as a new built-in provider, expands image generation routing to OpenRouter, adds document editing sessions and video generation, and tightens task routing, memory compression, and agent execution throughout.

## What Changed

### Heartbeat v3

- **Pulse/Dispatch pipeline**: the heartbeat system now runs two lanes. `Pulse` evaluates heartbeat state cheaply without LLM calls and returns a signal (`idle`, `deferred`, `suggestion`, `dispatch_task`, `dispatch_runbook`, or `handoff_to_cron`). `Dispatch` only runs when Pulse asks for escalation — a passive next-heartbeat wake alone no longer creates tasks.
- **Signal ledger**: event producers emit normalized heartbeat signals instead of raw wake requests. Signals carry scope, family, source, fingerprint, urgency, confidence, and expiry. Signals with the same fingerprint merge rather than accumulate, keeping ambient file, git, and awareness activity cheap.
- **Deferred-state compression**: when a user-facing task is active for the same workspace, Pulse records a deferred state and compresses pending signals into a resumable summary. This eliminates unbounded wake queue growth and repeated low-value wakes during active user work.
- **Run tracking**: every Pulse and every Dispatch gets a run record. Heartbeat tasks carry a `heartbeatRunId` for traceability.
- **Heartbeat profiles**: execution behavior is now controlled by `heartbeatProfile` — `observer` (awareness only), `operator` (awareness plus maintenance and suggestions), or `dispatcher` (full escalation with task/runbook/cron handoff).
- **Dispatch guardrails**: one in-flight dispatch per agent/workspace, cooldown after success, daily dispatch budget via `maxDispatchesPerDay`, and evidence-ref requirements before task creation.
- **Foreground suppression**: heartbeats automatically pause during active foreground tasks; manual `wake now` remains available as an override.
- **Mission Control status**: the operator surface now reports last pulse result, last dispatch result, deferred state, compressed signal count, due proactive count, dispatch cooldown, and budget state.

See [Heartbeat v3](heartbeat-v3.md) for the full architecture reference.

### New UI surfaces

- **Ideas panel**: a curated launch panel accessible from the sidebar above Sessions. Displays pre-written workflow prompts organized by category. Includes an `/ideas` gateway route for deep-linking. (Since replaced by the use-case gallery.)
- **Mission Control task controls**: start, pause, stop, and retry actions for tasks are now accessible directly from Mission Control without navigating to the individual task view.

### New providers and model capabilities

- **Azure Anthropic provider**: Azure-hosted Claude deployments are now a built-in provider. Configure API key, endpoint, and deployment name in Settings > LLM > Azure Anthropic. Separate from the existing Azure OpenAI provider.
- **OpenRouter image generation**: image generation requests can now be routed through OpenRouter, including preset model support for common image models.
- **Image provider ordering**: image provider selection uses a configurable priority ordering so the best available provider is chosen across Gemini, OpenAI, Azure OpenAI, and OpenRouter without manual intervention.
- **Video generation**: new provider routing layer for text-to-video and image-to-video models. Configure preferred video model in Settings > LLM. Generated videos render inline in the task feed. Includes polling tools for long-running generation jobs.
- **Automated task model routing**: automated (heartbeat/cron) tasks can now be routed to a different model than interactive tasks.

### Document and media editing

- **DOCX block replacement**: agents can replace specific content blocks in Word documents without rewriting the whole file.
- **PDF region edits**: PDF files support targeted region editing within an active document session.
- **Inline document surfaces**: documents can be opened inline within a task session for editing.
- **Version browsing**: previous document versions are accessible from the document surface.
- **Document-aware file viewing**: the file viewer surfaces the correct edit controls when an active editing session is open.

### Runtime and task execution

- **Chat mode locking**: chat-mode sessions are locked to user-configured tasks and cannot be silently upgraded to tool-using runs.
- **Execution contracts**: task execution contracts are more explicit, reducing ambiguous completion signals.
- **Strategy tool allowlists**: the task strategy layer now selects tools from a tighter allowlist appropriate for each execution mode.
- **Skill routing queries**: skill routing queries are more precise, reducing false matches on broad topics.
- **Completion contract parsing**: completion signal parsing is tighter, reducing spurious done/continue misclassifications.
- **Daemon completion flow**: the background daemon handles task completion signals more reliably.
- **Structured input handling**: structured input (multiple-choice pause prompts in plan-mode flows) is handled more robustly.
- **Child task handling**: child task lifecycle — creation, status sync, and completion — is more consistent.
- **Tool allowlist for chat tasks**: chat-mode tasks operate under a specific tool allowlist rather than inheriting the full task toolset.
- **Visual QA plan insertion**: QA plans can be inserted into the task strategy at the correct point in execution.

### Memory and context improvements

- **Batch compression**: workspace context summaries are now compressed in batches, reducing redundancy.
- **Compact workspace summaries**: workspace context is summarized compactly and preserved across session compaction.
- **Concise playbook imports**: playbook memory injection keeps entries concise to preserve budget for task context.
- **Chat prompt summarization**: imported ChatGPT history entries are summarized before injection.
- **Context summary validation**: workspace context summaries are validated for coherence before use.

### Agent and provider presentation

- **Agent role labels**: role labels are now formatted consistently across Mission Control, collaborative task headers, and agent detail views regardless of role source.
- **Provider factory routing**: the provider factory supports custom routing rules for per-provider model-pattern overrides. Azure Anthropic and OpenRouter routing are implemented as first-class factory routes.

### Documentation refresh

- **Heartbeat v3**: new comprehensive architecture doc at [docs/heartbeat-v3.md](heartbeat-v3.md).
- **Ideas capabilities**: new reference doc (since removed) listing tools and fallbacks for each Ideas panel prompt.
- **Providers**: Azure Anthropic added to the built-in providers table with a setup section.
- **Features**: Ideas panel, document editing sessions, and video generation entries added.
- **Changelog and README**: updated to reflect 0.5.12 changes.

## Notes

- Heartbeat v3 is the new default. The legacy `heartbeatIntervalMinutes` field remains as a compatibility fallback; the v3 fields (`pulseEveryMinutes`, `dispatchCooldownMinutes`, `maxDispatchesPerDay`, `heartbeatProfile`) are the source of truth.
- Video generation requires a compatible provider configured in Settings. No video provider is included by default.
- Document editing sessions require the file to be opened from the Files panel or a task artifact surface.
- This page is the canonical summary for the changes included in `0.5.12`.
