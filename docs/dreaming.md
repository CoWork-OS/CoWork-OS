# Dreaming

Dreaming is CoWork OS's background memory-curation phase.

It is part of Workflow Intelligence, but it has a narrower job than Reflection:

- Reflection decides what recommendation or next action may be useful.
- Dreaming reviews recent work and memory evidence to propose memory maintenance.

Dreaming does not silently rewrite memory. It produces reviewable candidates that can later be accepted, applied, archived, or dismissed through the existing memory stack.

## Where It Fits

Workflow Intelligence now has five explicit parts:

| Layer | Responsibility |
|-------|----------------|
| `Memory` | Durable source of truth for preferences, workflow rules, corrections, open loops, recurring tasks, constraints, and ignored-noise patterns |
| `Heartbeat` | Scheduling and signal-readiness layer |
| `Reflection` | Internal evaluation layer for recommendations and next actions |
| `Dreaming` | Background memory-curation layer for stale, duplicated, missing, or drifting memory |
| `Suggestions` | User-facing review surface for next actions |

Dreaming keeps memory healthy between direct user actions. It is deliberately separate from the suggestion loop so memory maintenance does not have to masquerade as a task recommendation.

## Trigger Sources

Dreaming can run from two paths:

| Trigger | When It Runs | Scope |
|---------|--------------|-------|
| `task_completion` | After meaningful task completion and memory consolidation | The completed task's workspace and transcript evidence |
| `heartbeat` | When Heartbeat sees memory-specific pressure | The heartbeat workspace and signal family evidence |

Heartbeat-triggered Dreaming is limited to memory-relevant signals such as:

- `memory_drift`
- `correction_learning`
- `cross_workspace_patterns`

Generic heartbeat awareness, checklist cadence, or dispatch pressure should not run Dreaming by itself.

## Evidence Sources

Dreaming reads bounded evidence from existing sources:

- recent transcript spans and checkpoints
- structured memory observations
- curated hot memory
- task prompt and completion context
- heartbeat signal summaries when triggered by Heartbeat

It does not create a new memory store. It only indexes a Dreaming run and the candidates proposed from that run.

## Access Boundary

Background Dreaming is not an access-profile bypass. Heartbeat-triggered runs resolve the active
workspace's [access profile](access-profiles.md) before reading file-backed memory and transcript
evidence. The resulting read guard is applied to workspace-kit pressure checks and transcript
searches. If the profile cannot be resolved or a candidate path is outside the effective boundary,
that evidence is skipped and the run does not widen access or continue with an unrestricted read.

Dreaming candidates remain reviewable memory proposals. Profile selection does not authorize
silent filesystem writes; accepted changes still pass through the owning memory service and its
memory-write approval policy.

## Durable State

Dreaming writes two SQLite-backed records:

| Table | Purpose |
|-------|---------|
| `dreaming_runs` | One record per Dreaming pass, including trigger source, scope, status, task or heartbeat linkage, candidate count, and error state |
| `dreaming_candidates` | Reviewable proposed memory changes with target, action, confidence, rationale, evidence refs, and review/application status |

The run record gives Mission Control and diagnostics a traceable background event. The candidate record keeps each proposed memory change reviewable and auditable before it mutates durable memory.

## Candidate Types

Dreaming can propose:

- curated-memory additions, replacements, or archives
- stale or contradicted memory archives
- duplicate curated-memory cleanup
- corrections learned from user wording
- open loops and unresolved follow-ups
- recurring task candidates
- constraints and operating rules
- ignored-noise patterns
- topic-pack refresh/update candidates

Candidates are intentionally typed by action and target. A candidate that updates curated hot memory is different from a candidate that suggests a topic-pack refresh or records ignored-noise feedback.

## Review-First Contract

Dreaming follows the same safety stance as Workflow Intelligence:

- propose first
- preserve evidence refs
- avoid silent memory mutation
- apply only through existing Memory, Curated Memory, topic-pack, or Core Harness paths
- keep memory as the source of truth

Accepted candidates can later be applied through the owning memory service. Dismissed or archived candidates remain useful as feedback about what not to learn.

## Current Implementation

The current implementation is backend-first:

- `DreamingService` gathers bounded evidence and creates deterministic candidates.
- `DreamingRepository` persists runs and candidates.
- task-completion memory consolidation can launch Dreaming after the hot-path memory pass.
- Heartbeat can launch Dreaming when memory-specific signals justify it.
- `HeartbeatResult` carries Dreaming run metadata for traceability.

The current candidate generator is deterministic and heuristic-based. It is designed to be safe and explainable before adding any LLM-based synthesis.

There is not yet a dedicated renderer review queue. Until that surface exists, Dreaming state is persisted for backend inspection, tests, and future Mission Control or Memory Hub integration.

## Non-Goals

Dreaming is not:

- a second memory product
- a general scheduler
- a hidden task creator
- a replacement for Reflection
- a replacement for Memory Hub review controls
- an always-on LLM loop

Its job is memory hygiene: find likely stale, duplicated, contradicted, or missing memory and propose bounded maintenance.

## Related Docs

- [Workflow Intelligence](workflow-intelligence.md)
- [Heartbeat v3](heartbeat-v3.md)
- [Workspace Memory Flow](workspace-memory-flow.md)
- [Structured Memory Observations](memory-observations.md)
- [Core Automation](core-automation.md)
