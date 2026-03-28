# Release Notes 0.5.13

This page summarizes the product changes included in `0.5.13`, based on changes merged after `v0.5.12` on 2026-03-22.

## Overview

The 0.5.13 release ships the Inbox Agent as a full AI-powered email workspace, introduces the R&D Council system for multi-LLM collaborative research, adds AcpxRuntimeRunner for Codex task execution via an external acpx binary, and brings task replay, computer use tooling, and batch image processing to the platform. On the infrastructure side it tracks and discounts prompt-cache hits in cost accounting, enriches Azure OpenAI error objects with request IDs, and sanitizes orphaned tool-call rounds from conversation history to eliminate provider errors on long runs.

## What Changed

### Inbox Agent

The Inbox Agent is now a fully wired email workspace backed by an LLM classification pipeline.

- **AI thread classification**: every mailbox thread is classified by an LLM call that returns `category`, `needsReply`, `priorityScore`, `urgencyScore`, `staleFollowup`, `cleanupCandidate`, `handled`, `confidence`, and optional `labels`. Results are fingerprinted (SHA-256 of a normalized thread snapshot) and stored alongside `classification_state`, `classification_model_key`, `classification_prompt_version`, and `classification_confidence` so threads are only re-classified when their content changes or the prompt version increments.
- **Heuristic fallback**: `deriveCategory` and `likelyNeedsReply` are improved heuristics used when an LLM provider is unavailable. `isAutomatedMailbox` and `isOnboardingMailbox` helpers detect no-reply senders, receipts, security alerts, and onboarding flows to avoid false `needsReply` flags.
- **Backfill and reclassify**: a `backfill_pending` state marks threads that existed before the classifier launched. `reclassifyThread()` and `reclassifyAccount()` allow on-demand re-classification at thread or account scope. Both are exposed to the renderer via IPC (`mailbox:reclassifyThread`, `mailbox:reclassifyAccount`) and available as agent tools.
- **HTML email rendering**: Gmail messages now capture the raw HTML body (`body_html`). The Inbox Agent panel renders email HTML inside a sandboxed `allow-same-origin` iframe that auto-sizes to content; `sanitizeEmailHtml` strips scripts, external link/style tags, tracking pixels, `@import` rules, and neutralizes form elements to prevent remote submissions.
- **Sort and filter controls**: inbox threads can be sorted by `priority` or `recent`, filtered by `mailboxView` (inbox/sent/all), `unreadOnly`, `needsReply`, `hasSuggestedProposal`, `hasOpenCommitment`, and `cleanupCandidate`. A classification pending badge in the sidebar shows how many threads are awaiting AI classification.
- **Draft style profiling**: `DraftStyleProfile` inference learns greeting, sign-off, tone, and average response time from recent outbound messages to inform draft suggestions.
- **Sync progress**: `MailboxSyncProgress` tracks the active sync phase (fetching / ingesting / classifying / done / error) with per-thread and per-message counters, surfaced in the `getSyncStatus()` status label.
- **`discard_draft` action**: agents can now explicitly discard a pending draft via the `discard_draft` mailbox action type.
- **Schedule slots**: calendar schedule proposals now emit structured `ScheduleOption` objects with `label`, `start`, and `end` ISO timestamps instead of raw slot strings.

See [Inbox Agent](inbox-agent.md) for the full architecture reference.

### R&D Council

- **CouncilService**: a new `CouncilService` manages R&D council configuration (CRUD), cron-scheduled runs, seat rotation, memo persistence, and path-safe file delivery. Council runs are tracked in `council_configs`, `council_runs`, and `council_memos` SQLite tables.
- **Multi-LLM participants**: councils assign participant seats to different LLM providers/models. `AgentConfigSchema` is extended with `MultiLlm` participant fields and an `ExternalRuntime` shape. Seat assignment uses configurable sort order; a council synthesis prompt combines participant outputs into a final memo.
- **Council Settings panel**: a new CouncilSettings panel under Automations > R&D Council lets users create and edit councils with schedule, participants, delivery mode, and seat role definitions.
- **IPC and renderer wiring**: council CRUD and memo IPC channels are exposed to the renderer via contextBridge. An error boundary wraps the council cron trigger so a misconfigured council does not crash the daemon.
- **`CHANNEL_TYPES` constant**: `ChannelType` is now derived from a single exported `CHANNEL_TYPES` const array, replacing the previously hardcoded channel-type enum.

### AcpxRuntimeRunner and Codex integration

- **AcpxRuntimeRunner**: spawns the `acpx` binary for Codex child tasks, manages session naming, argument construction, and JSON line parsing. Integrated into `TaskExecutor` with an automatic `ENOENT` fallback to native execution when the binary is not installed.
- **Runtime detection**: `spawn-agent` detects the `codex-acpx` runtime from `task.agentConfig` and `acpx_runtime` event payloads, and resolves the correct `externalRuntime` configuration.
- **`codexRuntimeMode` setting**: a new `codexRuntimeMode` selector (`native` / `acpx`) in Settings > Built-in Tools lets users opt into the acpx runtime without editing config files.

