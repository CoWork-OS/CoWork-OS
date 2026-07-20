# Automation Studio

Automation Studio is CoWork OS's visual builder and deterministic runtime for structured flows. Open it from **Automations** in the main sidebar. It is a main-screen product surface, not a Settings page.

Advanced and compatibility controls remain under **Settings → Automations**. Those pages expose legacy prompt-based Routines, the task queue, Scheduled Tasks, Webhooks, Event Triggers, Workflow Intelligence, and Daily Briefing. They are useful when inspecting a compiled backend or managing older automations, but they are not the place to author a structured flow.

## Choose the right automation surface

| Need | Use |
| --- | --- |
| Build a multi-step flow with typed fields, variables, branches, testing, approvals, and versioned activation | Main sidebar **Automations** |
| Turn the current task into a recurring same-thread or new-task automation | Task menu **… → Add automation…** |
| Create or inspect a prompt-based routine | **Settings → Automations → Routines** |
| Manage the cron, inbound hook, or event-trigger engine directly | **Settings → Automations → Scheduled Tasks / Webhooks / Event Triggers** |
| Configure the always-on cognitive loop | Mission Control and **Settings → Automations → Workflow Intelligence** |

Structured flows are stored as Routines for compatibility, but each activation points to an immutable structured workflow version and executes through the deterministic workflow engine.

## Before you start

- Create or select a workspace. Every flow belongs to one workspace.
- Connect Google Workspace under **Settings → Integrations** before activating a flow that requires Google scopes.
- Install and connect an MCP connector before using one of its tools.
- For a signed outbound webhook, create a signing secret in the webhook step. The flow stores only the secret identifier.
- Treat templates and prompt-generated plans as drafts. Review every field, variable, account, scope, approval, and destination before turning one on.

## The four views

### Discover

Start in one of three ways:

- Describe the outcome. Generation is deliberately conservative: CoWork deterministically matches a known template when confidence is sufficient. Otherwise it creates a manual-starter draft with one bounded agent step. It does not invent unknown connector arguments or activate the result.
- Select a built-in template.
- Select **Blank flow**.

The bundled patterns cover unread email recaps, saving Gmail attachments to Drive, meeting pre-briefs, meeting follow-ups, email-to-task routing, sheet-change notifications, Drive-folder notifications, and drafting replies from a reference document.

### Library

Library lists structured flows only. It shows whether each flow is on or still a draft, its recent run state, step count, and last update. Select a row to reopen it in Builder. Prompt-based legacy Routines remain in the advanced Settings surface.

### Builder

Builder has four working regions:

- **Action catalog** on the left, with search and provider/category groups.
- **Flow canvas** in the center, including the starter, ordered steps, branch labels, risk labels, flow name, workspace, and run controls.
- **Inspector** on the right for fields, variables, webhook secrets, failure behavior, approval overrides, and retry settings.
- **Test and scope review** below the builder for sample event JSON, Google account binding, required scopes, validation issues, and the latest dry-run steps.

The main Automations page owns vertical scrolling. The catalog and activity lists have their own bounded scroll areas, and the builder collapses from three columns to a single-column layout at narrower widths. Keep this containment model when changing the UI; putting the Studio inside a fixed-height parent or disabling the main page's `overflow-y` will make lower content unreachable.

### Activity

Activity lists structured workflow runs. Select a run to inspect its step timeline, attempt counts, errors, redacted output, backing task, and any pending approval. From this view you can:

- **Approve once** or **Reject** a waiting step;
- cancel a non-terminal run;
- open a backing CoWork task created by an AI or agent step.

## Build a flow end to end

