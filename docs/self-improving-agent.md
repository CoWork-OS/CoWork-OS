# Self-Improving Agent Architecture

CoWork OS implements a multi-layered self-improvement system that learns from task outcomes, user corrections, and feedback patterns. Each layer operates independently and feeds into the next task's context via prompt injection.

## Architecture Overview

```
User Interaction
    |
    v
+---------------------+     +------------------------+     +---------------------------+
| UserProfileService  | --> | RelationshipMemory     | --> | System Prompt Injection   |
| (facts, preferences)|     | (5-layer continuity)   |     |                           |
+---------------------+     +------------------------+     +---------------------------+
    |                                                               ^
    v                                                               |
+---------------------+     +------------------------+     +-------+---------+
| FeedbackService     | --> | MISTAKES.md            |     | PlaybookService |
| (rejection patterns)|     | (workspace-local)      |     | (task patterns) |
+---------------------+     +------------------------+     +-----------------+
    |                                                               ^
    v                                                               |
+---------------------+     +------------------------+              |
| MemoryService       | --> | Hybrid Search          | -------------+
| (core storage)      |     | (semantic + BM25)      |
+---------------------+     +------------------------+
```

## Layer 1: PlaybookService

**Purpose:** Captures what worked and what did not at the task level.

**Storage:** Tagged `[PLAYBOOK]` memories in MemoryService with type `insight`.

### Capture Triggers

- **Task success** — records approach, tools used, original request
- **Task failure** — records error category, attempted approach, lesson learned
- **Mid-task correction** — records user corrections detected during execution

### Error Classification

Failures are classified into 7 categories using regex-based pattern matching (no LLM calls):

| Category | Matches |
|----------|---------|
| `tool_failure` | Tool execution errors, command failures |
| `wrong_approach` | Invalid parameters, incorrect methods |
| `missing_context` | ENOENT, file not found, missing parameters |
| `permission_denied` | 403, EACCES, unauthorised access |
| `timeout` | ETIMEDOUT, deadline exceeded |
| `rate_limit` | 429, quota exceeded, billing errors |
| `user_correction` | `[CORRECTION]` tagged mid-task corrections |

### Time-Based Decay

When retrieving playbook context for a new task, entries receive a decay factor based on age:

- **0-30 days:** 1.0x (full relevance)
- **30-90 days:** 0.8x (slight penalty)
- **90+ days:** 0.5x (significant penalty)

This ensures the agent favours recent, proven patterns over stale ones.

### Reinforcement

When a task succeeds and similar playbook entries already exist, a `[PLAYBOOK] Reinforced pattern` memory is created. This naturally boosts proven approaches in future hybrid searches because more semantic overlap leads to higher ranking.

## Layer 2: MemoryService

**Purpose:** Core persistence layer with hybrid search.

**Key features:**
- Local embedding model for offline semantic search
- BM25 lexical search as complement
- Privacy filtering (auto-detects API keys, tokens, passwords, SSH keys)
- LLM-based compression for token efficiency (~10x reduction)
- Per-workspace settings (retention days, privacy mode, storage caps)

**Memory types:** `observation`, `decision`, `error`, `insight`, `summary`

**Agent-initiated save:** The `memory_save` tool allows agents to explicitly persist memories during task execution (types: `observation`, `decision`, `error`, `insight`). This closes the loop between automatic post-task capture and conscious mid-task learning — agents can now decide in real-time that something is worth remembering.

## Layer 3: UserProfileService

**Purpose:** Extracts and maintains user facts from conversation.

**Auto-extraction patterns:**
- **Name** — "my name is...", "call me..." (0.95 confidence, pinned)
- **Preferences** — "I prefer...", "I like...", "I dislike..." (0.75 confidence)
- **Location** — "I live in...", "I'm based in..." (0.7 confidence)
- **Goals** — "my goal is...", "I want to..." (0.65 confidence)

**Feedback ingestion:**
- Concise/detailed preference detection (0.85 confidence)
- Tone feedback (0.8 confidence)
- Rejected approach tracking (0.65 confidence)

**Confidence scoring:** 0-1 scale with `Math.max()` merge on duplicates. Facts sorted by pinned status, confidence, then recency.

## Layer 4: RelationshipMemoryService

**Purpose:** 5-layer relationship memory for continuity across sessions.

| Layer | Purpose | Example |
|-------|---------|---------|
| **Identity** | Name, role, key identifiers | "Preferred name: Alex" |
| **Preferences** | Communication style, format | "Prefers concise responses" |
| **Context** | Current projects, team, company | "Building a SaaS product" |
| **History** | Completed tasks, past interactions | "Completed task: deploy API" |
| **Commitments** | Open reminders, due dates | "Remind me to review PR by Friday" |

## Layer 5: FeedbackService

**Purpose:** Institutional learning from rejected/edited decisions.

