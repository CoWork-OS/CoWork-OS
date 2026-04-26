# Integration Setup, Skill Proposals, and Bootstrap Lifecycle

This document records the implementation shipped for three platform capabilities:

1. Chat-native setup for Tier-1 integrations (`integration_setup`)
2. Approval-gated skill expansion (`skill_proposal`)
3. Workspace bootstrap lifecycle + heartbeat frequency alignment

It is written as an implementation and operations reference for product, support, and engineering.

---

## 1) Chat-Native Tier-1 Integration Setup

### Scope

Tier-1 providers currently supported by `integration_setup`:

- `resend`
- `slack`
- `gmail`
- `google-calendar`
- `google-drive`
- `jira`
- `linear`
- `hubspot`

A shared capability catalog now drives both:

- Chat orchestration behavior (`integration_setup`)
- MCP auto-connect readiness checks

Source: `src/electron/mcp/connectors/capabilities.ts`

### Tool actions

`integration_setup` now supports:

- `list`
- `inspect`
- `configure`

#### `list`

Returns all Tier-1 providers with:

- install status
- config readiness
- connection status
- auth methods
- setup docs links

#### `inspect`

Returns deterministic planning info for a single provider:

- `missing_inputs`
- selected auth method
- current install/connect/config readiness
- `plan_hash` for safe apply

#### `configure`

Applies configuration and can perform install/connect/health/OAuth.

Core behavior:

1. Optional install from MCP registry
2. Env merge and readiness evaluation
3. Optional OAuth flow and token materialization
4. Optional connect (`connect_now` defaults to true)
5. Optional health check (`<provider>.health`)
6. Return updated `plan_hash`

### Input contract

`integration_setup` accepts:

- `action`: `list | inspect | configure`
- `provider`: Tier-1 provider id
- `auth_method`: `auto | api_key | oauth`
- `env`: key/value env overrides
- `oauth`: optional OAuth bootstrap object
  - `client_id`
  - `client_secret`
  - `scopes[]`
  - `login_url`
  - `subdomain`
  - `team_domain`
- `expected_plan_hash`: stale-plan guard token from `inspect`
- `dry_run`: compute-only, no writes or OAuth launch

Backward-compatible Resend shortcuts are still supported:

- `api_key`
- `base_url`
- `enable_inbound`
- `webhook_secret`
- `allow_unsafe_external_content`

### Plan-hash safety contract

`inspect` emits a deterministic `plan_hash` computed from provider state:

- provider id
- auth selection
- installed/connected status
- missing input fields
- env fingerprint
- (Resend only) inbound state snapshot

If `configure.expected_plan_hash` is provided and differs from current state, configure fails safely with:

- `success: false`
- `stale_plan: true`
- no mutation

### OAuth mapping behavior

When OAuth succeeds, provider tokens are written into connector env:

- Jira -> `JIRA_ACCESS_TOKEN`, optional `JIRA_REFRESH_TOKEN`, auto-fill `JIRA_BASE_URL` from OAuth resources when available
- HubSpot -> `HUBSPOT_ACCESS_TOKEN`, optional `HUBSPOT_REFRESH_TOKEN`
- Slack -> `SLACK_ACCESS_TOKEN`, optional `SLACK_REFRESH_TOKEN`
- Gmail / Google Calendar / Google Drive -> `GOOGLE_ACCESS_TOKEN`, optional `GOOGLE_REFRESH_TOKEN`

Client credentials are also persisted where applicable:

- Jira: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`
- HubSpot: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
- Google family: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### Resend inbound specialization

Inbound setup remains explicitly provider-scoped to `resend`.

If `enable_inbound=true` during configure:

- hooks are enabled if disabled
- Resend preset is added
- optional signing secret is persisted
- endpoint state is returned (`/hooks/resend` path based on hooks base path)

---

## 2) Approval-Gated Skill Expansion

### New tool

`skill_proposal` is now available with actions:

- `create`
- `list`
- `approve`
- `reject`

Source: `src/electron/agent/tools/registry.ts`

### Persistence

Proposals are persisted per workspace at:

- `.cowork/skills/proposals/<proposal-id>.json`

Source: `src/electron/agent/skills/SkillProposalService.ts`

### Proposal record model

Each proposal stores:

- problem statement
- evidence snippets
- required tools
- risk note
- draft skill payload
- lifecycle metadata (`pending | approved | rejected` + timestamps)
- signature hash used for duplicate/cooldown checks

### Lifecycle and safeguards

#### `create`

- Creates proposal record only
- Does not write or mutate any skill
- Emits structured task log event for traceability

#### `approve`

Approval materializes a skill into workspace scope only:

- target directory: `<workspace>/skills`
- uses existing create/update skill path
- blocks mutation if required tools are unavailable
- validates placeholder integrity (`{{placeholder}}` must match declared parameter names)
- blocks writes into bundled skills

#### `reject`

- Marks proposal rejected
- Stores optional rejection reason

### Duplicate and cooldown policy

Signature dedupe logic:

- duplicate pending/approved proposals are rejected immediately
- rejected duplicates are blocked for 24 hours (`cooldown_until` returned)

### Capability-gap detection hook

Executor now watches repeated tool/integration-unavailable patterns in a run.
When repeated failures are detected, it injects a hint to create `skill_proposal` instead of looping.

This is advisory only; no automatic skill mutation occurs.

---

## 3) Workspace Kit Contracts and Bootstrap Lifecycle

The original bootstrap update has now been expanded into a shared workspace-kit contract system used by prompt injection, status computation, CLI linting, and revision tracking.

### Contract-driven file model

Root `.cowork/` files now have explicit contracts covering:

- title
- scope (`task`, `main-session`, `role`, `company-ops`, `heartbeat`, `bootstrap`)
- parser (`sectioned`, `kv-lines`, `checklist`, `decision-log`, `freeform`)
- prompt budget (`maxChars`)
- freshness window (`freshnessDays`)
- mutability (`system_locked`, `user_owned`, `agent_suggested`, `agent_maintained`)
- optional special handling (`bootstrap`, `heartbeat`)

Representative root files now include:

- `.cowork/AGENTS.md`
- `.cowork/MEMORY.md`
- `.cowork/USER.md`
- `.cowork/TOOLS.md`
- `.cowork/IDENTITY.md`
- `.cowork/RULES.md`
- `.cowork/SOUL.md`
- `.cowork/VIBES.md`
- `.cowork/MISTAKES.md`
- `.cowork/LORE.md`
- `.cowork/CROSS_SIGNALS.md`
- `.cowork/PRIORITIES.md`
- `.cowork/COMPANY.md`
- `.cowork/OPERATIONS.md`
- `.cowork/KPIS.md`
- `.cowork/HEARTBEAT.md`
- `.cowork/BOOTSTRAP.md`

Project-scoped files now live under:

- `.cowork/projects/<projectId>/CONTEXT.md`
- `.cowork/projects/<projectId>/ACCESS.md`

Role profile files live under:

- `.cowork/agents/<roleId>/IDENTITY.md`
- `.cowork/agents/<roleId>/RULES.md`
- `.cowork/agents/<roleId>/SOUL.md`
- `.cowork/agents/<roleId>/VIBES.md`

### Frontmatter and parsing contract

Tracked files can include simple markdown frontmatter such as:

```md
---
updated: 2026-03-14
---
```

Current behavior:

- `updated` is used for freshness checks on files that declare a freshness window
- markdown is sanitized and redacted before prompt injection
- raw unsanitized bodies are still inspected for secret detection where needed
- files that exceed their prompt budget are truncated for injection and reported as warnings
- parser-specific formatting is reused across prompt assembly and health/lint surfaces

### Bootstrap lifecycle state

State is persisted at:

- `.cowork/workspace-state.json`

Current schema:

```json
{
  "version": 1,
  "bootstrapSeededAt": 0,
  "onboardingCompletedAt": 0
}
```

Lifecycle rules:

1. If `.cowork/BOOTSTRAP.md` exists and `bootstrapSeededAt` is empty, seed `bootstrapSeededAt`.
2. If `.cowork/BOOTSTRAP.md` is later removed and `bootstrapSeededAt` exists, set `onboardingCompletedAt`.
3. During init in missing-only mode, `.cowork/BOOTSTRAP.md` is not recreated after onboarding is already complete.
4. `.cowork/HEARTBEAT.md` remains separate from bootstrap and is reserved for recurring heartbeat-only checks.

### Pure / mutating function split (`kit-status.ts`)

`computeWorkspaceKitStatus()` is now **pure** — it reads and derives status without writing any state. This makes status reads safe to call from any read-only context (UI polling, lint checks, etc.).

Lifecycle mutations are isolated in `ensureBootstrapLifecycleState()`, which is the only function that writes `workspace-state.json`:

| Function | Reads | Writes | When to call |
|----------|-------|--------|--------------|
| `readWorkspaceKitState()` | ✓ | — | Always safe |
| `computeWorkspaceKitStatus()` | ✓ | — | Status display, lint, UI |
| `ensureBootstrapLifecycleState()` | ✓ | ✓ | Kit init, status refresh (`KIT_GET_STATUS`), bootstrap deletion flow |

`KIT_GET_STATUS` IPC handler calls `ensureBootstrapLifecycleState()` before the pure `computeWorkspaceKitStatus()` so that `bootstrapSeededAt` and `onboardingCompletedAt` timestamps are always current in the returned status object.

### Health, linting, and tracked directories

Workspace-kit status is now computed from one shared path and includes:

- `hasKitDir`
- tracked file entries with title, modification time, stale state, issues, revision count, and special handling
- onboarding metadata (`bootstrapSeededAt`, `onboardingCompletedAt`, `bootstrapPresent`)
- aggregate warning/error counts
- missing tracked entry count

Tracked directories now include:

- `.cowork/memory/`
- `.cowork/memory/hourly/`
- `.cowork/memory/weekly/`
- `.cowork/projects/`
- `.cowork/agents/`

Lint behavior now includes:

- missing `updated` warnings on freshness-tracked files
- stale warnings when `updated` is older than the file contract allows
- possible-overlap warnings when content appears to belong in another file
- secret detection errors for likely credentials in `ACCESS.md` and `TOOLS.md`
- truncation warnings when injected content exceeds the prompt budget

### CLI and revision history

Workspace-kit validation is now available through:

- `npm run kit:lint`
- `npm run kit:lint -- --json`
- `npm run kit:lint -- --strict`

Tracked writes now store previous versions under:

- `.cowork/**/.history/<file>/`

Each revision records:

- file name
- who changed it (`user`, `agent`, `system`)
- optional reason
- prior content hash
- timestamp

### Quick-open kit files (`kit:openFile`)

The `KIT_OPEN_FILE` IPC handler (`kit:openFile`) opens any `.cowork/`-scoped file in the system editor. If the file does not exist it is seeded from a default template (with full frontmatter and section scaffolding) before opening.

This channel is part of the shared IPC contract exported from `src/shared/types.ts`, which keeps preload, renderer, and Electron handlers aligned on the same channel names. Related behavior-adaptation IPC channels in that shared contract include:

- `KIT_RESET_ADAPTIVE_STYLE` → `kit:resetAdaptiveStyle`
- `KIT_SUBMIT_MESSAGE_FEEDBACK` → `kit:submitMessageFeedback`

Exposed in **Memory Hub → Per Workspace** as "Open USER.md" and "Open MEMORY.md" buttons.

Security constraints:
- `relPath` must start with `.cowork/` and must not contain `..`
- Rate-limited to the `limited` tier

### Source modules

Primary implementation now lives in:

- `src/electron/context/kit-contracts.ts`
- `src/electron/context/kit-parser.ts`
- `src/electron/context/kit-linter.ts`
- `src/electron/context/kit-status.ts`
- `src/electron/context/kit-revisions.ts`
- `src/electron/context/kit-lint-cli.ts`
- `src/shared/types.ts`

---

## 4) Legacy Twin Routine Cadence

Older twin integrations used role-local proactive-task cadence metadata such as `frequencyMinutes`.

Current architecture note:

- Digital Twin templates are persona presets, not core automation owners
- Always-on cadence now belongs to attached automation profiles
- Heartbeat and Workflow Intelligence scheduling should be reasoned about through the core automation docs, not through twin-local routine metadata

This section remains only as migration context for older integrations that still read legacy role-local routine hints.

---

## 5) Manual Validation Matrix

Use this matrix for release and support verification.

### Integration setup

1. `integration_setup(action="list")` returns exactly 8 Tier-1 providers.
2. `inspect` returns `missing_inputs` and a stable `plan_hash`.
3. `configure` with stale `expected_plan_hash` fails with `stale_plan=true` and no mutation.
4. OAuth success persists access/refresh env and reports configured state.
5. OAuth denial/error returns actionable failure.
6. Resend inbound setup remains functional and provider-scoped.

### Skill proposals

1. `skill_proposal.create` creates proposal JSON only.
2. `skill_proposal.approve` materializes workspace skill and updates proposal state.
3. `skill_proposal.reject` records rejection.
4. Re-submitting rejected duplicate within 24h returns cooldown block.

### Kit + heartbeat

1. Kit init creates the expected `.cowork/` structure for the selected preset, including shared root files plus tracked directories.
2. Kit status reports missing tracked entries, stale files, lint warning/error counts, revision counts, and onboarding state fields.
3. Files with freshness windows warn when `updated` is missing or stale.
4. `ACCESS.md` and `TOOLS.md` surface secret-detection errors when likely credentials are pasted into them.
5. Deleting `.cowork/BOOTSTRAP.md` marks onboarding completed in workspace state.
6. `npm run kit:lint` and `npm run kit:lint -- --strict` match the in-app health model.
7. Proactive tasks respect `frequencyMinutes` and do not run each heartbeat.

---

## 6) Compatibility Notes

- Existing Resend setup payloads remain supported.
- Existing Settings/UI OAuth flows are unchanged and remain available.
- New chat integration flow layers on top of current MCP settings and connector registry.
- Skill auto-mutation remains disabled by default; approval is mandatory through `skill_proposal.approve`.
