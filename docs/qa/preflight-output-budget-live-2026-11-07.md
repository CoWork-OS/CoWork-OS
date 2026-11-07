# Pre-flight output budget validation — 7 November 2026

Pre-flight reasoning previously consumed the entire 400-token allowance without returning
framing text. The new policy requests at most 180 words with 4,096 output tokens of
headroom, permits one fresh retry at 8,192 after `max_tokens`, and uses a bounded 60-second
timeout per call. Task/context ceilings still apply. Usage is counted for every response;
truncated drafts are neither streamed nor emitted as complete framing. Exhaustion and
errors produce a diagnostic and normal execution continues.

## Regression checks

The focused suite passed **51 tests across five files**, including 23 pre-flight memory
and output-budget cases, memory prompt surfaces, LLM turn utilities, planning prompt
budgets, and the 13-case memory quality benchmark. Eight new regression cases failed against
the previous implementation. Coverage includes empty and partial truncation, one-retry
recovery, repeated exhaustion, explicit task/context ceilings, cancellation, budget
exhaustion, accounting, suppressed streaming, and empty/error responses.

```sh
npx vitest run src/electron/agent/__tests__/executor-preflight-memory.test.ts src/electron/agent/__tests__/executor-memory-prompt-surfaces.test.ts src/electron/agent/__tests__/executor-llm-turn-utils.test.ts src/electron/agent/__tests__/executor-planning-prompt-budget.test.ts src/electron/memory/__tests__/evals/memory-quality.eval.test.ts
```

Type-check, lint, Oxfmt 0.75 formatting, and Electron/Node daemon builds passed. An isolated
headless `npm run dev:log` startup was captured with a dummy loopback provider and no
connected channels.

## Live acceptance

The actual Node daemon created tasks through its authenticated loopback Control Plane.
Synthetic memory contained a command correction and a human-review requirement. Both
memory modes selected pre-flight framing. The checker verified the exact assistant
message emitted into the task timeline, its four sections, and a non-truncated provider
response. Tasks were deliberately cancelled after framing; later planning requests were
blocked locally without forwarding them to a model. This validates the production
pre-flight stage, not full task completion.

All requests pinned `nvidia/nemotron-3.5-lightning:free`, checked against the current
[OpenRouter model catalog](https://openrouter.ai/api/v1/models) for zero prompt/completion
pricing. An authenticated bridge bound only to `127.0.0.1` enforced the pinned model and
zero-price routing. Saved credentials stayed in an isolated Electron process; the
production settings DB was read-only. The daemon used a disposable profile, workspace,
and synthetic memory folder.

| Final case | Token cap | Reported output tokens, including reasoning | Emitted words | Result |
|---|---:|---:|---:|---|
| Memory enabled | 4,096 | 1,437 | 117 | Complete; corrected command and review rule present |
| Memory disabled | 4,096 | 2,062 | 141 | Complete; no saved command exposed |
| Same enabled input replayed at old cap | 400 | 400 | 0 | `length`; all output tokens consumed by reasoning |

The final production responses took approximately 9.8 and 24.9 seconds. No saved command
or repository block appeared in the disabled request. Both emitted messages matched the
provider text, with `stop` finish reasons. The controlled 400-token replay changed only
the token cap, preserving the model, prompt, and memory context.

An initial live implementation retained the old 25-second timeout. Its enabled case
returned text; its disabled case timed out before a 35.4-second provider response arrived.
Those results were preserved and motivated the bounded 60-second timeout. An earlier
fixture startup failure occurred before model calls and was corrected before validation.

The fix used **five free requests**, including the retained two-call initial trial and
the three final comparisons. All reported cost **0**, with 2,432 input and 9,502 output
tokens combined. This consumed five of the eight unused calls in the existing allowance
(37 of 40 cumulative). The temporary daemon, bridge, and development smoke process were
stopped afterward.

## Limits

There was one final sample per memory mode, not a statistical reliability estimate. The
8,192-token retry was covered by executable regressions and was not needed by the final
live cases. The disabled model still assumed that no prior agreement existed despite the
missing-context warning. This check proves complete output delivery and memory exclusion,
not universal factual correctness of a free model's assumptions.

Traceability:
[`preflight-output-cap-regression.json`](../../scripts/qa/eval-cases/preflight-output-cap-regression.json).
