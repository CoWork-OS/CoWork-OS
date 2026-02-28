# Reliability Flywheel (Eval + Risk Gates)

This document describes the reliability system added to CoWork OS to turn production failures into repeatable regressions, gate risky task completions, and harden releases.

## Goals

- Increase task reliability by replaying known failures continuously.
- Apply stronger review only when risk justifies it.
- Keep all reliability data local-first (no telemetry upload path required).
- Convert reliability policy from docs-only guidance into merge and release gates.

## Scope Implemented

- Phase 1 foundation: eval schema, local corpus, replay runner, baseline metrics.
- Phase 2 foundation: risk scoring and policy-driven tiered review gate.
- Phase 3 foundation: prompt architecture modularization, deduped shared policy blocks, skill routing budgets.
- Phase 4 foundation: nightly hardening workflow, PR-targeted eval gate, release hardening gate.

## Architecture

### Eval Data Model (SQLite)

Schema and migrations are in `src/electron/database/schema.ts`.

Added task-level reliability metadata:
- `tasks.risk_level`
- `tasks.eval_case_id`
- `tasks.eval_run_id`

Added eval tables:
- `eval_cases`
- `eval_suites`
- `eval_runs`
- `eval_case_runs`

Added indexes:
- `idx_tasks_risk_level`
- `idx_tasks_eval_case_id`
- `idx_tasks_eval_run_id`

### Shared Types and IPC

Added in `src/shared/types.ts`:
- `AgentConfig.reviewPolicy?: "off" | "balanced" | "strict"`
- `Task.riskLevel?: "low" | "medium" | "high"`
- `Task.evalCaseId?: string`
- `Task.evalRunId?: string`

IPC channels:
- `eval:listSuites`
- `eval:runSuite`
- `eval:getRun`
- `eval:getCase`
- `eval:createCaseFromTask`

Wired in:
- `src/electron/ipc/handlers.ts`
- `src/electron/preload.ts`

### Eval Runtime Services

Deterministic local eval service:
- `src/electron/eval/EvalService.ts`

Risk scoring + gate decision matrix:
- `src/electron/eval/risk.ts`

Risk scoring defaults:
- `+2` shell/git mutation evidence
- `+2` more than 5 changed files
- `+2` tests expected but missing test evidence
- `+1` repeated tool failures (`>2`)

Risk levels:
- `0-2`: low
- `3-5`: medium
- `6+`: high

Review policies:
- `off`: no extra gate behavior
- `balanced`: quality pass for mutating tasks, strict contract for medium/high, verification agent for high
- `strict`: quality pass for all, strict contract for all, verification/evidence for medium/high

### Daemon Enforcement Path

Completion flow computes risk and applies gate policy in:
- `src/electron/agent/daemon.ts`

Optional auto-policy defaults (for code/operations domains) can be enabled via env vars:
- `COWORK_REVIEW_POLICY_ENABLE_AUTO`
- `COWORK_REVIEW_POLICY_AUTO_DEFAULT` (`balanced` or `strict`)

## Eval Corpus and Replay Workflows

### Corpus Build

Script:
- `scripts/qa/build_eval_corpus.cjs`

Behavior:
- Extracts failed/partial/failure-class tasks into `eval_cases`.
- Sanitizes prompts for secrets/PII before storing `sanitized_prompt`.
- Links source task to case via `tasks.eval_case_id`.
- Adds case to `reliability-regressions` suite.

### Suite Replay

Script:
- `scripts/qa/run_eval_suite.cjs`

Modes:
- `deterministic`: evaluates case assertions against source task/events.
- `hooks`: triggers replay tasks through hooks, then evaluates assertions.

Both scripts use the `sqlite3` CLI (not `better-sqlite3`) and fail fast when the CLI is missing.

### Baseline Metrics

Computed in `EvalService.getBaselineMetrics(...)`:
- `taskSuccessRate`
- `toolFailureRateByTool`
- `retriesPerTask`
- `approvalDeadEndRate`
- `verificationPassRate`

## Prompt and Skill Reliability Hardening

### Modular Prompt Composition

Added shared prompt section module:
- `src/electron/agent/executor-prompt-sections.ts`

