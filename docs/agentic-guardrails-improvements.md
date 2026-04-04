# Agentic Guardrails Improvements

**Date:** 2026-03-06
**Branch:** main
**Commits:** 82709df3 and prior
**Goal:** Reduce task failures caused by overly conservative guardrails and loop detection. Competing coding-agent products give the LLM more room to iterate, retry, and self-correct; these changes bring our agent closer to that baseline.

---

## Root Causes Identified

| # | Root Cause | File | Impact |
|---|---|---|---|
| 1 | Tool disabled after just 2 consecutive failures | `executor-helpers.ts` | High |
| 2 | Exact-same tool call deduplicated after only 2 occurrences | `executor.ts` | High |
| 3 | Completion validator rejects short "done" responses even after tool success | `completion-checks.ts` | High |
| 4 | Progress score counts only file writes; reading/searching code scores as zero | `progress-score-engine.ts` | High |
| 5 | Per-step iteration cap too low (16); complex tasks regularly hit it | `executor.ts` | High |
| 6 | Global guardrail limits too conservative (50 iterations, 320 turns) | `guardrail-manager.ts` | Medium |
| 7 | Loop detection thresholds too aggressive; legitimate fix-cycles (read→edit→test) flagged | `completion-checks.ts`, `executor.ts`, `executor-loop-utils.ts` | Medium |
| 8 | 30-minute step timeout insufficient for deep work | `executor-helpers.ts` | Medium |
| 9 | Context compaction removes error-recovery context for active files | `context-manager.ts` | Medium |
| 10 | When a tool is disabled, agent has no fallback suggestion — just stops | `executor.ts`, `executor-helpers.ts` | Medium |

---

## Phase 1 — Relax Circuit Breakers

### 1a. Tool Failure Tracker (`src/electron/agent/executor-helpers.ts`)

**Problem:** A tool was permanently disabled after just 2 consecutive failures. A shell command failing twice (e.g., due to a typo being fixed) disabled `run_command` for the rest of the task.

| Constant | Before | After | Reason |
|---|---|---|---|
| `MAX_TOOL_FAILURES` | `2` | `5` | 2 was too aggressive; 5 allows normal iteration |
| `cooldownMs` | `5 * 60 * 1000` (5 min) | `2 * 60 * 1000` (2 min) | Faster re-enablement after cooling down |
| `maxInputDependentFailures` | `4` | `8` | Input-dependent errors (ENOENT, syntax) indicate the LLM is iterating, not stuck |

**Tool-specific `getMaxInputDependentFailures` thresholds:**

| Tool | Before | After |
|---|---|---|
| `run_applescript` | `8` | `12` |
| `browser_*` | `6` | `10` |
| `run_command` | *(not set)* | `10` (new entry) |

**New method added:** `getDisabledToolNames(): string[]` — returns names of currently disabled tools, used by graceful degradation (Phase 6).

**New `run_command` guidance in `getAlternativeApproachGuidance`:**
- "command not found" → suggest installing the package or using full path
- "permission denied" → suggest checking permissions or using a different approach
- "non-zero exit" → clarify the command itself failed (normal during development), not the tool

---

### 1b. Tool Call Deduplicator (`src/electron/agent/executor.ts`)

**Problem:** The same exact tool call (e.g., re-reading a file after editing it) was blocked after just 2 occurrences within 60 seconds.

| Parameter | Before | After | Reason |
|---|---|---|---|
| `maxDuplicates` | `2` | `3` | Allow one more retry of the same call |
| `windowMs` | `60_000` (60 s) | `120_000` (120 s) | Wider window reduces false resets |
| `maxSemanticSimilar` | `2` | `4` | Legitimate search refinements were blocked at 2 |

---

### 1c. Completion Validation (`src/electron/agent/completion-checks.ts`)

**Problem:** The validator required minimum response lengths (40–120 chars) even when tool execution had already confirmed task completion. Short, correct responses like "Done." were rejected.

**Changes to `evaluateDomainCompletion`:**
- When `hadAnyToolSuccess` is `true`: accept any non-empty response without length checks. Tool evidence is sufficient proof of completion.
- Only reject truly empty responses (no text at all) in tool-backed scenarios.

**Reduced minimum lengths for non-tool-backed responses:**

| Domain | Before | After |
|---|---|---|
| `research` | `80` chars | `60` chars |
| `writing` | `120` chars | `80` chars |
| `general` / `auto` | `40` chars | `20` chars |

---

## Phase 2 — Better Progress Scoring (`src/electron/agent/progress-score-engine.ts`)

**Problem:** Only file writes counted as forward progress. An agent exploring a codebase, reading files, and running searches received a progress score of zero — triggering the no-progress circuit breaker prematurely.

