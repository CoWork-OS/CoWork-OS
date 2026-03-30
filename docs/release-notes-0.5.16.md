# Release Notes 0.5.16

This page summarizes the product changes included in `0.5.16`, based on changes merged after `v0.5.14` on 2026-03-29.

## Overview

The 0.5.16 release adds a visible operator-facing runtime layer for learning, recall, shell state, and model routing; introduces a governed Discord supervisor loop for bot-to-bot review and escalation; opens the Skill Store to ClawHub and other external skill sources; and hardens mailbox/email flows around Microsoft OAuth, encryption at rest, and safer mailbox actions. It also refreshes Mission Control with an all-workspaces operator view, folds Dispatch onboarding into Devices, tightens Inbox Agent ergonomics, fixes a tag-blocking release-gate issue around empty eval corpora in ephemeral CI databases, and broadens the docs/comparison set so the new runtime surfaces are easier to understand and ship.

## What Changed

### Runtime visibility and operator insight

- **Learning progression**: task completion can now emit a structured "What Cowork learned" progression covering memory capture, playbook reinforcement, skill proposal state, evidence links, and pending human-review actions.
- **Unified recall**: operators can search tasks, task messages, files, workspace notes, memory entries, and knowledge-graph context from one recall surface instead of switching between separate search paths.
- **Persistent shell sessions**: eligible non-interactive shell commands can now reuse shell state across a task or workspace, preserving cwd, env deltas, and aliases for longer operator workflows.
- **Routing observability**: the runtime now exposes active provider/model selection, route reasons, fallback chains, and override state through task events and settings surfaces.
- **Runtime UI wiring**: task detail, command output, Mission Control activity, and Settings all now surface the new learning, shell, and routing state directly instead of leaving it in backend-only services.

### Discord supervisor mode

- **Strict supervisor protocol**: Discord can now run a worker/supervisor exchange with explicit protocol markers, peer-bot validation, bounded turn depth, and acknowledgements/escalations that are machine-readable instead of ad hoc.
- **Persisted exchanges**: supervisor exchanges are stored in a dedicated repository so escalations, review turns, and operator resolutions can be queried and traced later.
- **Mission Control integration**: supervisor exchanges flow into the shared activity feed, and escalated exchanges can be resolved from the UI without dropping out of the operator surface.
- **Discord settings support**: the Discord channel settings flow now supports supervisor-specific configuration including coordination channel, watched channels, worker/supervisor roles, human escalation targets, peer bot IDs, and strict-mode validation.
- **Workspace policy support**: the workspace kit now recognizes `SUPERVISOR.md`, and the Memory Kit skill now teaches workspaces to capture review thresholds, escalation rules, and quality checks for supervisor-driven channel workflows.

### Skill Store and external skills

- **ClawHub search and install**: the desktop app can now search ClawHub directly, show result metadata, and install skills from result cards or ClawHub URLs.
- **External import paths**: skill imports now support Git repositories, raw manifest URLs, and raw `SKILL.md` entry points in addition to the curated CoWork registry.
- **Managed install flow**: imported skills are copied into the managed skills directory and then treated like first-class managed skills instead of one-off external blobs.
- **Registry backend hardening**: the skill registry now validates larger import flows, ZIP bundles, file-count/size limits, and source normalization, with expanded test coverage around external installs.

### Microsoft email OAuth and mailbox hardening

- **Microsoft OAuth flow**: Outlook.com-family personal accounts now support Microsoft OAuth with PKCE, token refresh, connector OAuth wiring, default scopes/tenant handling, and renderer settings support for the required app-registration fields.
- **Provider enforcement**: password-based IMAP/SMTP setup is now explicitly rejected for Outlook.com, Hotmail, Live, and MSN consumer accounts so users are directed to the supported OAuth path before transport failures occur.
- **Email client improvements**: the email stack now handles OAuth-backed IMAP/SMTP sessions, refreshes access tokens when needed, and parses Outlook-style multipart messages without leaking MIME boundary artifacts into the visible body.
- **Mailbox workflow updates**: Inbox Agent now supports per-account filtering, stronger no-reply sender heuristics, safer cleanup-local flows, and recent Loom mailbox fetches for more consistent inbox actions.
- **Data protection**: mailbox bodies, summaries, and excerpts are encrypted locally; channel configs are encrypted at rest when OS keychain support is available; database/user-data file permissions are restricted on setup; and OAuth secrets are sanitized from renderer-visible config payloads.
- **Main-window mailbox gating**: mailbox IPC handlers now require requests to originate from the main app window so mailbox data is not exposed to arbitrary renderer contexts.

### Mission Control and operator surfaces

- **All-workspaces view**: Mission Control now includes an explicit all-workspaces selector and carries workspace labels through feed, board, overview, agents, and agent-detail surfaces.
- **Task detail upgrades**: task detail now shows learning progression and unified recall so operators can inspect what the runtime learned and what evidence it can retrieve without leaving the task panel.
- **Workspace report gating**: temporary workspaces no longer expose standup/review/report actions that depend on persisted workspace reporting state.
- **Routing runtime panel**: Settings now includes a live routing runtime surface for the currently active provider/model state.
- **Surface cleanup**: Connectors settings, activity feed items, and command output were updated to better support the new runtime and supervisor workflows.

### Devices, Dispatch, and Inbox UX

- **Dispatch in Devices**: Dispatch onboarding and connected-channel guidance now live directly inside the Devices panel instead of a separate renderer surface.
- **Standalone Dispatch removal**: the dedicated Dispatch panel and sidebar entry were removed so the remote-device surface owns this workflow end to end.
- **Dashboard workspace naming**: the home dashboard now resolves companion workspace names from visible workspaces instead of maintaining a second local workspace-name map.
- **Inbox Agent controls**: mailbox folder filters were tightened into a segmented control, multi-account selection moved into a compact dropdown, and the pulse/triage cards were compressed for denser scanning.
- **Inbox visual cleanup**: lower-priority thread grouping is less noisy, selection styling is more consistent, and accent usage now aligns better with the rest of the updated inbox surface.

### Release automation reliability

- **Empty-corpus hardening fix**: deterministic eval runs can now be explicitly configured to allow an empty `reliability-regressions` corpus when the workflow is running against a fresh CI/release database with no captured tasks.
- **Workflow alignment**: CI, nightly hardening, and release workflows now opt into that empty-corpus mode for ephemeral databases, preventing every tag-triggered release from failing before packaging starts.

### Documentation and product positioning

- **New reference docs**: added dedicated pages for operator runtime visibility, skill store/external skills, and Discord supervisor mode.
- **Comparison refresh**: refreshed the competitive positioning docs and linked the broader market write-up back to the main comparison pages.
- **Docs synchronization**: README, docs home, features, channels, architecture, mission control, project status, and related reference pages were refreshed so the new runtime and integration surfaces are discoverable from the main documentation paths.

## Notes

- Persistent shell sessions are intentionally limited to eligible non-interactive shell commands and can be reset or closed from the app.
- Outlook.com-family personal mailboxes require a user-supplied Microsoft Entra app registration with the desktop/native `http://localhost` redirect flow.
- Discord supervisor mode requires peer bot IDs, a coordination channel, and worker/supervisor agent roles to be configured before strict mode can run.
- This page is the canonical summary for the changes included in `0.5.16`.