1. Open **Automations** from the main sidebar.
2. Start from a description, template, or blank flow.
3. Give the flow a name, optional description, and workspace.
4. Choose exactly one starter.
5. Add actions from the catalog in execution order.
6. Select a step and complete its required fields.
7. Replace literal fields with starter or earlier-step variables where needed.
8. For a condition, select **Yes branch** or **No branch**, then select the next action from the catalog. The canvas labels the resulting branch.
9. Review per-step failure, approval, and retry settings.
10. Bind the intended Google account and review all required scopes.
11. Edit the sample event JSON and select **Test**. Tests are dry runs: external writes and exports are previewed, not executed.
12. Select **Save draft** to persist an inactive version.
13. Resolve activation errors, then select **Turn on**. Activation creates a new immutable active version.
14. Use **Run now** to start an enabled flow manually regardless of its configured automatic starter, or wait for that starter.
15. Monitor Activity and respond to approvals.
16. Select **Turn off** before changing secrets, pausing ingestion, or retiring the flow.

Saving and activation are intentionally separate. A draft may contain missing required fields as warnings, but it cannot be activated with structural errors, missing required values, preview-only operations, unavailable secrets, a disconnected Google account, or missing Google scopes.

## Starters

A structured flow must contain exactly one starter, and the starter cannot have an incoming edge.

| Starter | Behavior |
| --- | --- |
| Manual | Runs on demand after the flow has been saved and turned on. |
| Schedule | Supports cron, recurring-minute, and one-time schedules with timezone-aware cron configuration. |
| Gmail message | Matches Gmail search, sender, subject, and flow-generated-message settings. |
| Google Chat message | Receives normalized Google Chat channel events from the event-trigger bridge. |
| Sheet changed | Watches the selected spreadsheet through Google Drive change signals. |
| Item added to Drive folder | Matches a newly created direct child of the selected folder. |
| Drive file edited | Matches changes to one file. |
| Item in Drive folder edited | Matches changes to direct children of one folder. |
| Meeting relative | Polls Calendar and runs before or after a matching meeting. |
| Meeting outputs ready | Detects matching Google Docs meeting-note or transcript output through Drive changes. |
| Form response | Watches the selected linked response spreadsheet. |

Google Chat mention, reaction, and space-membership starters appear as **Preview**. Preview starters and actions can be kept in a draft but block activation until a supported event source/runtime is available. NotebookLM, Confluence page creation, and Mailchimp contact actions are also preview-only in the current catalog.

### Polling, cursors, and pagination

Google poll-based starters establish a cursor on the first successful poll. This prevents a newly enabled flow from replaying the account's existing mailbox or Drive history.

- Gmail processes a fixed time window, up to ten pages per poll and 100 message references per page. If more pages remain, it stores both the page token and the original window end, then continues that same finite window on the next poll.
- Drive processes up to ten change pages per poll and stores `nextPageToken` until that batch is complete. It advances to `newStartPageToken` only after the pending pages are drained.
- Drive requests enable Shared Drive results, but folder matching is based on the changed item's direct `parents` list. It does not recursively traverse descendants.
- Event keys are deduplicated per routine before execution. The durable inbox is the handoff between trigger detection and the workflow engine.

The normal Google starter poll interval is 60 seconds. Calendar-relative matching also suppresses duplicate delivery with a stable event key.

## Actions and control flow

Available action groups include:

- CoWork AI summary, extraction, decision, recap, and prompt actions;
- bounded CoWork agent tasks;
- Gmail send, draft, reply draft, archive, label, read-state, star, and attachment-to-Drive actions;
- Google Chat messages;
- Google Sheets read, append, update, and clear operations;
- Google Drive folder creation;
- Google Docs create and append operations;
- Google Calendar block-time creation;
- Google Tasks creation;
- connected Asana, Jira, and Slack tools;
- custom installed MCP tools;
- HMAC-signed HTTPS webhooks;
- condition, filter, and bounded for-each control nodes.

An operation's catalog risk is one of `read`, `local_write`, `external_write`, or `data_export`. Custom MCP tools are conservatively classified as external writes. A `Repeat for each` node inherits the highest risk of any nested action.

