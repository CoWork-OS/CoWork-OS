# First-result onboarding and contextual connections

New users start with a task, before naming their assistant or completing a profile.
The opening screen offers a project update, inbox triage, a local meeting checklist,
and a comparison task, alongside an editable request. Suggestions fill the request;
only **Start task** submits it. **Personalize first** retains the existing guided
setup, and **Explore CoWork** enters the app without starting a task.

The task-first path reuses the selected model route when configured. Otherwise it
opens the existing model setup, preserving the request until setup succeeds. It
does not supply a free model or install a local model runtime. Quick setup leaves
existing identity, voice, memory, and workspace preferences alone. Model setup
still uses the existing credential storage and connection test.

After the existing security notice, a first task enters the normal task runtime
in the current workspace or a private starter workspace. Launch failure or
connector cancellation returns to the editable request. Pending requests stay in
renderer memory, rather than a new persisted prompt or credential store; a reload
before task admission does not recover that pending request. Once admitted, normal
task persistence applies.

## Contextual connector setup

For new tasks and local task follow-ups, explicit references to supported apps
can open **Connect apps for this task** before submission. The preflight supports
Gmail, Google Drive, Google Calendar, Notion, Box, Dropbox, OneDrive, SharePoint,
Linear, Jira, Asana, Salesforce, HubSpot, and Figma. It uses conservative source
phrases such as “from my Linear issues” and explicit `@Jira` mentions. Generic
inbox requests, comparison questions, negated sources, and named local exports
do not imply an account connection. This is a bounded preflight, not universal
app discovery or an agent-triggered setup tool during execution.

Readiness reuses native status and the existing MCP integration catalog, including
MCP alternatives for native integrations. Configured MCP credentials alone do not
count as connected. Google Workspace permission requirements remain visible, and
status checks time out into an actionable setup state.

**Set up** opens the existing connector details and OAuth/credential controls.
Closing those details returns to the pending request and refreshes readiness.
Users review accounts in those existing controls. **Continue task** submits the
original request, including its original workspace and attachments. **Continue
without connecting** permits the normal task to explain missing access or use an
authorized alternative. **Back to request** cancels submission. A second click
cannot replace an in-progress setup request. Connections do not change the task's
access profile or approval policy.

## Running-app acceptance

Use an isolated profile with the requested ChatGPT subscription configured. Do not
run the acceptance script against a working profile: it resets that profile's
onboarding and registers a read-only local MCP fixture named Linear.

```sh
COWORK_USER_DATA_DIR=/tmp/cowork-first-result-qa/profile \
COWORK_REMOTE_DEBUGGING_PORT=9355 \
COWORK_DEV_SERVER_PORT=5193 npm run dev
```

When another app instance uses the same Electron bundle, use a separate Electron
copy via `ELECTRON_OVERRIDE_DIST_PATH` and `COWORK_DEV_BRAND_APP=0`, preserving the
running app. Configure the QA profile through the existing provider controls.

```sh
COWORK_FIRST_RESULT_QA=1 \
COWORK_QA_CDP_URL=http://127.0.0.1:9355 \
node scripts/qa/first-result-onboarding-smoke.cjs
```

The smoke run exercises the real renderer, host API, MCP subprocess, ChatGPT model,
task runtime, and filesystem. It checks cancellation without task creation,
request restoration, connection through the existing UI, one task admission,
completion, and saved report content with tool readback. Its issue records are
synthetic and labelled as such; it does not prove third-party OAuth or live Linear
tenant access. Screenshots and an acceptance record go to
`output/playwright/first-result/`.

The script waits up to five minutes for completion and does not automatically
answer runtime approval requests. If the model chooses shell operations, inspect
each requested operation and use the existing approval controls as appropriate;
do not disable them to make acceptance pass. A timeout or paused task is not a
completed acceptance result, even when a report exists on disk.

A merged-source rerun also reproduced an existing limitation: applying the
built-in Summarize skill can leave file-writing tools unavailable for a later
report-writing step, which pauses with `mutation_tools_restricted_by_role`.
Successful shell writes alone do not clear that contract. Record this outcome
separately from a completed journey; connector readiness does not override skill
or worker restrictions.

Focused regressions cover named-source matching, negation, local exports, existing
connections, expired credentials, missing Google scopes, status timeouts, and
preservation of the final artifact requirement during read-only scope discovery.
