# Release Notes 0.5.23

This page summarizes the product and engineering changes included in `0.5.23`, following `v0.5.22`.

## Overview

Release `0.5.23` expands CoWork in three main directions: a new **Subconscious reflective loop** for ongoing automation and learning, a deeper **execution/runtime refresh** centered on provider-aware prompt caching and adaptive output budgeting, and stronger **managed capability security** for imported skills and plugin packs. It also broadens **Usage Insights**, improves provider setup and failover behavior, and refreshes the desktop UI around settings and approvals.

## What changed

### Subconscious reflective loop

- **New reflective subsystem**: CoWork now includes a dedicated subconscious runtime with persisted targets, backlog items, critiques, dispatch records, and run history.
- **Artifact storage**: subconscious runs can persist rendered backlog, winner summaries, JSONL artifacts, and other run outputs through a dedicated artifact store.
- **Migration and settings support**: new migration and settings-manager layers support rollout of the subconscious subsystem without relying on the older self-improvement paths.
- **Renderer and preload wiring**: the desktop app now exposes subconscious APIs and a dedicated settings panel so the reflective loop can be configured directly from the UI.
- **Terminology cleanup**: user-facing docs and settings now consistently describe the reflective automation layer as `Subconscious` instead of the older self-improvement language.

### Runtime, prompts, and provider routing

- **Provider-aware prompt caching**: stable prompt sections can now be cached across Anthropic, OpenRouter Claude, Azure OpenAI, and OpenAI-family routes.
- **Adaptive output budgeting**: the runtime now classifies output truncation, infers request kinds, and chooses output-token limits by provider family to reduce avoidable max-token failures.
- **Prompt-aware tool descriptions**: built-in tools now render different prompt text for planning vs execution from one shared metadata source.
- **Prompt section reuse**: execution prompts now rely on cache-aware session and turn sections with explicit hashing and render-state tracking in `SessionRuntime`.
- **Scoped system-message handling**: Anthropic, OpenAI, Azure OpenAI, and OpenRouter providers now normalize scoped system blocks and usage reporting more consistently.
- **Failover stability**: fallback chains now preserve cached metadata and honor the retry-to-primary cooldown more reliably after a provider error.
- **Anthropic subscription-token support**: Anthropic credential flows and related vision tooling now support subscription-token-based setups alongside API-key routes.

### Managed capability security

- **Shared import security gate**: imported skills and plugin packs now go through the same install-time scanning and reporting flow.
- **Quarantine flow**: imports that fail structural or content checks can be quarantined instead of being activated immediately.
- **Persisted security reports**: loader, installer, registry, IPC, and renderer surfaces now share stored security outcomes instead of deriving status ad hoc.
- **Import approval tracking**: file-based capability imports now use explicit approval tracking with expiration and bounded retention.
- **Discovery-time rechecks**: managed imports can be revalidated on load so tampered bundles are surfaced and quarantined consistently.

### Usage Insights and reporting

- **Incremental projector**: Usage Insights now has a projector/backfill layer for derived metrics and incremental refresh.
- **Richer LLM reporting**: provider scans, retry metrics, normalized provider names, and new chart/period helpers deepen the LLM reporting surface.
- **Shared formatting utilities**: formatting and period-selection logic were extracted so renderer usage views stay consistent.

### Desktop UI and operator experience

- **Settings refresh**: settings were restructured around LLM provider helpers, fallback behavior, import security states, and subconscious controls.
- **Approval dialog previews**: command approvals now show safer, truncated previews for long or multiline commands.
- **Skill and plugin install surfaces**: the Skill Hub, Customize panel, and Plugin Store now expose quarantine state, retry actions, and security-specific install messaging.
- **Usage Insights UI updates**: charts, provider rows, and preset selection were refreshed for the expanded metrics model.

## Fixes

- **OpenRouter attribution consistency**: request headers now use one normalized attribution header set across OpenRouter calls.
- **Fallback-route stability**: retryable provider failures no longer bounce back to the primary route too aggressively.
- **LLM settings persistence**: saving settings now preserves fallback chains, retry cooldowns, and cached model metadata more reliably.
- **Tool-result envelope validity**: model reminders no longer break JSON-shaped tool result payloads.
- **Approval preview overflow**: long commands no longer spill raw multiline shell text directly into approval dialogs.
- **Managed import integrity**: imported capability bundles are checked more consistently so modified installs can be quarantined before activation.
- **Reflective task cleanup**: deleting tasks now clears subconscious references tied to those tasks.
- **Empty follow-up end turns**: follow-up loops now retry empty `end_turn` responses instead of silently finalizing, and repeated empty follow-up responses now surface as provider errors.

## Testing and internal work

- Added or expanded unit coverage for prompt caching, output-token policy, provider routing, usage telemetry, runtime permission behavior, subconscious services, task repository cleanup, approval command previews, and renderer helper modules.
- Runtime plumbing was expanded across executor, daemon, IPC, preload, provider factory, tool registry, secure settings, schema migrations, and shared types to support the new prompt/runtime/security model.

## Documentation

- Added new docs for the execution runtime, subconscious loop, reflective learning positioning, reliability flywheel updates, and import trust boundaries.
- Refreshed README, features, getting started, providers, plugin packs, session runtime, troubleshooting, project status, and related comparison pages to match the current product surface.
- Removed the legacy self-improving-agent doc in favor of the new subconscious-loop documentation set.

## Upgrade notes

- Existing users keep their current provider settings, but the LLM settings surface now stores additional prompt-cache and fallback metadata.
- Managed imported skills and plugin packs may surface new warnings or quarantine states after upgrade if their bundle contents no longer match the recorded install-time security outcome.
- The reflective automation surface is now documented and surfaced as `Subconscious`; older self-improvement terminology is being phased out in docs and settings.

## References

- [Changelog](changelog.md) — full version history
- [Execution Runtime Model](execution-runtime-model.md) — prompt sections, caching, and execution flow
- [Session Runtime](session-runtime.md) — runtime ownership and prompt-cache state
- [Subconscious Loop](subconscious-loop.md) — reflective automation architecture
- [Providers](providers.md) — provider behavior, caching, and routing details
- [Plugin Packs](plugin-packs.md) — managed import and quarantine behavior

This page is the canonical high-level summary for the changes included in `0.5.23`.