### Variables

Fields accept literals, typed references, or text templates:

```json
{ "$ref": "trigger.subject" }
```

```json
{ "$ref": "summary.text", "default": "No summary was produced" }
```

```json
{ "$template": "Follow-up: {{trigger.meetingTitle}}" }
```

The variable picker exposes starter fields and declared outputs from earlier steps. Loop bodies can also use `item` and `index`. A missing reference resolves to its declared default when one exists. Secret-reference fields do not accept workflow variables.

### Conditions and branches

`Check if` supports equality, inequality, contains, regular-expression matching, numeric comparisons, and empty/non-empty checks. It emits either the `true` or `false` port. Only edges attached to the emitted port run; the inactive branch is recorded as skipped.

To author a branch in the GUI:

1. Select the condition node.
2. Select **Yes branch** or **No branch** in the inspector.
3. Choose an action from the left catalog.
4. Repeat for the other branch if needed.

The builder currently presents an ordered flow rather than a free-positioned graph editor. Branch labels make the selected path explicit, while the stored definition keeps the underlying edge ports.

### Filters and loops

`Filter` keeps list items that match the configured comparison. `Repeat for each` executes nested actions sequentially for a bounded list. Nested operations consume the same total run-operation budget as top-level steps. The current engine executes ready top-level steps sequentially; `maxParallelSteps` is a validated concurrency ceiling reserved in the workflow contract, not a promise that independent branches run concurrently today.

## Drafts, activation, and version isolation

Every save produces a numbered workflow version. Version states are:

- `draft`: editable and inactive;
- `active`: the immutable definition used by new events and runs;
- `archived`: a previously active version retained for run history.

Turning on a draft archives the previous active version, activates the selected version, and synchronizes its starter to the appropriate schedule or event backend. Editing or saving another draft does not change the live starter, Google account binding, action graph, secret references, or runtime limits. Each run stores its exact `workflowVersionId`, so later edits cannot rewrite historical execution semantics.

Turning a flow off stops new queued events from starting runs. Events claimed after disablement are marked cancelled. Turning a flow back on validates the active version's current secret availability, Google connection, and scopes again.

## Approval policy

New Studio flows default to `confirm_external`. The routine-level policy and optional step override are evaluated against the highest risk of the step and its nested actions.

| Flow policy | Read | Local write | External write | Data export |
| --- | --- | --- | --- | --- |
| `inherit` | Run | Run | Confirm | Confirm |
| `auto_safe` | Run | Run | Confirm | Confirm |
| `confirm_external` | Run | Run | Confirm | Confirm |
| `strict_confirm` | Run | Confirm | Confirm | Confirm |

`data_export` always requires approval in a live run. A step set to **Always confirm** always pauses. **Skip for safe actions** can bypass confirmation only for `read` and `local_write`; it cannot bypass confirmation for external writes or data exports.

Dry runs do not create approval pauses because no external mutation or export is performed. They return a preview record instead.

## Execution, retry, cancellation, and recovery

The runtime persists the event before execution, then creates a version-pinned run and step rows.

```text
starter signal
  → deduplicated durable inbox event
  → active immutable workflow version
  → queued/running workflow run
  → deterministic step resolution
  → approval, completion, failure, or cancellation
```

Key guarantees and boundaries:

- One routine and idempotency key produce at most one workflow run.
- External writes and data exports receive only one automatic attempt, even if a higher retry count is configured. Read and local-write steps may retry up to ten times with bounded exponential backoff.
- `onError: continue` allows later reachable work to continue and produces `partial_success` when at least one step failed. The default is to fail the run.
- Cancellation aborts active Google API requests, uploads, signed webhooks, and backing CoWork agent tasks, then marks unfinished steps cancelled.
- MCP calls are checked for cancellation before and after the call. An arbitrary MCP server may not support mid-call abort, so its remote side effect can outlive a local cancellation.
- On restart, inbox events left in `processing` are returned to `pending` before new events are drained.
- Runs left in `queued` or `running` are recovered before normal inbox processing resumes.
- A step left in `running` or `retrying` is moved to `waiting_for_approval` because its external outcome may be unknown. Verify the destination before selecting **Approve once** to retry it.