**New signals added to `ProgressScoreAssessment` interface:**
```typescript
readOperations: number;
searchOperations: number;
toolSuccesses: number;
```

**Updated score formula:**

```
// Before
rawScore = stepCompleted * 1.0
         + writeMutations * 0.6
         + resolvedErrorRecoveries * 0.4
         - repeatedErrorPenalty          // (count - 1) * 0.8
         - emptyNoOpTurns * 1.0

// After
rawScore = stepCompleted * 1.0
         + writeMutations * 0.6
         + readOperations * 0.2          // NEW: read_file, list_directory, search_files, glob, find_in_file
         + searchOperations * 0.3        // NEW: web_search, web_fetch, search*
         + min(toolSuccesses, 5) * 0.1   // NEW: general tool successes, capped at 5
         + resolvedErrorRecoveries * 0.4
         - repeatedErrorPenalty          // (count - 1) * 0.4 — reduced from 0.8
         - emptyNoOpTurns * 0.3          // reduced from 1.0
```

**Penalty reductions:**
- `repeatedErrorPenalty` multiplier: `0.8` → `0.4` (fixing the same error is iterating, not looping)
- `emptyNoOpTurns` penalty: `1.0` → `0.3` (only penalize truly empty turns, not thinking/planning)
- Empty turn threshold tightened: only turns with `trimmed.length < 5` count as no-ops (was any whitespace-only message)

---

## Phase 3 — Increase Execution Limits

### 3a. Per-Step Iteration Limits (`src/electron/agent/executor.ts`)

| Constant | Before | After |
|---|---|---|
| `maxIterations` (step) | `16` | `32` |
| `maxIterations` (follow-up) | `20` | `32` |
| `maxMaxTokensRecoveries` (step) | `3` | `6` |
| `maxMaxTokensRecoveries` (follow-up) | `3` | `6` |
| `requestedMaxTurns` default | `100` | `150` |

---

### 3b. Global Guardrail Limits (`src/electron/guardrails/guardrail-manager.ts`)

| Setting | Before | After |
|---|---|---|
| `maxIterationsPerTask` | `50` | `100` |
| `defaultMaxAutoContinuations` | `3` | `5` |
| `defaultMinProgressScore` | `0.25` | `0.15` |
| `defaultLifetimeTurnCap` | `320` | `500` |
| `loopWarningThreshold` | `8` | `12` |
| `loopCriticalThreshold` | `14` | `20` |
| `globalNoProgressCircuitBreaker` | `20` | `30` |

---

### 3c. Step Timeout (`src/electron/agent/executor-helpers.ts`)

| Constant | Before | After |
|---|---|---|
| `DEEP_WORK_STEP_TIMEOUT_MS` | `30 * 60 * 1000` (30 min) | `45 * 60 * 1000` (45 min) |

---

## Phase 4 — Improve Loop Detection

### 4a. Loop Guardrail Configs (`src/electron/agent/completion-checks.ts`)

**`DEFAULT_LOOP_GUARDRAIL`:**

| Field | Before | After |
|---|---|---|
| `stopReasonToolUseStreak` | `6` | `8` |
| `stopReasonMaxTokenStreak` | `2` | `3` |
| `lowProgressWindowSize` | `8` | `12` |
| `lowProgressSameTargetMinCalls` | `6` | `8` |
| `followUpLockMinStreak` | `10` | `12` |
| `followUpLockMinToolCalls` | `10` | `12` |
| `skippedToolOnlyTurnThreshold` | `2` | `3` |

**`CODE_LOOP_GUARDRAIL`:**

| Field | Before | After |
|---|---|---|
| `stopReasonToolUseStreak` | `7` | `12` |
| `stopReasonMaxTokenStreak` | `3` | `4` |
| `lowProgressWindowSize` | `10` | `16` |
| `lowProgressSameTargetMinCalls` | `7` | `12` |
| `followUpLockMinStreak` | `6` | `10` |
| `followUpLockMinToolCalls` | `6` | `10` |
| `skippedToolOnlyTurnThreshold` | `3` | `5` |

**`NON_CODE_LOOP_GUARDRAIL`:**

| Field | Before | After |
|---|---|---|
| `stopReasonToolUseStreak` | `4` | `5` |
| `lowProgressSameTargetMinCalls` | `4` | `6` |
| `followUpLockMinStreak` | `8` | `10` |
| `followUpLockMinToolCalls` | `6` | `8` |
| `skippedToolOnlyTurnThreshold` | `2` | `3` |

---

### 4b. `detectToolLoop` Threshold (`src/electron/agent/executor.ts` + `executor-loop-utils.ts`)