Capabilities:
- section-level token budgets
- total prompt budget composition
- optional section dropping by priority
- truncation and dropped-section reporting
- shared mode/domain policy builder

### Executor Integration

Wired into `src/electron/agent/executor.ts`:
- shared policy core reused across planning/execution/follow-up prompts
- explicit section budgets (role/context/memory/playbook/infra/personality/guidelines/tool descriptions)
- plan prompt total budget (`PLAN_SYSTEM_PROMPT_TOTAL_BUDGET`)
- execution/follow-up system prompt total budget (`EXECUTION_SYSTEM_PROMPT_TOTAL_BUDGET`)

### Skill Routing Controls

Skill shortlist and budget controls are in:
- `src/electron/agent/custom-skill-loader.ts`
- `src/electron/agent/tools/registry.ts`

Defaults:
- shortlist size `20`
- low-confidence threshold `0.55`
- fallback instruction to use `skill_list`
- hard cap on injected skill text

## CI, Nightly, and Release Gates

### PR Regression Policy Gate

New CI job in `.github/workflows/ci.yml`:
- `Regression Policy Gate`

Enforcement script:
- `scripts/qa/enforce_eval_regression_policy.cjs`

Policy:
- if PR indicates a production failure/incident fix, at least one eval case JSON under `scripts/qa/eval-cases/` must be added/updated.

PR template updated in:
- `.github/PULL_REQUEST_TEMPLATE.md`

### Targeted Eval Gate

Existing targeted eval gate now runs with Node 24 and installs `sqlite3` CLI before replay:
- `.github/workflows/ci.yml`

Path trigger:
- `src/electron/agent/**`
- `src/electron/agent/tools/**`

### Nightly Hardening

Workflow:
- `.github/workflows/nightly-hardening.yml`

Runs:
- eval corpus build
- deterministic eval suite
- battery suite (when hooks secrets exist)

Artifacts:
- grouped human-readable summary (`summary.md`)
- machine-readable report (`report.json`)

Stability-window behavior:
- non-blocking before cutoff
- blocking after cutoff (`HARDENING_REQUIRED_AFTER_UTC`)

### Release Hardening Gate

Workflow:
- `.github/workflows/release.yml`

Added job:
- `Hardening Release Gate`

Behavior:
- runs deterministic eval and battery checks
- applies same date-based strictness window
- blocks release after cutoff when hardening fails

## Local Developer Commands

```bash
# Build eval corpus from recent failures
npm run qa:eval:build -- --window-days 30 --limit 300 --suite reliability-regressions

# Run deterministic replay
npm run qa:eval:run -- --suite reliability-regressions --mode deterministic

# Enforce PR production-failure regression policy (CI uses PR event context)
npm run qa:eval:enforce-regressions

# Full reliability loop (eval + battery)
npm run qa:reliability
```

Optional DB override:
```bash
COWORK_DB_PATH=/tmp/cowork-eval.db npm run qa:eval:run -- --suite reliability-regressions --mode deterministic
```

## Local-Only Data Policy

- Reliability data is stored in local SQLite (`userData/cowork-os.db`).
- Eval corpus entries are sanitized before persistence.
- No required telemetry upload path is introduced by this reliability system.

## Remaining Non-Code Work

The following require runtime history, not new code:
- 90-day KPI attainment proof (`+15% eval pass`, `-30% repeated tool failure loops`, `-25% verification-failed-after-complete`).
- Trend monitoring and policy tuning over real task volume.

## Source Map

Core implementation files:
- `src/electron/eval/EvalService.ts`
- `src/electron/eval/risk.ts`
- `src/electron/agent/daemon.ts`
- `src/electron/agent/executor.ts`
- `src/electron/agent/executor-prompt-sections.ts`
- `src/electron/database/schema.ts`
- `src/electron/database/repositories.ts`
- `src/electron/ipc/handlers.ts`
- `src/electron/preload.ts`
- `src/shared/types.ts`

Operational scripts and workflows:
- `scripts/qa/build_eval_corpus.cjs`
- `scripts/qa/run_eval_suite.cjs`
- `scripts/qa/enforce_eval_regression_policy.cjs`
- `.github/workflows/ci.yml`
- `.github/workflows/nightly-hardening.yml`
- `.github/workflows/release.yml`
