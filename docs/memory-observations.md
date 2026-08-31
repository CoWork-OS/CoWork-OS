# Structured Memory Observations

Structured memory observations are the inspectable metadata layer for CoWork OS archive memory.
They keep the existing local-first `memories` table authoritative, then add a sidecar index that
makes memory easier to search, audit, redact, suppress, and expand only when the agent needs full
detail.

The design was inspired by `claude-mem`-style observation cards, but implemented as a CoWork-native
SQLite sidecar rather than a new external memory store.

## Current Concept

CoWork memory now has four complementary shapes:

- **Curated hot memory**: short, prompt-visible facts and rules managed through curated memory.
- **Archive memory**: durable local memory rows stored in `memories`.
- **Structured observations**: metadata rows keyed by `memory_id` that describe archive memories with title, narrative, facts, concepts, provenance, files, tools, source events, privacy state, and migration status.
- **Durable runtime context**: optional task-scoped message and compaction-summary rows used only for active-task recall through `context_grep` and `context_describe`.

Structured observations are not a replacement for archive memory. They are an index and control
plane over it.

Durable runtime context is not a replacement for structured observations. It is a runtime continuity
lane for long active tasks, especially after context compaction. See
[Durable Runtime Context](durable-runtime-context.md).

Dreaming uses that index as evidence for memory curation. It can propose stale-memory archives,
corrections, open loops, recurring tasks, constraints, ignored-noise patterns, or curated-memory
updates, but those proposals are stored separately as reviewable Dreaming candidates.

## Data Model

Structured metadata is stored in `memory_observation_metadata`, keyed by `memory_id`.

The sidecar includes:

- `workspace_id`, `task_id`, `origin`, and `observation_type`
- `title`, `subtitle`, `narrative`, `facts`, and `concepts`
- `files_read`, `files_modified`, `tools`, and `source_event_ids`
- `content_hash`, `capture_reason`, `privacy_state`, `generated_by`, and `migration_status`
- `created_at` and `updated_at`

Full-text search indexes observation text, facts, concepts, file paths, and tool names through the
observation FTS table. The original `memories` row remains the source for full content and existing
archive recall behavior.

Dreaming state is stored outside the observation sidecar:

- `dreaming_runs` records each background curation pass.
- `dreaming_candidates` records each proposed memory maintenance action.

This separation keeps observation metadata descriptive and keeps memory curation reviewable.

## Capture Rules

`MemoryService.capture(...)` still creates the base archive row. When structured observations are
enabled, it also asks `MemoryObservationService` to create metadata for the new memory.

The runtime is intentionally selective. It should capture high-signal observations such as:

- completed task outcomes
- durable decisions
- errors and verification failures
- file create/modify evidence
- tool failures that affected the task
- accepted insights and curated promotions
- Chronicle-promoted context
- playbook outcomes
- explicit `memory_save` calls

It should not capture every tool call or every transient model thought.

Dreaming does not change capture rules. It reviews already-captured observations and transcript
evidence after the fact, then proposes maintenance when evidence suggests that memory is missing,
duplicated, stale, contradicted, or too noisy.

## Privacy Controls

Inline privacy markers are handled before automatic capture:

- `<no-memory>` disables automatic memory capture for that task content.
- `<private>...</private>` redacts that segment from captured memory and marks affected derived memory private when needed.

Observation privacy states are:

- `normal`: searchable and recallable under normal memory rules.
- `private`: local-only and excluded from external mirroring.
- `redacted`: content was replaced and the row is excluded from prompt recall.
- `suppressed`: hidden from prompt recall and default Memory Inspector search results.

Prompt recall checks both old prompt-recall ignore markers and observation privacy state. That means
suppressed and redacted observations are excluded from both search-based recall and recent-memory
prompt recall.

Supermemory mirroring remains additive and opt-in. Private, redacted, and suppressed local entries
must not be mirrored. When Memory Write Approval is enabled for external or background writes,
eligible mirror attempts are staged for review before leaving the device. Sensitive external-memory
payloads are blocked before they can be stored in the pending approval queue.

## Access profile boundary