| Location | Before | After |
|---|---|---|
| `detectToolLoop` default `threshold` parameter | `3` | `5` |
| `maybeInjectToolLoopBreak` hardcoded call | `3` | `5` |

**Productive-cycle exemption added to `detectToolLoop`:**

Before returning `true` for a detected loop, checks if the wider call window contains a *mix* of read-like and write-like tool categories:

```typescript
const widerWindow = recentCalls.slice(-(threshold + 3));
const allCategories = new Set(widerWindow.map((c) => c.tool));
const hasReadLike = [...allCategories].some((cat) =>
  /^(read|search|list|glob|find|get)/.test(cat),
);
const hasWriteLike = [...allCategories].some((cat) =>
  /^(write|edit|create|run|execute|shell|command|browser)/.test(cat),
);
if (hasReadLike && hasWriteLike) return false; // it's a fix-cycle, not a loop
```

This prevents `read_file → edit_file → run_command → read_file → …` from being classified as a degenerate loop.

---

## Phase 5 — Better Context Management

### 5a. Compaction Constants (`src/electron/agent/executor-helpers.ts`)

| Constant | Before | After |
|---|---|---|
| `PROACTIVE_COMPACTION_TARGET` | `0.50` | `0.55` |
| `COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS` | `4096` | `6144` |
| `COMPACTION_SUMMARY_MAX_INPUT_CHARS` | `60_000` | `90_000` |
| `COMPACTION_USER_MSG_CLAMP` | `3000` | `4000` |
| `COMPACTION_ASSISTANT_TEXT_CLAMP` | `1500` | `2500` |
| `COMPACTION_TOOL_USE_CLAMP` | `800` | `1200` |
| `COMPACTION_TOOL_RESULT_CLAMP` | `1200` | `2000` |

---

### 5b. Smart Message Retention (`src/electron/agent/context-manager.ts`)

**Problem:** During context compaction, older messages containing error-recovery context and prior decisions about actively-worked files were removed, causing the agent to lose crucial context mid-task.

**New helpers added:**
- `extractFilePathsFromMessages(messages)` — extracts file paths from message content using regex `/(?:\/[\w.@-]+){2,}(?:\.\w+)?/g`
- `messageReferencesActivePaths(message, activePaths)` — returns `true` if a message mentions any of the active file paths

**Enhancement to `removeOlderMessagesWithMeta`:**
1. Extracts file paths from the last 4 messages as the "active work context"
2. When pruning older messages, reserves up to 15% of the token budget for messages that reference actively-worked files
3. Active-file messages are kept preferentially; only removed if budget is fully exhausted

---

## Phase 6 — Graceful Degradation on Tool Failure

### 6a–6b. Tool Alternatives Injection (`src/electron/agent/executor.ts`)

**Problem:** When `computeToolFailureDecision` flagged a soft failure, the step loop immediately stopped — giving the agent no chance to switch approaches.

**`TOOL_ALTERNATIVES` mapping added:**
```typescript
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  browser_navigate: ["web_fetch", "web_search"],
  run_command:      ["run_applescript", "write_file"],
  edit_file:        ["write_file"],
  search_files:     ["glob", "list_directory"],
  web_search:       ["web_fetch", "browser_navigate"],
  web_fetch:        ["web_search"],
};
```

**Graceful degradation logic (`toolAlternativesInjected` flag):**
- On first soft-failure stop signal (not hard failure), injects a system message listing available alternative tools for the disabled tool(s)
- `toolAlternativesInjected` is set to `true` to prevent repeated injection
- Loop continues for one more iteration, giving the LLM a chance to use alternatives
- Only stops unconditionally on hard failures or if alternatives were already injected and tools still fail

### 6c. `run_command` Failure Guidance (`src/electron/agent/executor-helpers.ts`)

Enhanced `getAlternativeApproachGuidance` with `run_command`-specific messages:

| Error Pattern | Suggestion |
|---|---|
| `command not found`, `No such file or directory` | Check if the package needs installing; use full path; try a different command |
| `permission denied`, `EACCES` | Check file permissions; write a script file; use a different approach |
| `exit code [1-9]`, `non-zero exit`, `exited with` | Clarify the *command* failed (normal during dev), not the tool; read the error and retry |

---

## Test Updates

Four tests were updated to match the new thresholds:

| Test File | Test Name | Change |
|---|---|---|
| `executor-helpers-cache.test.ts` | `treats browser HTTP status failures as input-dependent` | Loop `i < 5` → `i < 9` (browser threshold 6 → 10) |
| `executor-helpers-cache.test.ts` | `treats missing-module runtime errors as input-dependent before disabling monty_run` | Loop `i < 3` → `i < 7` (general threshold 4 → 8) |
| `executor-step-failures.test.ts` | `fails fast after repeated policy-blocked tool-only turns with no text output` | Added third mock LLM response (threshold 2 → 3) |
| `completion-checks.test.ts` | `uses tighter follow-up lock thresholds for code-domain tasks` | Expected values `6` → `10` (CODE_LOOP_GUARDRAIL change) |

