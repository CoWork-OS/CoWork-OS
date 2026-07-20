# Release Notes 0.5.50

Release `0.5.50` brings CoWork OS's largest post-`0.5.49` capability update: a main-screen Automation Studio and deterministic workflow runtime, GPT-5.6 subscription controls, Mixture of Agents orchestration, browser annotations, inline email review, video understanding, stronger browser/computer-use approvals, new Calendar and architecture connectors, governed memory writes, session retention controls, and a bundled privacy-cleanup workflow.

## Highlights

- **Automation Studio**: the main sidebar **Automations** destination now opens Discover, Library, Builder, and Activity views for structured flows. Build from a conservative prompt-generated draft, eight templates, or a blank flow; configure typed fields and variables; author explicit Yes/No branches; review Google accounts/scopes; dry-test without external writes; save inactive drafts; turn an immutable version on or off; run manually; inspect step evidence; respond to approvals; and cancel active work. Advanced prompt-based Routines, queues, schedules, hooks, triggers, briefings, and Workflow Intelligence policy remain under **Settings → Automations**. See [Automation Studio](automation-studio.md).
- **GPT-5.6 for ChatGPT subscriptions**: added `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, with model-specific reasoning effort choices through Max and Ultra, response-verbosity controls, OAuth model preservation, and Codex Responses transport forwarding.
- **Mixture of Agents provider**: combine multiple advisor models with an aggregator model, including provider-aware slots, failover, usage aggregation, reference caching, recursion protection, Settings integration, and corporate TLS guidance.
- **Browser annotations**: pin feedback directly to live Browser Workbench elements, add comments through the annotation composer, send the annotated context to the agent, and track annotation lifecycle state.
- **Inline email compose frames**: assistant-generated email drafts now render inline for review before sending, with richer recipient/body handling, draft polling, and in-place event updates.
- **Video attachment analysis**: uploaded MP4, MOV, and WebM files are sampled into representative frames and contact sheets for image-capable models and timeline review.
- **Safer browser and computer use**: background/headless execution is preferred by default, while visible Browser Workbench or native computer control requires explicit intent or approval and supports persisted permission rules.
- **Session archive and retention controls**: archive sessions without deleting task data, preview and run filtered prune operations, and configure daemon-side automatic retention cleanup.
- **Bundled `unbroker` skill**: a consent-gated data-broker privacy workflow with a local PII ledger, deterministic action queue, human-task digest, recurring rechecks, broker playbooks, and legal request templates.

## Integrations and Provider Improvements

- Added Google Calendar MCP tools for calendar discovery, event list/read/batch read, availability lookup, and confirmed create/update/delete operations.
- Added local-only Rhino, Blender, and ComfyUI MCP connectors plus the `architecture-design` skill, with project-root file boundaries and connector capability metadata.
- Added cross-platform desktop location helpers for macOS, Windows, and Linux with explicit one-time permission requirements.
- Reordered the most common LLM providers in Settings so OpenRouter, OpenAI, Mixture of Agents, Claude, Gemini, and DeepSeek appear first.
- Fixed ChatGPT OAuth token exchange and refresh behavior in Electron by adding a Chromium-network fallback and preserving useful refresh errors.
- Expanded provider documentation for xAI OAuth/SuperGrok and durable runtime context controls.

## Memory, Privacy, and Governance

- Added approval modes and a pending queue for durable archive, curated, background, and external memory writes.
- Blocked sensitive external-memory payloads before queue persistence and exposed approval controls in Memory Hub.
- Clarified local SQLite storage, encrypted fields/settings, external memory behavior, and durable-context diagnostics.
- Added local-first privacy cleanup tooling without automatically sending requests or bypassing consent requirements.

## Reliability and UX Improvements

- Added immutable active-version isolation so saving a draft cannot silently change a live starter, Google account binding, action graph, secret reference, or runtime limit.
- Added a durable deduplicated workflow inbox, bounded Gmail/Drive cursor pagination, startup requeue/recovery, explicit outcome verification for interrupted steps, cancellation propagation, one-attempt external-write policy, connector allowlist/schema enforcement, key-based stored-payload redaction, and retention cleanup.
- Fixed the Automations page's alignment and scroll containment with responsive grid/card wrapping and layout regression tests. Registered the complete workflow IPC handler set, ordered legacy `workflow_run_id` migration before dependent indexes, and made the dev launcher fail early with the existing PID before macOS can rebrand/relaunch an active Electron bundle and abort during application registration.
- Hardened build-health routine evidence checks so inspection steps remain read-only and verification requires concrete command or API evidence.
- Hid replay controls behind an explicit toggle and improved task-progress phase reporting during collaborative execution.
- Reduced memory FTS work on Electron's main thread with a prompt-recall fast path, bounded caches, batched tier tracking, and richer slow-query diagnostics.
- Reused refreshed Google Workspace OAuth tokens during mailbox sync to avoid repeated settings writes.
- Tightened output-filter prompt-leak patterns to reduce YAML capability-list false positives.
- Improved multitask stability by bounding renderer events, MCP lifecycles, synthesis prompts, SQLite contention, and executor caches.
- Added read-only review safeguards and daemon-level deduplication for identical verification commands.
- Refreshed first-run onboarding and provider-selection guidance.

## Release Readiness

- **Version bump**: package metadata is prepared for `0.5.50`.
- **Release baseline**: compare `v0.5.49...v0.5.50`.
- **Database attention**: validate upgrade paths for browser annotations, memory-write approvals, and session-retention metadata against an existing `0.5.49` database.
- **Automation attention**: validate an existing Routine database, Studio IPC registration in a full Electron run, active/draft version isolation, Google starter pagination, approval/recovery behavior, main-screen placement, and vertical scrolling at desktop and narrow widths.
- **Skill attention**: run the bundled-skill quality gates and the fake-data-only `unbroker` smoke workflow.
- **Platform attention**: desktop packaging checks remain host-specific; macOS, Windows, and Linux artifacts should be validated on matching runners.
- **Provider attention**: GPT-5.6 availability and effort support remain entitlement-dependent for the signed-in ChatGPT account.

## Suggested Validation

Run before tagging or publishing:

```bash
npm run skills:check
npm test
npm run build
npm run release:smoke
npm run qa:security:harness
npm run package:desktop:smoke -- --expected-version=0.5.50 --allow-unsigned
npm run package:win:smoke -- --expected-version=0.5.50
npm run package:linux:server:smoke
```

For npm publication, use a clean checkout or release worktree. Explicitly run `npm ci --no-audit --no-fund` and `npm run build`, create the tarball with `npm pack --ignore-scripts --silent`, verify the packaged desktop and CLI entrypoints, validate clean installation and setup, and publish with `npm publish --ignore-scripts` only after all required platform checks pass.

## Pull Requests

- [#184 Fix ChatGPT OAuth token exchange](https://github.com/CoWork-OS/CoWork-OS/pull/184)
- [#185 Implement Browser Workbench annotations](https://github.com/CoWork-OS/CoWork-OS/pull/185)
- [#186 Add architecture orchestration connectors](https://github.com/CoWork-OS/CoWork-OS/pull/186)
- [#187 Harden build-health routine evidence checks](https://github.com/CoWork-OS/CoWork-OS/pull/187)
- [#188 Add memory write governance and approval controls](https://github.com/CoWork-OS/CoWork-OS/pull/188)
- [#189 Add Google Calendar MCP tools](https://github.com/CoWork-OS/CoWork-OS/pull/189)
- [#190 Add video attachment analysis](https://github.com/CoWork-OS/CoWork-OS/pull/190)
- [#191 Add inline mail compose frames](https://github.com/CoWork-OS/CoWork-OS/pull/191)
- [#192 Add approval gates for visible browser and computer use](https://github.com/CoWork-OS/CoWork-OS/pull/192)
- [#194 Add Mixture of Agents provider](https://github.com/CoWork-OS/CoWork-OS/pull/194)
- [#195 Reorder LLM provider tabs](https://github.com/CoWork-OS/CoWork-OS/pull/195)
- [#197 Add bundled `unbroker` skill and session archive support](https://github.com/CoWork-OS/CoWork-OS/pull/197)
- [#198 Add main-screen Automation Studio workflows](https://github.com/CoWork-OS/CoWork-OS/pull/198)

## Additional Direct Commits

- Hide replay controls behind a toggle.
- Poll email draft status while sending.
- Add GPT-5.6 ChatGPT subscription controls.
- Refresh public adoption statistics throughout the release cycle.
