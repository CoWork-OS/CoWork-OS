# Memory quality benchmark

Run `npm run qa:memory-quality` for a controlled, offline replay of synthetic task histories.
It is also included in `npm run qa:memory-evals` and the existing `qa:harness` CI gate.
Git and a working Node-native `better-sqlite3` binding are required. The dedicated command
fails when a dependency is missing, rather than reporting skipped evaluations as a pass.

Each case creates a temporary Git memory repository and an in-memory SQLite source ledger.
The replay runs the real memory-folder writer, source tracking and file-change detection,
runtime receipt builder, dream task lister, dreamer, review acceptance, injection policy,
prompt renderer, and unified recall service's production `repo` lane and access scope.
History tasks/events are fixture adapters; the dream model's JSON proposal is scripted.
No commands from the corpus are executed, and no model, network service, desktop session,
or user profile is used. Temporary repositories and SQLite connections are cleaned up even
when a responder fails.

## Paired task probes

All three arms share the same retained history and held-out question: selective memory
(`enabled`), memory disabled (`disabled`), and previous file-order context (`baseline`).
The baseline omits the query from the same renderer and uses identical tool recall. The disabled arm denies
prompt injection and tool access through the production policy/scope. It does not receive
conversation history as a substitute. A deterministic responder sees only:

- the new question;
- the rendered memory context;
- the top five full recall results.

It selects a backtick-delimited command, or abstains when there is none. The current question
takes precedence, and rows marked unreviewed or source-changed are declined. Answer keys,
forbidden commands, fixture IDs and history steps are available only to the grader. A
`QualityResponder` interface allows another responder to consume the same inputs; the report
labels custom probes separately.

The thirteen cases cover user-quoted learning, accepted corrections, file-source corrections,
stale-source abstention, a conflicting command in another workspace, verified execution
lessons, pending and invalidated reviews, no-memory capture, a current-question control,
a current-question override of older memory, retrieval under prompt-budget pressure, and
retention of an unrelated explicit user rule. The budget-pressure test requires the useful
command to be absent from the file-order prompt but present in the selective prompt and
in tool recall.

## Metrics and gates

The JSON fixture stores explicit answer keys and thresholds. The benchmark records each
arm and each case, then gates on:

| Metric | Definition | Current gate |
|---|---|---|
| Task-proxy success | Exact correct command or required abstention / cases | Enabled = 1.0 |
| Paired gain | Enabled success rate minus disabled success rate | At least 0.4 |
| Useful recall@5 | Recall-dependent cases with the exact command in the top five / recall-dependent cases | 1.0 |
| Unsupported command rate | Returned commands outside the allowed answer set / returned commands | 0 in selected/disabled arms |
| Stale command rate | Returned commands on the fixture's stale list / returned commands | 0 in selected/disabled arms |
| Forbidden exposure | Forbidden markers present in context or recall | 0 in selected/disabled arms |
| Estimated memory tokens | Combined rendered context and recalled text length / 4, rounded up | At most 4,000 per case |

The version-2 corpus also gates the file-order comparison: mean prompt-context token
reduction ≥ 5%, injected useful recall gain ≥ 0.10, no loss in task-proxy success or tool
recall, zero fixture-marked irrelevant notes in selected context, and required user-context
retention. These gates reject a no-op selector or an empty context used merely to save tokens.
See [Selective memory recall](selective-memory-recall.md) for the runtime selection policy.

Current-question controls are excluded from the recall denominator. Empty corpora, duplicate
IDs and no-positive-recall corpora fail. Correct abstentions cannot conceal loss of all useful
recall: separate recall and gain gates must pass. Token estimates include the prompt wrapper
and intentionally count recalled text again if it duplicates injected memory; they are not
provider token usage or monetary cost. Temporary path lengths can affect these estimates.

For an artifact:

```sh
COWORK_MEMORY_EVAL_REPORT_DIR=/tmp/cowork-memory-quality npm run qa:memory-quality
```

The existing eval reporter writes `memory-quality.json` with metrics, thresholds, failures,
per-case outcomes and the synthetic visible context/recall for all three arms. A failed gate exits
nonzero and still writes the grading report. Setup/replay errors fail the test directly.
Only checked-in synthetic data belongs in this corpus; the report includes its text.

## Interpreting results

This is an end-to-end **memory-folder pipeline benchmark with a deterministic task proxy**.
It detects broken writes, review/invalidation, stale-source handling, prompt visibility,
retrieval, access gating and grading. It does not measure natural-language synthesis quality,
LLM hallucination rates, actual execution success, latency, or live provider costs. Its
scripted responder's treatment of source warnings is an explicit assumption, not evidence
that every model follows them. The existing golden-recall, privacy and injection suites
continue to evaluate the other memory lanes.

Extend `src/electron/memory/__tests__/evals/fixtures/memory-quality.json` with new histories
and held-out probes. Keep expected answers separate from responder inputs. Do not lower a
threshold to accommodate a regression; inspect the report's paired evidence first. For a
future live-model comparison, preserve these inputs and independent answer keys, label the
provider/model and sampling settings, and report repeated-run uncertainty separately from
this reproducible CI baseline.