---

## Phase 7 — False-Positive Source Validation Guard (Post-deployment fix, 2026-03-07)

### Root Cause

A build task ("Create an app about breaking news references") failed at finalization with:

> `Task missing source validation: release/funding claims require web_fetch sources with explicit publish dates.`

The failure chain:
1. Task prompt contained "breaking news" → `taskLikelyNeedsWebEvidence()` returned `true`
2. The final agent response included "announcement/launch/release" wording — from HTML seed data the agent had just **written into the app** — not from real-world research claims
3. The agent had not called `web_fetch` (correctly — it was building an app, not fetching news)
4. `requiresStrictResearchClaimValidation()` returned `true` → finalization threw

**Two complementary fixes applied in `src/electron/agent/executor.ts`:**

### Fix 7a: Build-task escape hatch in `requiresStrictResearchClaimValidation`

```typescript
// Before
private requiresStrictResearchClaimValidation(candidate: string): boolean {
  if (!this.taskLikelyNeedsWebEvidence()) return false;
  return this.responseHasHighRiskResearchClaim(candidate);
}

// After
private requiresStrictResearchClaimValidation(candidate: string): boolean {
  if (!this.taskLikelyNeedsWebEvidence()) return false;
  // Build tasks that created files are not research tasks — the output describes
  // built artifacts, not factual claims about current events.
  const createdFiles = this.fileOperationTracker?.getCreatedFiles?.() || [];
  if (createdFiles.length > 0) return false;
  return this.responseHasHighRiskResearchClaim(candidate);
}
```

If the agent created any files during the task, it's a build task. Skip research claim validation.

### Fix 7b: Build-intent signals in `taskLikelyNeedsWebEvidence`

The method triggered on broad keywords like `"breaking"`, `"news"`, `"search"` even when the task was about *building a tool related to* those topics, not *fetching* them. Added build-intent counterweight:

```typescript
private taskLikelyNeedsWebEvidence(): boolean {
  const prompt = `${this.task.title}\n${this.task.prompt}`.toLowerCase();
  const researchSignals = ["news", "latest", "today", "trending", "breaking", ...];
  if (!researchSignals.some((signal) => prompt.includes(signal))) return false;
  // Build/creation tasks mentioning news-related keywords don't need web evidence.
  const buildSignals = [
    "create an app", "build an app", "make an app", "write an app",
    "create a tool", "build a tool", "create a website", "build a website",
    "implement", "develop an app", "develop a tool",
  ];
  if (buildSignals.some((signal) => prompt.includes(signal))) return false;
  return true;
}
```

This also prevents misleading step-context prompts (lines 16901–16909) from instructing the LLM to fetch news when it should be building something.

---

## Files Modified

| File | Nature of Changes |
|---|---|
| `src/electron/agent/executor-helpers.ts` | Circuit breaker constants, timeout, compaction constants, run_command guidance, `getDisabledToolNames()` |
| `src/electron/agent/executor.ts` | Deduplicator params, iteration limits, detectToolLoop threshold + exemption, tool alternatives + graceful degradation, source-validation false-positive fix |
| `src/electron/agent/completion-checks.ts` | Loop guardrail configs (3 presets), domain completion validation |
| `src/electron/agent/progress-score-engine.ts` | Progress formula, new signals (read/search/tool), reduced penalties |
| `src/electron/guardrails/guardrail-manager.ts` | Global limit defaults (7 constants) |
| `src/electron/agent/context-manager.ts` | Smart message retention, `extractFilePathsFromMessages`, `messageReferencesActivePaths` |
| `src/electron/agent/executor-loop-utils.ts` | `detectToolLoop` call threshold 3 → 5 |
| `src/electron/agent/__tests__/executor-helpers-cache.test.ts` | Updated 2 threshold-dependent test loops |
| `src/electron/agent/__tests__/executor-step-failures.test.ts` | Added third mock response to match new threshold |
| `src/electron/agent/__tests__/completion-checks.test.ts` | Updated expected followUpLock values |
| `src/electron/agent/__tests__/context-manager-compaction.test.ts` | Increased filler message size to exceed 8,000-token compaction threshold |

---

## Verification

- **TypeScript:** `npx tsc --noEmit` — no errors (unrelated GuardrailSettings.tsx errors pre-existed)
- **Tests:** `npx vitest run src/electron/agent/__tests__/` — **624/624 passed**