Memory search, observation details, durable-context recall, and background
memory reads remain subject to the effective task [access
profile](access-profiles.md), workspace scope, and tool restrictions. Memory
tools cannot use a recall request to widen filesystem, network, command-tool,
or cross-task access. Memory writes also remain subject to the separate Memory
Write Approval policy; an access profile cannot turn a blocked or unavailable
write into an allowed one.

## Backfill And Migration

Backfill is deterministic and local. It derives titles, narratives, facts, concepts, and file paths
from existing memory content and summaries without per-row LLM calls.

Backfill does not run as a synchronous startup write path. Startup only initializes the service.
The Memory Hub can show status and trigger a rebuild action explicitly.

Backfill status tracks:

- total memory rows
- processed rows
- failed rows
- pending rows
- running state
- last run time
- last error

If metadata creation fails for a row, that row increments `failed`, not `processed`.

## Progressive Recall Tools

Agents should use the progressive workflow for deep recall:

1. `memory_search_index`: compact search results with IDs, title, type, date, source label, files, concepts, snippets, and estimated token cost.
2. `memory_timeline`: compact neighboring observations around an anchor memory ID or query.
3. `memory_details`: full structured details for selected IDs only.

`search_memories` remains backward-compatible for broad archive lookup, but deep recall should prefer
the compact index -> timeline -> details sequence to reduce prompt tokens and avoid overloading the
model with unnecessary full memory content.

All agent-visible detail lookups are scoped to the active workspace.

Durable Runtime Context adds a narrower task-scoped workflow for compacted active-task recall:

1. `context_grep`: search sanitized task messages and source-linked compaction summaries for the active task.
2. `context_describe`: expand a selected durable context result, including linked source messages for summaries.

These tools default to the active task. A supplied `taskId` is ignored unless the user explicitly
asked to inspect that task and the tool call sets `explicitUserRequest: true`.

## Memory Hub Inspector

The Memory Hub Inspector is the primary user surface for structured observations.

It supports:

- search over observation metadata
- privacy filtering
- compact result rows with source labels and token estimates
- a detail drawer for title, narrative, facts, provenance, and timeline context
- metadata editing
- promotion to curated memory
- marking private
- suppressing prompt recall
- redaction
- confirmed soft-delete
- backfill status and explicit rebuild

Delete from the inspector is a soft-delete operation. It marks the observation `suppressed`, keeps a
minimal local metadata record, marks the underlying memory private, and excludes it from default
search and prompt recall. It does not directly delete another workspace's memory row.

Dreaming candidates should eventually appear beside these inspector workflows rather than bypassing
them. Accepting a Dreaming candidate should call the same owning memory service that a manual
inspector action would use.

## IPC And Security Boundary

Mutation IPC calls must include `workspaceId` and `memoryId`.

The service verifies ownership by loading the observation with both IDs before mutating it. Update,
delete, redact, and promote cannot act on a memory outside the requested workspace.

Observation update patches are validated before reaching the service:

- only known editable fields are accepted
- `privacyState` is an enum
- arrays are capped
- strings have length limits
- unknown keys are rejected

This protects the FTS index from accidental oversized writes and prevents invalid array payloads from
throwing inside metadata serialization.

## Testing Expectations

Structured observation changes should include tests for:

- fresh database schema creation
- legacy database migration
- deterministic backfill and idempotency
- failed metadata writes reporting `failed`
- FTS insert/update/delete behavior
- workspace-scoped mutations
- soft-delete suppression
- `<no-memory>` and `<private>` handling
- prompt recall exclusion for redacted and suppressed observations
- progressive recall tool behavior
- durable runtime context enablement, active-task scoping, clear-memory deletion, durable-result echo filtering, direct-fact ranking, large-payload references, and summary-DAG parent links
- Memory Hub Inspector loading, editing, redaction, promotion, suppression, and rebuild flows
- Dreaming evidence use, candidate review state, and accepted-candidate application through owning memory services

The native SQLite suite may be skipped on machines where `better-sqlite3` cannot load. Keep mock-level
tests for service behavior that must remain covered without native SQLite, especially startup
backfill behavior, failure accounting, workspace scoping, and prompt-recall suppression.
