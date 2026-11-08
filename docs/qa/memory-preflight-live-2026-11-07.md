# Pre-flight memory validation — 7 November 2026

Pre-flight framing now receives policy-filtered memory from the same builder as planning
and execution. It retains source/review warnings and treats missing context as incomplete
evidence rather than proof that no agreement exists.

## Regression checks

The 13 new pre-flight regression cases failed against the previous implementation and
passed after the fix. The focused suite passed **136 tests across nine files**, including
the 13-case memory quality benchmark, source rechecks, execution-backed dreaming, selective
context, planning prompt budgets, and memory prompt surfaces. Type-check, lint, Electron
and Node daemon builds, and formatting checks for changed TypeScript files passed.

```sh
npx vitest run src/electron/agent/__tests__/executor-preflight-memory.test.ts src/electron/agent/__tests__/executor-memory-prompt-surfaces.test.ts src/electron/agent/__tests__/executor-planning-prompt-budget.test.ts src/electron/memory/__tests__/evals/memory-quality.eval.test.ts src/electron/memory/__tests__/evals/memory-quality-metrics.test.ts src/electron/memory/__tests__/MemorySourceRecheckService.test.ts src/electron/memory/repo/__tests__/MemoryRepoContext.test.ts src/electron/memory/repo/__tests__/MemoryRepoDreamer.test.ts src/electron/memory/repo/__tests__/memory-repo-dream-execution.test.ts
```

## Live production-runtime trial

The built Node daemon executed two tasks through its authenticated Control Plane on
`127.0.0.1`. Each used a separate disposable workspace. Synthetic memory was seeded through
`MemoryRepoService.remember`, corrected through `updateEntry`, and accompanied by a human
review rule. The tasks had 24 turns per window and a 32-turn lifetime limit, allowing
framing, planning, tools, verification, and finalization.

Both used the pinned model `nvidia/nemotron-3.5-lightning:free`, verified against the
[OpenRouter model catalog](https://openrouter.ai/api/v1/models) with zero prompt/completion
prices and tool support. An authenticated loopback bridge kept the saved provider key in
an isolated Electron process and enforced the pinned model and zero-price routing. The
production settings database was read-only; production memory and task data were not used.
The trial restricted tools to local files, recall, and tool discovery, with no shell,
network tools, or delegation.

| Task | Actual saved JSON | Terminal outcome |
|---|---|---|
| Memory enabled | `{"command":"npm run verify:auth-v2","requiresHumanReview":true}` | `completed`, `ok` |
| Memory disabled | `{"command":null,"requiresHumanReview":null}` | `completed`, `ok` |

Checks verified actual files on disk, successful `write_file` results, `file_created`
events, and `read_file` verification. The enabled pre-flight request contained the
corrected command and review rule, without the superseded command. No disabled-task
request contained the saved command or the memory-repository block, and the disabled task
emitted no memory attribution events.

The task pair used **31 live requests**. A separate replay of the enabled pre-flight input
with a larger output cap used one additional request: **32 of 40 authorized requests**,
all on the pinned free model, all reporting cost **0**. Combined reported usage was
164,859 input and 13,891 output tokens. The temporary daemon, development smoke process,
and bridge were stopped afterward. Fresh development logs confirmed isolated-profile
headless startup with no connected channels and Control Plane disabled for that smoke run.

## Limits

These are two synthetic tasks with one run each, not a representative production quality
measurement. The enabled pre-flight model exhausted its existing 400-token output cap
without returning text; the separate 1,024-token replay also exhausted its cap. This trial
verifies that the corrected context reaches pre-flight, not that this free model reliably
produces a framing answer within that cap. Neither replay replaces the original result.
The disabled task's derived strategy did not select pre-flight; its pre-flight privacy
gates are covered by the executable regression suite.

The traceability case is
[`preflight-memory-context-regression.json`](../../scripts/qa/eval-cases/preflight-memory-context-regression.json).
