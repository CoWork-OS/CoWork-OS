# JEV Harness Validation Record

Status: implemented and live-validated

Validation date: 2026-09-19

This record documents the runtime fixes that made Active JEV decisions visible
in real tasks and removed the headless approval deadlock. The user-facing
configuration and operating contract lives in [Jev Decision Support and
Harness](jev.md).

## Scope

The validation covered a bounded file task that required both a workspace
write and a validation command:

```text
Create northstar-notes.json with a project name, exactly three goals, exactly
three risks, and matching goalCount/riskCount fields. Use run_command to
validate the JSON and its counts. Both write_file and the validation command
are required. Do not browse, use network calls, delegate, or create other
files.
```

The same task was run in two fresh temporary workspaces using the same active
provider settings:

- Standard: JEV harness disabled.
- Full JEV: JEV enabled, Active harness mode enabled, active tool review, and
  all decision-family controls enabled.

Both tasks completed successfully and produced valid JSON. The full task's
`write_file` operation executed without `approval_unavailable` or
`interactive_approval_unavailable`.

## Runtime fixes

### 1. Foreground tasks reach real JEV strategy decisions

The adaptive task-strategy gate previously treated the route intent as a
reason to skip ordinary foreground tasks. Active mode now evaluates eligible
foreground tasks even when their initial route is a normal execution route.
Jev can return `single_agent`, `team`, `multitask`, or `verification`, but the
runtime applies the result only when deterministic eligibility checks pass.

The following remain outside this promotion boundary:

- explicit collaborative, multitask, multi-LLM, or verification tasks
- child/delegated tasks
- cron and subconscious/background tasks
- low-complexity tasks that do not need a provider decision
- tasks with a fixed model/profile or other explicit route authority

Low-confidence, invalid, unavailable, timed-out, or cost-guarded results
abstain and preserve the normal route.

Implementation: `src/electron/agent/daemon.ts` and
`src/electron/agent/jev/task-strategy-decision.ts`.

### 2. Headless Active tool review no longer creates an impossible prompt

The tool registry now resolves the task's effective access profile before
assembling the policy pipeline. When all of the following are true:

- the task is headless or owned by `cowork run`
- semantic Jev review is Active
- the effective profile is `bypass_permissions`
- the profile definition has `approval: never`
- deterministic permission evaluation already allowed the exact operation

an Active Jev `concerning` observation is recorded in the trace and the
operation remains allowed. It does not synthesize a second approval request
that no renderer or user can answer.

The exception does not weaken security. Hard policy, permission denials,
Numbat denials, protected paths, network restrictions, and mandatory operating
system consent still deny or stop the operation. Interactive tasks retain the
normal concerning-review approval path.

Implementation: `src/electron/agent/tools/registry.ts` and
`src/electron/agent/runtime/ToolPolicyPipeline.ts`.

Regression: `src/electron/agent/__tests__/tool-policy-pipeline.test.ts`.

### 3. Jev telemetry survives legacy LLM-index repair

The schema bootstrap previously created the LLM event table, its indexes, and
the Jev event table in one database operation. A duplicate legacy LLM source
ID could make the LLM unique-index creation fail before the Jev table was
created. The two DDL groups are now independent, so a repairable legacy LLM
index failure cannot suppress `jev_call_events` creation.

Implementation: `src/electron/database/schema.ts`.

Regression: `src/electron/database/__tests__/schema-jev-telemetry-migration.test.ts`.

### 4. The CLI and desktop runtime are built separately

The direct CLI imports the compiled Electron tree under `dist/cli/electron`;
the desktop app uses `dist/electron`. Rebuilding only Electron can therefore
leave `cowork run` on stale Jev policy and schema code. The source validation
contract is to rebuild both:

```bash
npm run build:electron
npm run build:cli
```

The Node-only CLI TypeScript configuration does not include the DOM library's
`RequestInfo` alias. The decision HTTP client now uses the portable
`DecisionFetch` type (`string | URL | Request`) so the CLI build validates the
same Jev transport code without requiring DOM types.

Implementation: `src/electron/agent/decisions/http-client.ts`.

## Live comparison

The fresh paired run produced these local ledger results:

| Metric | Standard | Full JEV |
| --- | ---: | ---: |
| Completion | completed | completed |
| Wall time | 131.927 s | 126.780 s |
| LLM calls | 9 | 10 |
| LLM input tokens | 33,552 | 42,195 |
| LLM output tokens | 5,868 | 5,857 |
| LLM total tokens | 39,420 | 48,052 |
| Jev calls | 0 | 4 |
| Jev input tokens | 0 | 3,407 |
| Jev output tokens | 0 | 390 |
| Jev total tokens | 0 | 3,797 |
| Jev provider-reported cost | $0 | $0.000143094 |
| Approval-unavailable errors | 0 | 0 |

The full run recorded successful calls for `task-strategy`,
`model-routing`, and `tool-review` (with a second tool-review call during the
run). The task-strategy and model-routing responses abstained for low
confidence, which is the intended safe fallback; the tool-review calls
completed successfully. This proves the calls are routed through the real Jev
provider and that the approval boundary is live.

This single pair does not prove an overall cost or token advantage. The full
run was approximately 3.9% faster but consumed more LLM tokens because Jev
abstained and the normal LLM execution path remained authoritative. Use
repeated paired runs and report LLM and Jev units separately before making an
ROI claim.

## Accounting and inspection

Jev usage is persisted independently from LLM usage in `jev_call_events`.
The provider-reported Jev cost is stored directly; it is not calculated with
the LLM pricing table. Cache hits retain a decision event but contribute zero
provider tokens and cost.

Useful inspection queries for a local task are:

```sql
SELECT purpose, status, COUNT(*) AS calls,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(cost) AS provider_cost
FROM jev_call_events
WHERE task_id = ?
GROUP BY purpose, status
ORDER BY purpose, status;

SELECT source_kind, status, COUNT(*) AS calls,
       SUM(input_tokens + output_tokens) AS tokens
FROM llm_call_events
WHERE task_id = ?
GROUP BY source_kind, status
ORDER BY source_kind, status;
```

Also inspect the task timeline for `jev_decision` events and the tool-policy
trace for `semantic_review`. A provider call with a safe `abstain` outcome is
different from a disabled decision family, a deterministic eligibility skip,
or a provider-unavailable fallback.

## Reproduction and regression checks

Focused regressions:

```bash
npx vitest run \
  src/electron/agent/__tests__/tool-policy-pipeline.test.ts \
  src/electron/agent/__tests__/daemon-jev-routing.test.ts \
  src/electron/database/__tests__/schema-jev-telemetry-migration.test.ts \
  src/electron/agent/jev/__tests__/jev-harness.test.ts
```

The validation run passed 31 tests. The following gates also passed:

```bash
npm run type-check
npm run build:electron
npm run build:cli
npx oxfmt --check <touched-files>
git diff --check
```

For future benchmark runs:

1. Use fresh, isolated workspaces and the same provider/model settings.
2. Use a task that requires an observable tool write plus an explicit
   validation step; response-only prompts cannot exercise tool review.
3. Keep the standard and Full JEV prompts identical.
4. Record wall time, completion/error state, artifacts, approval errors, LLM
   calls/tokens/cost, Jev calls/tokens/cost, purposes, and abstention reasons.
5. Repeat enough times to compare medians and both warm/cold cache behavior.
6. Treat Jev cost as a separate line item and do not add Jev tokens to LLM
   tokens when applying provider pricing.