**Mechanisms:**
- Captures rejected/edited decisions with reason text
- Aggregates patterns with occurrence counts
- Writes weekly feedback JSON logs to `.cowork/feedback/`
- Updates `.cowork/MISTAKES.md` with auto-section markers
- Prunes patterns older than 90 days

## Learning Flows

### Task Success Flow

1. Task completes successfully
2. `PlaybookService.captureOutcome("success")` records approach + tools
3. `PlaybookService.reinforceEntry()` finds matching playbook entries and creates reinforcement memories
4. `RelationshipMemoryService.recordTaskCompletion()` updates history layer

### Task Failure Flow

1. Task fails with error
2. `PlaybookService.captureOutcome("failure", errorMessage)` classifies the error into one of 7 categories and records the entry
3. Error category provides category-specific recovery context in future tasks

### Mid-Task Correction Flow

1. User sends a corrective message during task execution (e.g., "no, do it this way", "that's wrong", "actually I meant...")
2. Correction detector (regex-based, 12 patterns) identifies the correction
3. `[CORRECTION]` tagged insight memory captured in MemoryService
4. Playbook failure entry created with `user_correction` category
5. Future similar tasks see the correction in playbook context and avoid repeating the mistake

### User Feedback Flow

1. User gives thumbs down / rejects a decision
2. `FeedbackService` captures the pattern with count
3. `UserProfileService.ingestUserFeedback()` extracts preference facts
4. `RelationshipMemoryService.ingestUserFeedback()` updates preference/history layers
5. `.cowork/MISTAKES.md` updated with aggregated pattern

### Agent-Initiated Memory Flow (via `memory_save` tool)

1. During task execution, agent identifies something worth remembering (pattern, decision rationale, error resolution, factual observation)
2. Agent calls `memory_save` with content and type (`observation`, `decision`, `error`, `insight`)
3. `MemoryService.capture()` stores the memory with workspace scope, auto-detects sensitive data, and generates local embeddings
4. Future tasks receive the memory via hybrid search in system prompt injection and via the `search_memories` tool

### Manual Learning Flow (via `/learn` skill)

1. User invokes `/learn` with an insight, correction, preference, or rule
2. Agent stores the learning via task execution (MemoryService capture)
3. Agent appends to `.cowork/MEMORY.md` for human-readable, cross-session persistence
4. Preferences also reach UserProfileService through normal message ingestion

## Privacy and Safety

- All memories pass through `SENSITIVE_PATTERNS` filter (20+ patterns for API keys, tokens, passwords, SSH keys, etc.)
- Private memories are not shared externally but remain available to the local agent
- Workspace-level privacy modes: Normal, Strict, Disabled
- Content sanitised via `InputSanitizer.sanitizeMemoryContent()` before prompt injection
- Error messages truncated to prevent sensitive data leakage in playbook entries

## Comparison with ClawHub "self-improving-agent"

ClawHub's `pskoett/self-improving-agent` (v1.0.11) is a Claude Code skill that "captures learnings, errors, and corrections to enable continuous improvement." CoWork OS's self-improvement system is architecturally more comprehensive:

| Capability | ClawHub Skill | CoWork OS |
|------------|---------------|-----------|
| **Storage** | Flat file (likely LEARNINGS.md) | SQLite-backed MemoryService with hybrid semantic + BM25 search |
| **Memory layers** | Single file | 5 independent services (Playbook, Memory, UserProfile, Relationship, Feedback) |
| **Error classification** | None | 7 error categories with regex-based classification |
| **Search** | Text injection | Hybrid semantic (local embeddings) + BM25 lexical with relevance scoring |
| **Confidence scoring** | None | 0-1 confidence per fact with source tracking |
| **Time decay** | None | 3-tier decay (30d/90d thresholds) for playbook entries |
| **Pattern reinforcement** | None | Automatic reinforcement memories on task success |
| **Mid-task correction** | Feedback-time only | Real-time regex detection during task execution (12 patterns) |
| **Privacy filtering** | Unknown | 20+ sensitive data patterns, workspace privacy modes |
| **Feedback aggregation** | None | FeedbackService with pattern counts, weekly logs, MISTAKES.md |
| **User profile learning** | None | Auto-extraction of name, preferences, location, goals from conversation |
| **Relationship memory** | None | 5-layer relationship context with commitment tracking and due dates |
| **Compression** | None | LLM-based memory compression for ~10x token efficiency |
| **Manual learning** | Skill invocation | `/learn` skill + `.cowork/MEMORY.md` persistence |
| **Agent-initiated memory** | None | `memory_save` tool for explicit mid-task persistence + `search_memories` for on-demand recall |

The ClawHub skill provides a useful starting pattern for basic learning capture. CoWork OS extends this concept into a full multi-layered learning architecture with offline search, privacy controls, and institutional knowledge management.
