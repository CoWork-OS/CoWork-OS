# Relationship Agent Architecture

## 1) Product Goal
CoWork OS should behave as a persistent personal agent that can:

- Talk naturally with the user, not only execute tasks.
- Understand user intent per message and choose the right operating mode.
- Remember the user across time (identity, preferences, context, history, commitments).
- Execute end-to-end actions safely and still finish with a complete response under pressure.

## 2) System Architecture

### A. Intent Layer (Conversation Brain)
- `IntentRouter` classifies every task prompt into:
  - `chat`
  - `advice`
  - `planning`
  - `execution`
  - `mixed`
- Output includes confidence, intent signals, and default conversation mode.

### B. Strategy Layer (Execution Brain)
- `TaskStrategyService` maps intent to execution strategy:
  - `conversationMode` (`chat` / `hybrid` / `task`)
  - `maxTurns`
  - `qualityPasses`
  - answer-first behavior
  - bounded research + timeout-finalize bias
- Strategy is embedded into prompt contract so execution is completion-oriented.

### C. Relationship Memory Layer (Memory Brain)
- `RelationshipMemoryService` stores structured continuity memory:
  - `identity`
  - `preferences`
  - `context`
  - `history`
  - `commitments`
- Memory is persisted in secure settings and merged into prompt context.
- `UserProfileService` remains active and now composes with relationship memory.

### D. Runtime Orchestration Layer (Daemon)
- On task creation:
  - derive intent + strategy
  - enrich prompt with strategy contract and memory context
  - default agent settings to fit intent
- On execution start:
  - re-apply strategy for legacy/queued tasks
  - persist strategy defaults when needed
- On completion:
  - record successful outcomes into relationship memory (top-level tasks).

### E. Reliability Layer (Completion Contract)
- Timeout recovery path in `TaskExecutor` already ensures best-effort final answer.
- Cancellation reason tracking distinguishes `user` cancellation from `timeout` cancellation to preserve completion behavior.
- Strategy contract explicitly reinforces:
  - answer-first
  - bounded loops
  - never end silently

## 3) Strategy

### Phase 1 (Implemented)
- Intent routing.
- Strategy derivation and prompt contract injection.
- Relationship memory service with layered storage and prompt context.
- Daemon lifecycle wiring (create, start, complete).
- Timeout recovery finalization (implemented in prior patch).

### Phase 2 (Implemented)
- Explicit soft-deadline switching before hard timeouts.
- Commitment lifecycle tooling (`open`, `done`, `due soon`) and reminders.
- Better mixed-mode orchestration defaults (`answer_first=true` in mixed/planning/advice strategy).

### Phase 3 (Implemented in API Layer)
- Explainable memory controls (read/update/delete) for relationship memory.
- Commitment retrieval endpoints (`open`, `due soon`) for proactive UX reminders.
- Personalization feedback loop from accepted/rejected suggestions persists into layered memory.

### UI Layer (Implemented)
- Memory Settings now exposes relationship memory controls:
  - list/edit/forget items
  - mark commitments done/reopen
  - view due-soon commitment reminders

## 4) Operations & Verification
- Use `docs/relationship-agent-uat.md` as the release acceptance checklist.
- Key runtime signal for cancellation diagnostics:
  - `Task cancelled - not logging as error (reason: <reason>)`
- Timeout cases should still produce a final user-facing answer via recovery finalization path.

## 5) Guardrails
- Keep shared-channel memory isolated unless explicitly trusted.
- Preserve approval boundaries for risky actions.
- Keep completion-first guarantees even when research is partial.
