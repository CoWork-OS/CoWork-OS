# Unknown-memory pre-flight validation — 7 November 2026

The free-model trial for the output-budget fix produced an unsupported assumption that
no prior agreed command or review requirement existed, even though memory was withheld.
The model ignored the prompt's missing-context warning. This change makes no-evidence
framing application-owned instead of asking a model to invent assumptions from an empty
view.

## Behavior

If the selected memory blocks have no evidence references, pre-flight emits a fixed,
brief four-section framing without a model request. Its assumptions say:

> Details supplied by the current request remain authoritative. Any earlier agreement not established there has unknown status and contents for this turn.

Policy-withheld memory, empty retrieval, and unavailable stores with no remaining evidence
use the same framing. Repository instructions and database headings without references
do not count as facts. Explicit current-request agreements are not negated, and the
message does not ask to read withheld memory. Cancellation during retrieval emits no
framing; policy-resolution errors retain the existing fail-soft behavior.

The tradeoff is a generic optional framing for empty memory views, including new
workspaces. Task-specific model framing remains available when repository or database
evidence is retrieved. Its prompt now asks for supported facts and unresolved details
instead of requiring two or three assumptions.

## Regression checks

The pre-flight suite had 15 failures against the previous executor and passes all 31 cases
with the fix. Coverage includes the recorded unsupported model reply, task/workspace
memory-off, privacy/no-memory/group/public/verifier/sub-agent gates, empty and guidance-only
views, unavailable stores, database-only evidence, explicit current-request agreements,
and cancellation.

In total, **398 tests across 11 files passed**: the 71-test focused memory/framing suite
plus 327 entrypoint, plan-parsing, prompt-content, prompt-section, and chat-mode checks.
Type-check, lint, Oxfmt 0.75 checks, and Electron/Node daemon builds passed. Fresh isolated
headless development startup was captured with `npm run dev:log` and a dummy loopback
provider.

The core regression command is:

```sh
npx vitest run src/electron/agent/__tests__/executor-preflight-memory.test.ts src/electron/agent/__tests__/executor-memory-prompt-surfaces.test.ts
```

## Live production-stage validation

The built Node daemon created tasks through its authenticated loopback Control Plane in
a disposable profile. One workspace had synthetic command/review memory; another had no
saved facts. Checks compared the exact assistant message emitted into each task timeline
with the expected fixed framing or the actual provider response.

| Case | Framing | Upstream model requests |
|---|---|---:|
| Retrieved evidence | Model-generated; corrected command and review flag present | 2 |
| Memory disabled | Exact fixed unknown-context message | 0 |
| Empty memory in another workspace | Exact fixed unknown-context message | 0 |
| Memory disabled, current request states an agreement | Same fixed message, current-request authority preserved | 0 |

The control pinned `nvidia/nemotron-3.5-lightning:free`, checked against the current
[OpenRouter model catalog](https://openrouter.ai/api/v1/models) for zero prompt/completion
prices. Its first 4,096-token response was truncated with no text; the bounded 8,192-token
retry returned complete framing. Both requests reported cost **0**: 1,128 input and 8,127
output tokens combined. Two of the three remaining authorized calls were used, leaving
the cumulative allowance at 39 of 40.

The authenticated provider bridge bound only to `127.0.0.1`, pinned the free model,
enforced zero-price routing, and retained the original shared request counter. Saved
credentials stayed inside an isolated Electron process; production settings were opened
read-only. All task/memory inputs were synthetic. Tasks were stopped after framing;
later planning requests were blocked locally without contacting a model. The daemon,
bridge, and development smoke process were stopped afterward.

## Limits

This validates the production pre-flight stage, not full task completion or a statistical
reliability rate. No-evidence framing is intentionally generic. The evidence-present
control still asserted that no other agreements contradicted the retrieved values, which
was not established by its evidence. This fix does not validate every model-generated
claim when some memory references are present.

Traceability:
[`preflight-unknown-memory-regression.json`](../../scripts/qa/eval-cases/preflight-unknown-memory-regression.json).