### Task Replay

- **`useReplayMode` hook**: steps through the stored event log of a completed task at a configurable speed (1×–10×), emitting events into the same UI rendering pipeline used for live runs.
- **`ReplayControlsBar`**: a play/pause/reset control bar with speed selector, rendered beneath the task timeline during replay. Replay mode is wired into the App root and passed to MainContent.
- **Timeline replay support**: the task timeline handles a `replay` flag to render historical events using the live display path, including fix for CLI child-task detection using a pre-built event map.

### Computer Use

- **Computer use tool**: a new `computer_use` tool wrapper integrates pointer/keyboard control for desktop automation tasks.
- **Permission dialog**: a dedicated permission dialog prompts for user approval before any computer use action is executed.
- **Safety overlay**: a translucent safety overlay is displayed during active computer use sessions so users can see the agent is in control and intervene.
- **Window isolation**: computer use sessions run in an isolated window context to prevent accidental interaction with other application windows.
- **Shortcut guard**: a keyboard shortcut guard blocks global hotkeys while a computer use session is active.

### Batch image processing

- **`batch_image` tool**: processes multiple images in a single tool call. Supports OCR, captioning, classification, and multi-image comparison. Integrated with the existing image provider routing layer.

### PDF review improvements

- **`ocrmypdf` integration**: when the `ocrmypdf` CLI is available and a document is detected as image-heavy, the entire PDF is passed through `ocrmypdf --skip-text --deskew --rotate-pages` before text extraction, producing higher quality OCR than page-by-page Tesseract.
- **Image-heavy detection**: `assessPdfCoverage()` measures native text density across sampled pages; a document is flagged as `imageHeavy` when coverage ratio, average chars/page, or average words/page fall below configurable thresholds.
- **`decidePdfExtractionMode()`**: selects `ocrmypdf` (whole-document OCR), `page-ocr` (per-page Tesseract), or `native` based on `ocrmypdf` availability and coverage assessment. Exposed as a named export for direct testing.
- **`extractionMode` and `imageHeavy` fields**: surfaced on `PdfReviewSummary` and passed through `DocumentEditorModal`, `FileViewer`, and `InlineDocumentPreview` so the UI can display how a document was processed.
- **Render scale**: default render scale bumped from 1400 to 1800 px for crisper OCR input.
- **Multipart/alternative preference**: `extractGmailBody` now iterates in reverse for `multipart/alternative` payloads, preferring the HTML part over plain text per RFC 2822 ordering.

### Google Workspace OAuth improvements

- **Copy-link OAuth flow**: `startGoogleWorkspaceOAuthGetLink()` starts the local callback server and returns the authorization URL immediately so users can paste it into any browser — useful when Electron cannot open a system browser. Tokens are saved automatically once the browser redirect arrives.
- **Concurrent-call guard**: a module-level `oauthGetLinkInFlight` flag prevents a second call from attempting to bind port 18766 while a listener is already active.
- **`loginHint`**: both `startGoogleWorkspaceOAuth` and `startGoogleWorkspaceOAuthGetLink` accept a `loginHint` email address that pre-selects the correct Google account on the consent screen. Validated by the IPC schema (`z.string().email().max(254)`).
- **Setup guide**: the Google Workspace settings panel now includes a step-by-step setup guide covering project creation, API enablement, OAuth consent screen configuration, test-user registration, and credential creation.

### Prompt-cache cost accounting

- **`cachedTokens` field**: `LLMResponse.usage` now includes `cachedTokens` extracted from Azure OpenAI SSE and non-streaming responses and from OpenAI-compatible provider responses.
- **Cache discount**: `calculateCost()` applies the provider's cache discount rate to cached tokens so reported costs reflect what is actually billed rather than the uncached list price.
- **Tracking**: `cachedTokens` is threaded through the adaptive-budget LLM turn helper and `updateTracking()` call sites in the executor.

### LLM and provider reliability

- **`sanitizeToolCallHistory()`**: strips assistant turns whose `tool_use` blocks have no matching `tool_result` in the following user message before serializing conversation history. Prevents "dangling tool_use" errors on OpenAI-compatible providers during long multi-tool sessions. Logs a warning with the missing IDs when a round is dropped.
- **Azure OpenAI structured errors**: `buildAzureApiError()` constructs `LLMProviderError` objects with `status`, `requestId` (from `x-ms-request-id` / `apim-request-id` headers), `providerMessage`, `providerCode`, and the raw error body, replacing three-site copy-paste error construction. `toStructuredProviderError()` forwards these fields from nested causes.
- **Logger migration**: all `console.log/warn/error` calls in `AzureOpenAIProvider` replaced with the project logger (`debug` for aborts and reasoning fallbacks, `warn` for transient errors, `error` for hard failures).

