# Context Compaction

CoWork OS automatically manages conversation context to prevent token overflow during long-running tasks. When the context window fills up, the system generates a comprehensive structured summary of earlier work — preserving user messages, decisions, file changes, errors, and pending tasks — so the agent can continue seamlessly without losing critical context.

## How It Works

```
Task starts → Context grows with each LLM turn
                    ↓
        Context reaches 90% capacity
                    ↓
    Proactive compaction triggers:
    1. Truncate oversized tool results
    2. Remove older messages (keep first + pinned + recent)
    3. Generate structured summary via LLM call
    4. Insert summary as pinned message
    5. Flush summary to memory for cross-session recall
                    ↓
    Agent continues near the 55% utilization target
    + comprehensive summary of all prior work
```

### Trigger Threshold

Compaction triggers at **90% context utilization** — aligned with OpenAI Codex CLI's threshold. Some desktop coding tools use ~95%. The 90% threshold balances context preservation with leaving enough room for a rich summary.

| Model | Context Window | Trigger Point |
|-------|---------------|---------------|
| Claude Sonnet/Opus | 200,000 tokens | ~180,000 tokens |
| GPT-4o | 128,000 tokens | ~115,200 tokens |
| GPT-3.5 Turbo | 16,000 tokens | ~14,400 tokens |

### Compaction Target

After compaction, context is reduced to **~55% utilization**. The freed ~35% provides room for the summary block plus ongoing conversation.

### Summary Budget

The summary LLM call is allocated up to **6,144 output tokens** (~24 KB of structured text). This is scaled proportionally for small-context models (capped at 8% of available tokens) to prevent the summary from dominating the context window.

| Model Context | Max Summary Tokens | Approximate Summary Length |
|---|---|---|
| 200K+ (Claude, GPT-4o) | 6,144 | ~24 KB / 9 detailed sections |
| 16K (GPT-3.5) | ~640 | ~2.5 KB / condensed sections |

### Chat Mode History Strategy

Explicit chat sessions use a different history strategy from task execution. Instead of letting the task pipeline grow with every follow-up, CoWork OS compacts long chat sessions into a cached summary plus a recent-message window, then reuses that summary on later turns.

This keeps follow-up questions in the same conversation thread while still preserving enough older context for ChatGPT-style back-and-forth.

## Summary Structure

The compaction summary follows a 9-section structured format, designed to capture everything an agent needs to continue work:

1. **Primary Request and Intent** — What the user originally asked for and evolving requirements
2. **User Messages** — Chronological list preserving exact wording of every user message
3. **Work Completed** — Step-by-step walkthrough: files created/modified/deleted, libraries installed, commands executed
4. **Errors and Fixes** — Every error encountered, with error messages and the fix applied
5. **Key Technical Details** — Code patterns, config values, API responses, file paths, function names
6. **Decisions Made** — Architectural choices, approach selections, user-approved directions
7. **Pending/Incomplete Work** — Tasks started but not finished, or requested but not addressed
8. **Current State** — What was actively in progress when compaction triggered
9. **Recommended Next Step** — What the agent should do next

### Handoff Framing