The last rule deliberately prefers a visible verification pause over silently repeating a potentially completed write.

## Runtime limits

| Limit | Default | Allowed range |
| --- | ---: | ---: |
| Run duration | 30 minutes | 1 second–30 minutes |
| Total operations, including nested loop actions | 100 | 1–100 |
| Items per for-each | 100 | 1–100 |
| Parallel-step ceiling | 4 | 1–4 |
| Step data retention | 30 days | 1–365 days |
| Workflow nesting depth | — | Maximum 4 levels |
| Per-step retry attempts for safe work | 1 | 1–10 |
| Signed webhook request body | — | Maximum 1 MiB |
| Signed webhook response body | — | Maximum 1 MiB |
| Signed webhook timeout | 15 seconds | 1–60 seconds |

The shared run deadline and total-operation budget are checked inside nested loops as well as between top-level steps. A workflow cannot evade the limits by placing work inside `Repeat for each`.

## Secrets, connector policy, and data handling

### Webhook secrets

Signing secrets are stored through CoWork's secure settings repository, which uses operating-system-backed encryption. The renderer receives only the secret id, name, timestamps, and configured state. Secret values are not returned to the renderer or embedded in workflow definitions, run inputs, or activity output.

A secret value is limited to 16 KiB. CoWork refuses to remove a secret referenced by an enabled flow's active version. Turn off every listed flow first, remove or replace the reference, and validate before turning the flow on again.

### Connector policy

Routine connector policy supports `prefer` and enforced `allowlist` modes. Before any MCP call, the runtime:

1. resolves the live tool and owning server/connector;
2. rejects it when an allowlist does not contain that server or connector;
3. rejects disconnected or unknown tools;
4. validates required properties, primitive types, arrays, enum values, and forbidden additional properties against the tool's current input schema;
5. calls the connector only after those checks pass.

The current GUI exposes catalog operations and custom tool fields. Connector-policy editing remains a lower-level Routine capability; flows created in Studio start in `prefer` mode.

### Stored run data and retention

Before inputs and outputs are written, keys matching token, secret, password, authorization, or API-key patterns are replaced with `[redacted]`. Recursive storage is depth-limited and arrays are capped to prevent unbounded payloads. This is a defense-in-depth key-based filter, not a general content-classification system; do not put secrets in ordinary field names or free text.

Retention maintenance runs at startup and every six hours:

- after the active version's `retainStepDataDays`, terminal run step rows are deleted and the run's context/output payloads are cleared;
- the run's status, identity, version reference, timestamps, and error metadata remain for auditability;
- completed/failed/cancelled inbox events and captured event samples use the default 30-day cleanup window;
- event samples are additionally capped to the newest 20 per source.

## Signed outbound webhooks

The webhook action supports `POST`, `PUT`, and `PATCH`. It:

- requires HTTPS and rejects URL credentials;
- applies the administrator network allow/block policy;
- rejects localhost, private, loopback, link-local, carrier-grade NAT, metadata, multicast, and reserved destinations, including after DNS resolution;
- pins the validated destination address for the TLS request;
- does not follow redirects;
- sends JSON with bounded request/response sizes and a bounded timeout;
- supports run cancellation through `AbortSignal`;
- includes `X-CoWork-Timestamp`, `X-CoWork-Signature`, and `X-CoWork-Idempotency-Key`.

The signature is lowercase hexadecimal HMAC-SHA256 over `<timestamp>.<raw JSON body>` and is sent as `sha256=<digest>`. Receivers should verify the signature in constant time, reject stale timestamps, and deduplicate the idempotency key.