### Agent executor improvements

- **Source-coverage guard**: Daily AI Agent Trends Research tasks must collect evidence from Reddit, X/Twitter, and a tech-news source before completing. `classifyWebEvidenceSource()` labels each tracked URL by hostname; missing categories block the run with a descriptive `Task missing source coverage:` error.
- **Skill routing gate**: `getAutoRoutableSkill()` checks that the target skill still exists in the loader and still satisfies its keyword routing gate before auto-routing fires. Stale or mismatched targets log a reason and return false.
- **Task lifecycle normalization**: stale terminal state (completed/failed/cancelled tasks that were never properly closed) is reconciled on daemon startup. Collaborative tasks left in a launching state are re-launched.
- **`task-status` utility**: task lifecycle state derivation is extracted into a shared utility for consistent status normalization across the executor, repositories, and daemon.

### X Mentions reliability

- **Retry error propagation**: `fetchMentionsWithRetry` wraps the reduced-n retry in its own try/catch; timeout on the retry is now re-thrown rather than swallowed, so callers can handle it correctly.
- **Status store reset**: `XMentionBridgeService` calls `statusStore.setMode('bridge', false)` on poll failures so the UI immediately reflects that the bridge is down rather than showing a stale active indicator.
- **`reset()` method**: `XMentionTriggerStatusStore` exposes a `reset()` method for clearing all status state on demand.

### UI and presentation

- **Mac vibrancy sidebars**: left and right sidebars are now transparent to allow the macOS vibrancy/blur material to show through.
- **Bird CLI error deduplication**: `dedupeBirdOutputDetail()` merges stderr and stdout, removes duplicate lines, and strips lines already present in the base error message before appending them to the combined error string.
- **Relationship memory for mailbox**: mailbox sync captures contact insights into the relationship memory graph.
- **Companies panel**: a new agent companies service with a companies panel UI and company preview service.
- **Apple HealthKit bridge**: runtime and build script improvements for the HealthKit bridge.

### Bug fixes

- **Broken task foreign key**: fixed a broken `tasks` FK introduced after the `heartbeat_runs` table rename; added a guard to catch future renames at migration time.
- **Stale terminal fields cleared**: when a task is patched back to an active status, `completed_at`, `failed_at`, and similar terminal fields are now cleared to prevent stale values from corrupting lifecycle queries.
- **Multi-LLM participant sort order**: council participant seat assignment now uses the configured sort order correctly; fixed an off-by-one that caused seats to be assigned in wrong order on the first run.
- **CLI child-task detection**: the CLI agent detector now uses a pre-built event map rather than scanning the full event list, fixing a case where child tasks were not detected when the parent had many events.
- **Quality-pass draft rejection**: the quality-pass callback now returns a `QualityPassDraftResult` so rejected drafts are correctly skipped by the caller rather than used as if accepted.
- **Overly broad tool transcript marker**: the `"command":` marker was removed from the plain-tool-transcript detection set; it was triggering false positives on task output that contained JSON with a `command` key.
- **Skill routing false matches**: broadened skill routing keyword coverage to reduce false negatives, while tightening the routing gate to prevent stale skills from auto-executing.
- **`mailbox_commitments` migration**: added the missing `ALTER TABLE mailbox_commitments ADD COLUMN metadata_json TEXT` migration for databases created before this column was introduced.
- **`CronSchedule` import boundary**: `CronSchedule` is now inlined in the shared types file to fix an `electron/` boundary import error when the type was used in renderer-visible code.
- **`BriefingPanel` implicit-any**: fixed a TypeScript implicit-any on workspace filter result in `BriefingPanel`.

### Documentation

- **Inbox Agent**: new reference doc at [docs/inbox-agent.md](inbox-agent.md) covering the LLM classification pipeline, fingerprinting strategy, backfill, reclassify API, and category heuristics.
- **Features**: updated with Inbox Agent classification, ocrmypdf PDF review, copy-link OAuth, and task replay entries.
- **Showcase and use cases**: new inbox triage and research assistant examples.
- **AGENTS.md and README**: updated to reflect 0.5.13 capabilities.

## Notes

- `ocrmypdf` is an optional dependency. If not installed, the system falls back to per-page Tesseract OCR for image-heavy PDFs; native text extraction is always attempted first. Install with `brew install ocrmypdf` (macOS) or `apt install ocrmypdf` (Linux).
- The AcpxRuntimeRunner requires the `acpx` binary to be on `PATH`. If not found (`ENOENT`), tasks execute using the existing native runtime automatically.
- Computer use tools require explicit user approval via the permission dialog on first use per session.
- Council scheduling requires at least one LLM provider configured with an API key. Councils without a valid provider are skipped at cron time and logged.
- Prompt-cache cost discounts are applied automatically when the provider reports cached token counts. No configuration is required.
- This page is the canonical summary for the changes included in `0.5.13`.