The summary is framed as a handoff document from a previous agent (inspired by Codex CLI's approach):

> *"A previous agent produced the structured summary below to hand off the work. Use this to build on the work that has already been done and avoid duplicating effort."*

This primes the model to treat the summary as authoritative context rather than a lossy cache of its own memory.

## Transcript Formatting

When preparing the dropped conversation for summarization, messages are formatted with role-aware token budgets:

| Message Type | Character Limit | Rationale |
|---|---|---|
| User messages | 3,000 chars | Highest priority — carry intent, corrections, feedback |
| Assistant text | 1,500 chars | Decisions and explanations |
| Tool results | 1,200 chars | Data retrieved, but large results already truncated |
| Tool use inputs | 800 chars | Mostly parameters, less critical |

Long messages are truncated with a head+tail strategy (70% head / 30% tail) to preserve both the beginning and any trailing instructions.

The total transcript budget for the summarizer is **90,000 characters** (~22,500 tokens), providing rich context for the summary LLM call.

## Timeline UI

When compaction occurs, the task timeline shows a **"Session context compacted"** event with:

- **Collapsible sections** — Each numbered section from the summary is rendered as a `<details>` element
- **Auto-expanded sections** — Primary Request (#1), Pending Work (#7), Current State (#8), and Next Step (#9) are expanded by default for quick scanning
- **Token stats** — Shows how many tokens were freed and how many messages were compacted
- **Proactive indicator** — Labels whether compaction was proactive (at 90%) or reactive (at 100%)

## Safety Mechanisms

### Overflow Guard

After the summary is generated, CoWork OS checks whether inserting it would push context back above 95% utilization. If so, the summary is progressively truncated while preserving the handoff preamble and tag structure.

### Reactive Fallback

If a single message pushes context past 100% without triggering the 90% proactive threshold (edge case), the existing reactive compaction still runs as a safety net with the same enhanced summary prompt and budget.

### Memory Persistence

Every compaction summary is flushed to the MemoryService and (if available) the workspace `.cowork/` daily log. This provides durable backup even if the in-context summary is later dropped by a subsequent compaction.

When **Durable Runtime Context** is enabled, compaction summaries are also recorded in the durable
runtime-context tables with links back to the source messages they summarize. Overlapping summaries
can link to parent summaries, forming a summary DAG rather than a flat list. Agents can recover these
summaries later in the same active task with `context_grep` and expand source links with
`context_describe`. See [Durable Runtime Context](durable-runtime-context.md).

### Pinned Messages

The compaction summary is stored as a **pinned message** with the `<cowork_compaction_summary>` tag. Pinned messages survive future compaction rounds — they are never removed by the message-removal strategy.

## Task Runtime Snapshots

Context compaction is separate from task-session persistence. Task execution writes a durable runtime snapshot into the task event stream so a task can resume with the same loop state, tool state, recovery state, and verification state after restart.

### Snapshot format

- `conversation_snapshot` remains the persisted event name for compatibility
- the payload schema is `session_runtime_v2`
- the payload includes transcript, tooling, files, loop, recovery, queues, worker, verification, and usage state
- the paired checkpoint payload can also carry a structured summary plus a verbatim evidence packet for post-compaction recall

### Checkpoint capture

The runtime now writes memory checkpoints natively instead of relying on external hooks:

- **pre-compaction**: always, before messages are removed
- **periodic long-run capture**: every 12 meaningful user/assistant exchanges, deduped by span hash
- **task completion**: when a task produced a non-trivial output or decision

Each checkpoint stores both:

- a compact structured summary for synthesis/restart paths
- a verbatim evidence packet made of exact transcript/message spans with provenance

### Restore precedence

When a task resumes, SessionRuntime restores state in this order:

1. Latest V2 checkpoint payload
2. Latest V2 `conversation_snapshot` payload
3. Legacy checkpoint payload with `conversationHistory`
4. Legacy `conversation_snapshot` payload with `conversationHistory`
5. Event-derived fallback conversation

If a legacy payload is restored, the next checkpoint rewrites it into V2 so the stored state is upgraded automatically.

## Configuration

Compaction behavior is controlled by constants in `src/electron/agent/executor-helpers.ts`:

| Constant | Default | Description |
|---|---|---|
| `PROACTIVE_COMPACTION_THRESHOLD` | `0.90` | Context utilization ratio that triggers compaction |
| `PROACTIVE_COMPACTION_TARGET` | `0.55` | Target utilization after compaction |
| `COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS` | `6144` | Maximum tokens for the summary LLM call |
| `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS` | `500` | Minimum viable summary budget |
| `COMPACTION_SUMMARY_MAX_INPUT_CHARS` | `90000` | Maximum transcript characters sent to summarizer |

## Comparison with Other Tools

| Feature | CoWork OS | Codex CLI | Higher-threshold CLI |
|---|---|---|---|
| Trigger threshold | 90% | 90% | ~95% |
| Summary budget | 6,144 tokens | Unlimited | Undisclosed (~3-5K observed) |
| Summary structure | 9 sections (structured) | 4 sections (structured) | Unstructured |
| Post-compaction target | 55% utilization | ~10-15% (full replacement) | Undisclosed |
| Approach | Selective removal + summary | Full history replacement | Selective + summary |
| Customizable | Constants in source | Config + prompt override | CLAUDE.md + /compact args |
| Memory persistence | MemoryService + kit log | Ghost snapshots | Background summarization |
| UI visibility | Collapsible timeline event | Terminal warning | Not displayed |

## Architecture

### Key Files

| File | Role |
|---|---|
| `src/electron/agent/context-manager.ts` | Token estimation, compaction strategies, proactive compaction |
| `src/electron/agent/executor.ts` | Summary generation, proactive trigger, overflow guard, memory flush |
| `src/electron/agent/runtime/SessionRuntime.ts` | Task-session snapshot ownership, resume precedence, and runtime projection |
| `src/electron/agent/executor-helpers.ts` | Tunable constants |
| `src/electron/memory/DurableContextService.ts` | Optional task-scoped durable message/summarization index with source links, large-payload refs, and summary DAG parent links |
| `src/electron/agent/tools/system-tools.ts` | `context_grep` and `context_describe` tool definitions and active-task scope enforcement |
| `src/renderer/components/TaskTimeline.tsx` | Compaction event rendering with collapsible sections |
| `src/renderer/styles/index.css` | Summary section styling |

### Event Flow

1. **Pre-compaction checkpoint** — Before any message removal, the runtime writes a durable checkpoint with structured summary + verbatim evidence packet
2. **Pre-compaction flush** — If context slack < 1,200 tokens, a durable summary is flushed to memory *before* any messages are removed
3. **Proactive compaction** — At 90% utilization, `proactiveCompactWithMeta()` compacts to 55%
4. **Summary generation** — `buildCompactionSummaryBlock()` calls the LLM with the structured prompt
5. **Overflow guard** — Ensures summary + remaining messages stay below 95%
6. **Pinned insertion** — Summary upserted as a pinned `<cowork_compaction_summary>` user message
7. **Memory flush** — Summary stored in MemoryService for cross-session recall
8. **Durable context write** — If enabled, source messages and summary rows are stored in task-scoped durable runtime context
9. **UI event** — `context_summarized` event emitted for timeline rendering
10. **Reactive fallback** — Standard `compactMessagesWithMeta()` runs if proactive didn't trigger