## Troubleshooting

### Automation Studio says no handler is registered

An error such as:

```text
Error invoking remote method 'routine:workflowCapabilities':
No handler registered for 'routine:workflowCapabilities'
```

means the renderer loaded without the matching Electron main/preload runtime. Do not debug this with `npm run dev:react`; that starts only Vite and cannot provide desktop IPC. Start the desktop application with:

```bash
npm run dev
```

If it still fails, capture a fresh run with `npm run dev:log`, then inspect `logs/dev-latest.log` for handler registration, preload, renderer, or process-exit errors.

If the dev launcher reports an existing CoWork OS process, or Electron exits before `did_finish_load` or `app_shell_ready`, another process may already hold the single-instance lock for the same user-data directory. Quit the existing app and retry. The macOS launcher checks this before rebranding the development Electron bundle because modifying and relaunching that bundle while it is active can abort before JavaScript starts. Deleting `dist` does not terminate a process that was started from an older build.

### The page is misaligned or will not scroll

The app shell must render Studio as `<main className="main-content automation-studio-main">`. The matching CSS gives that main element `overflow-y: auto`, removes the normal task-content width cap, and constrains catalog/activity subpanels. Check that neither a parent nor a theme override changed those rules. Run the placement and layout tests listed below after any shell or Studio CSS change.

### A Google starter does not fire

Check, in order:

1. the flow is turned on and Library shows it as on;
2. the currently active version, not a later draft, has the intended starter and Google account;
3. Google Workspace is connected and has every scope shown in Builder;
4. the first poll has had time to establish its baseline cursor;
5. Gmail search syntax, ids, folder parents, spreadsheet id, or calendar filters match the source;
6. Activity does not show a queued, failed, or cancelled event/run.

For a backlog larger than a single poll's page cap, allow later polls to continue the stored page token rather than changing and reactivating the flow.

### Activation fails

Read the inline validation message. Common causes are a missing required field, disconnected account, missing OAuth scope, preview operation, invalid graph, unreachable or cyclic node, missing webhook secret, or a configured limit outside its allowed range. Reconnect Google Workspace when the account is connected but lacks newly required scopes.

### A connector tool is blocked

Confirm the connector is connected, the tool name still exists, its JSON arguments match the live schema, and the Routine connector allowlist includes the tool's connector/server. Unknown keys are rejected when the connector schema sets `additionalProperties: false`.

### A run waits for approval after restart

The application stopped while a step was running or retrying, so the runtime cannot prove whether the remote side effect completed. Inspect the destination first. Select **Approve once** only when it is safe to retry; select **Reject** to fail the run without another attempt.

### A webhook secret cannot be removed

At least one enabled flow's active version references the secret. Turn off the named flow, edit/save the draft to use another secret or remove the webhook, activate the replacement when valid, and then remove the unused secret.

### A database upgrade reports `workflow_run_id`

Do not delete the CoWork database. `RoutineService.ensureSchema()` adds legacy routine-run columns before creating indexes. Capture `logs/dev-latest.log`, confirm the current Electron build is running, and inspect the migration error before considering any destructive recovery.

## Developer reference

### Main components

| Area | Implementation |
| --- | --- |
| Shared workflow contract | `src/shared/routine-workflow.ts` |
| IPC channel names and renderer API types | `src/shared/types.ts` |
| Main Automations route | `src/renderer/App.tsx`, `src/renderer/components/Sidebar.tsx` |
| Studio UI | `src/renderer/components/AutomationStudioPanel.tsx` |
| Studio layout | `src/renderer/components/automation-studio.css` |
| IPC handlers and preload bridge | `src/electron/ipc/routine-handlers.ts`, `src/electron/preload.ts` |
| Routine lifecycle and trigger compilation | `src/electron/routines/service.ts` |
| Operation catalog and templates | `src/electron/routines/workflow/catalog.ts`, `templates.ts` |
| Prompt-to-draft matching | `src/electron/routines/workflow/generator.ts` |
| Graph and settings validation | `src/electron/routines/workflow/validation.ts` |
| Variable resolution and comparisons | `src/electron/routines/workflow/variables.ts` |
| Deterministic execution | `src/electron/routines/workflow/engine.ts` |
| Action adapters | `src/electron/routines/workflow/action-executor.ts` |
| Versions, runs, steps, inbox, and samples | `src/electron/routines/workflow/repository.ts` |
| Google polling starters | `src/electron/routines/workflow/google-starter-watcher.ts` |
| Secure webhook secrets | `src/electron/routines/workflow/secret-store.ts` |
| Signed webhook transport | `src/electron/routines/workflow/signed-webhook.ts` |

### Persistent tables

- `automation_routines`: compatibility Routine definition and active workflow reference.
- `routine_runs`: product-level run summary, including `workflow_run_id` when backed by the structured engine.
- `routine_workflow_versions`: immutable numbered draft/active/archived definitions.
- `routine_workflow_runs`: version-pinned run state, context, output, idempotency key, and timestamps.
- `routine_run_steps`: per-node status, attempts, redacted payloads, errors, and approval ids.
- `routine_event_inbox`: durable deduplicated event queue with claim/retry state.
- `routine_event_samples`: bounded samples for authoring and diagnostics.
- `routine_starter_cursors`: persisted Gmail, Drive, and time cursors used by poll-based starters.

All schema changes are additive. Legacy installations are migrated in place; upgrade troubleshooting must not instruct users to delete their app-data directory.

### Renderer IPC surface

The preload bridge exposes capability discovery, validation, generation, draft save, version listing/activation, test, run/step/event/sample listing, approval response, retry, cancellation, event enqueue, and secret list/upsert/remove methods. Their channels are the `routine:workflow*` constants in `IPC_CHANNELS`.

Always register the complete handler set through `setupRoutineHandlers(routineService)` before loading the renderer. A Vite-only renderer is not a supported desktop-runtime test.

### Layout contract

- Studio must remain a direct main-screen view selected by `currentView === "automations"`.
- Settings must not import or render `AutomationStudioPanel`.
- `.automation-studio-main` owns page scrolling and removes task-view width constraints.
- the template grid uses responsive columns rather than fixed row widths;
- the Builder uses bounded catalog/canvas/inspector columns at desktop width and collapses at smaller breakpoints;
- long labels and descriptions must wrap without changing neighboring column alignment;
- catalog and Activity lists scroll inside the available viewport.

### Validation

Run the focused workflow and renderer checks after changing Studio behavior:

```bash
npx vitest run \
  src/electron/routines/workflow/__tests__/validation.test.ts \
  src/electron/routines/workflow/__tests__/repository.test.ts \
  src/electron/routines/workflow/__tests__/engine.test.ts \
  src/electron/routines/workflow/__tests__/action-executor.test.ts \
  src/electron/routines/workflow/__tests__/google-starter-watcher.test.ts \
  src/renderer/components/__tests__/automation-studio-placement.test.ts \
  src/renderer/components/__tests__/automation-studio-layout.test.ts \
  src/renderer/components/__tests__/automation-studio-branching.test.ts
npm run type-check
npm run build:electron
npm run build:react
```

For a runtime failure, follow the project failure-triage contract: inspect `logs/dev-latest.log` first, use `logs/dev-latest.jsonl` when structured fields help, and run `npm run dev:log` when the existing capture is stale.

## Compatibility

Automation Studio is additive. Existing prompt-based Routines, task-sourced automations, schedules, hook mappings, event-trigger history, and Workflow Intelligence behavior retain their current storage and execution paths. Structured flows reuse the Routine shell for workspace, policy, and compiled trigger integration while keeping their versioned graph, deterministic runs, approvals, and durable event inbox in separate tables.
