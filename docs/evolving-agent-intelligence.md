# Evolving Agent Intelligence

CoWork OS has a layered memory runtime, a full personality engine, 15+ channels, and a playbook system that auto-captures what worked. The **Evolving Agent Intelligence** layer connects these systems so the agent visibly improves over time — reducing correction overhead, aligning to communication preferences, and surfacing quantifiable ROI metrics.

All improvements are opt-in (admin-toggleable), rate-limited, and governed by the existing guardrail system. No changes to the security or local-first architecture.

Learning signals, playbook reinforcement, and trusted-pattern promotion do not
grant runtime access. Each resulting task still resolves an [access profile](access-profiles.md)
before tools run, and an improvement can only make an already-permitted action
more predictable or less interruptive within that profile's boundary.

---

## 0. Runtime Visibility

The learning loop is now visible as part of the task and operator experience, not just as backend plumbing.

- Task completion emits a standardized learning progression that shows memory capture, Dreaming candidate generation, playbook reinforcement, and skill proposal review state
- Mission Control and task detail views render the same progression so operators can inspect the evidence behind each step
- Unified recall spans tasks, messages, files, workspace notes, memory entries, and knowledge-graph context behind one search experience
- Persistent shell sessions preserve cwd, env deltas, and aliases per task/workspace for longer operator workflows
- Provider routing and fallback decisions are surfaced so automatic model changes are legible in real time

This layer is additive: it makes the learning loop easier to understand and trust while preserving CoWork OS's core surfaces of desktop control, channels, inbox, devices, and governed automation.

One concrete expression of this philosophy is `llm-wiki`: instead of letting research disappear into transient chat, CoWork can maintain a durable workspace-local knowledge base with raw-source preservation, linked notes, and deterministic vault-health analysis. See [LLM Wiki](llm-wiki.md).

### Retry-time reuse

The learning loop also feeds the live recovery path, not just post-task analytics.

- retrying turns reuse recent session evidence through `SessionRecallService.search(...)`
- pending verification checklist items are preserved across retries so recovery does not silently drop unfinished checks
- planning retries can pull in compact playbook guidance, while execution and follow-up retries rely on the normal layered memory runtime plus targeted recovery hints

This keeps retries closer to "continue from what already worked" than "start over from scratch."

---

## 1. Layered Memory Runtime

**File:** `src/electron/memory/MemorySynthesizer.ts`

### Problem

The old monolithic synthesized-memory block mixed durable facts, broad archive recall, and tactical hints into one injected blob. That made it too easy for archive memory to compete with higher-signal user/workspace facts, and it blurred the line between always-on memory and turn-specific recall.

### Solution

`MemorySynthesizer.synthesize()` now uses an explicit wake-up model with distinct roles and budgets:

1. **L0 Identity** in `<cowork_hot_memory>` for the facts that should stay front-and-center:
   - curated hot-memory entries from `CuratedMemoryService`
   - user profile facts
   - relationship memory
   - workspace-kit essentials
2. **L1 Essential Story** in `<cowork_structured_memory>` for ranked supporting context:
   - playbook patterns
   - daily activity summaries
   - Box Brain hits when available
   - the knowledge graph and archive memory are not part of this layer; the KG is reached through `kg_*` tools, and archive matches arrive through the per-turn recall block
3. **L2 Topic Packs** as explicit `.cowork/memory/topics/*.md` loads through `memory_topics_load`
4. **L3 Deep Recall** as explicit tools:
   - `search_quotes`
   - `search_sessions`
   - `search_memories`

Workspace kit context still renders separately before memory sections, and only `L0 + L1` are injected into the live prompt by default.

### Configuration

Default runtime behavior:

| Setting                        | Default                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `L0 Identity` injection        | `on`                                                                |
| `L1 Essential Story` injection | `on`                                                                |
| Archive memory injection       | `off` (`defaultArchiveInjectionEnabled: false`)                     |
| Quote/session/archive recall   | tool-driven (`search_quotes`, `search_sessions`, `search_memories`) |
| Topic packs                    | tool-driven (`memory_topics_load`)                                  |

### Curated-memory guardrails

- Curated entry content is capped at **320 characters**
- `match` strings for replace/remove are capped at **120 characters**
- `memory_curate` supports stable `id` values so replace/remove operations can be deterministic
- Curated file sync into `.cowork/USER.md` and `.cowork/MEMORY.md` is serialized per workspace and retried on file-change races

### Dreaming curation

Dreaming runs above the layered memory runtime as a review-first memory hygiene pass. It reads recent transcript spans, structured observations, and curated hot memory, then proposes `dreaming_candidates` for stale entries, corrections, open loops, recurring tasks, constraints, ignored-noise patterns, or curated-memory cleanup.

Dreaming does not change what is injected into prompts by itself. Candidates stay `proposed` because there is no review UI yet; once accepted, they are meant to flow through the owning memory service before they affect `L0`, `L1`, topic packs, or recall behavior.

### Sources

The runtime now thinks about sources by wake-up layer instead of one flat synthesis list:

| Layer                  | Sources                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **L0 Identity**        | `CuratedMemoryService`, `UserProfileService`, `RelationshipMemoryService`, workspace-kit essentials               |
| **L1 Essential Story** | `PlaybookService`, `DailyLogSummarizer`, Box Brain hits                                                            |
| **L2 Topic Packs**     | `memory_topics_load` over `.cowork/memory/topics/*.md`                                                            |
| **L3 Deep Recall**     | `search_quotes`, `search_sessions`, `search_memories`                                                             |
| **Dreaming Evidence**  | transcript spans, structured observations, curated hot memory, and heartbeat memory-drift signals                 |

`daily_summary` fragments come from `.cowork/memory/summaries/<YYYY-MM-DD>.md` files written by `MemoryConsolidator` through `DailyLogSummarizer` (see [Daily Summaries](#6-daily-summaries)).

### Output format

```xml
<cowork_hot_memory>
## Curated Hot Memory
- [Curated entry]

## You & the User
- [UserProfile fact]
- [RelationshipMemory item]
</cowork_hot_memory>

<cowork_structured_memory>
## Past Task Patterns
- [Playbook entry]

## Recent Summaries
[Daily summary snippet]
</cowork_structured_memory>
```

---

## 2. Adaptive Style Engine

**File:** `src/electron/memory/AdaptiveStyleEngine.ts`

### Problem

`PersonalityManager` has rich response style settings (emoji usage, response length, explanation depth, code comment style) but they are 100% manual. The agent never learns from observed user behaviour.

### Solution

`AdaptiveStyleEngine` observes every user message and feedback signal, then gradually shifts `PersonalityManager` settings within configurable rate limits.

**Signals observed:**
| Signal | How detected | Effect |
|--------|-------------|--------|
| Short messages | Rolling average of last 50 message lengths | Shifts `responseLength` toward `"terse"` |
| Emoji in messages | Fraction of messages containing emoji | Shifts `emojiUsage` toward `"moderate"` |
| Technical vocabulary | Density of tech terms (docker, kubernetes, nginx, …) | Shifts `explanationDepth` toward `"expert"` |
| "Too verbose" feedback | Regex on feedback reason | Shifts `responseLength` toward `"terse"` |
| "More detail" feedback | Regex on feedback reason | Shifts `responseLength` toward `"detailed"` |
| "No emoji" feedback | Regex on feedback reason | Shifts `emojiUsage` toward `"none"` |
| Expert/beginner signals | Regex on feedback reason | Shifts `explanationDepth` |

**Rate limiting:** Maximum `adaptiveStyleMaxDriftPerWeek` one-level shifts per 7-day window. Counter resets weekly. State persisted via `SecureSettingsRepository`.

**Audit trail:** Every adaptation is recorded in `getAdaptationHistory()` with dimension, from/to values, reason, and timestamp.

### Configuration (GuardrailSettings → Behavior Adaptation)

| Setting                        | Default | Description                                           |
| ------------------------------ | ------- | ----------------------------------------------------- |
| `adaptiveStyleEnabled`         | `false` | Master enable — no observation or adaptation when off |
| `adaptiveStyleMaxDriftPerWeek` | `1`     | Max style-level shifts per 7-day period               |

The **Behavior Adaptation** section in Guardrail Settings exposes these toggles alongside a **Reset learned style** button that calls `AdaptiveStyleEngine.reset()` via the `kit:resetAdaptiveStyle` IPC channel.

### Integration points

- `daemon.ts` — calls `AdaptiveStyleEngine.observe(text)` for each user message (after `AwarenessService.captureConversation()`)
- `daemon.ts` — calls `AdaptiveStyleEngine.observeFeedback(decision, reason)` for each `user_feedback` event; structured reasons such as `too_verbose` map directly to style signals
- `GuardrailSettings.tsx` — renders toggle, drift input, and reset button under "Behavior Adaptation"

---

## 3. Playbook-to-Skill Auto-Promotion Pipeline

**File:** `src/electron/memory/PlaybookSkillPromoter.ts`

### Problem

`PlaybookService` detects repeated successful patterns. `SkillProposalService` has a full admin approval workflow for new skills. They were not connected — no automation converted proven patterns into governed, reusable skills.

### Solution

Promotion reads the **Playbook evidence ledger** (`PlaybookEvidenceStore`), not memory text:

- Only terminal-ok executions record success evidence (observed runtime success, not proof the
  result was accepted). Best-effort, companion and ACP completions never do, and nothing is
  recorded when memory capture is disabled or skipped. Failures are kept as memory only.
- One execution is one row per task. Repeated callbacks, retries and follow-ups count once.
- The ledger stores identities and the approach key, not text. Titles, approaches and request
  excerpts are read from the source memory as stored, so memory privacy applies: evidence whose
  memory is private or suppressed in Memory Hub is never served.
- A new success is linked to earlier independent successes only when the requests pass a
  deterministic relevance gate (at least two distinctive shared terms and 0.35 weighted overlap)
  **and** the approach key (normalized tools and destinations) matches. A similar prompt alone
  is not proof that the same approach was used.
- When linked executions reach **3+ distinct executions** (configurable `threshold`),
  `PlaybookSkillPromoter.maybePropose()` generates a proposal whose problem statement and evidence
  describe "observed successful executions", each with its task and source memory, plus the
  provenance evidence IDs.
- Corrections invalidate the corrected task's success evidence; deleting or editing a source
  memory invalidates evidence that depends on it.

The proposal enters the existing `SkillProposalService` governance workflow — an admin reviews
the evidence and approves or rejects it. No skill is created automatically.

**Flow:**

```
Task finalizes with terminal ok
  → PlaybookService.captureOutcome() → recorded | skipped | error
  → PlaybookService.reinforceFromEvidence() creates durable links (or none)
  → only when links were created: PlaybookSkillPromoter.maybePropose()
    → findCandidates() counts distinct linked executions per approach
    → if count ≥ threshold: proposeSkill() via SkillProposalService.create()
```

**Legacy data.** Older `[PLAYBOOK] Reinforced pattern` memories are kept for history but are
never treated as proof, and generated Playbook rows are excluded from generic prompt recall and
archive synthesis. Pending auto-proposals created from that text are marked `unverified` and
cannot be approved until revalidated; already-approved skills stay installed and are flagged for
review. Summaries derived before this change carry no source lineage and cannot be proven clean
automatically; review them rather than purging.

**Cooldown:** 10 minutes per workspace between promotion checks. Max 1 proposal per check.

**Dedup:** `SkillProposalService.create()` handles duplicate detection — returns `duplicateOf` if a similar proposal already exists.

### Configuration

| Setting                       | Default  | Description                           |
| ----------------------------- | -------- | ------------------------------------- |
| `DEFAULT_PROMOTION_THRESHOLD` | `3`      | Min reinforcements before proposing   |
| `PROMOTION_COOLDOWN_MS`       | `10 min` | Min time between checks per workspace |
| `MAX_PROPOSALS_PER_CHECK`     | `1`      | Max new proposals per check           |

---

## 4. Cross-Channel Persona Coherence

**File:** `src/electron/memory/ChannelPersonaAdapter.ts`

### Problem

The agent connects to 15+ channels but delivers the same personality regardless of channel norms. A Slack reply should feel different from an email reply — not because the agent has different knowledge or values, but because each platform has its own communication culture.

### Solution

`ChannelPersonaAdapter.adaptForChannel()` takes the detected `originChannel` (from `task.agentConfig.originChannel`) and returns a channel-specific directive that is **appended to** (not replacing) the core personality prompt.

**Channel profiles:**

| Channel      | Length  | Formatting            | Emoji | Formal framing            |
| ------------ | ------- | --------------------- | ----- | ------------------------- |
| `slack`      | Shorter | Structured            | No    | No                        |
| `email`      | Longer  | Structured            | No    | Yes (greeting + sign-off) |
| `whatsapp`   | Shorter | Plain                 | Yes   | No                        |
| `imessage`   | Shorter | Plain                 | Yes   | No                        |
| `signal`     | Shorter | Plain                 | No    | No                        |
| `discord`    | Normal  | Structured + markdown | Yes   | No                        |
| `teams`      | Normal  | Structured            | No    | No                        |
| `telegram`   | Shorter | Minimal               | No    | No                        |
| `mattermost` | Normal  | Structured            | No    | No                        |
| `matrix`     | Normal  | Structured            | No    | No                        |
| `googlechat` | Shorter | Plain                 | No    | No                        |
| `twitch`     | Shorter | Plain                 | Yes   | No                        |

**Group/public context overlay:** When `gatewayContext` is `"group"` or `"public"`, an additional privacy-aware directive is layered on (do not share sensitive information, be aware others are reading).

### Configuration (GuardrailSettings → Behavior Adaptation)

| Setting                 | Default | Description                                |
| ----------------------- | ------- | ------------------------------------------ |
| `channelPersonaEnabled` | `false` | Enable channel-specific persona adaptation |

This toggle is exposed in the same **Behavior Adaptation** section as Adaptive Style.

### Integration

`executor.ts` injects the channel directive when assembling the system prompt:

```typescript
const channelDirective = ChannelPersonaAdapter.adaptForChannel(
  task.agentConfig.originChannel,
  gatewayContext,
);
// channelDirective is appended to personalityPrompt before budgeting
```

---

## 5. Evolution Metrics Service

**File:** `src/electron/memory/EvolutionMetricsService.ts`

### Problem

CoWork OS tracks basic relationship stats (tasks completed, days together) but has no concept of measuring agent _improvement over time_. For enterprise buyers, quantifiable ROI is the difference between a tool and a strategic investment.

### Solution

`EvolutionMetricsService.computeSnapshot()` computes 5 metrics on-demand from existing service data:

| Metric ID             | Label             | Source                                    | Interpretation                                     |
| --------------------- | ----------------- | ----------------------------------------- | -------------------------------------------------- |
| `correction_rate`     | Correction Rate   | PlaybookService (failure entries)         | Lower this week vs. prior 3-week avg → "improving" |
| `adaptation_velocity` | Style Adaptations | AdaptiveStyleEngine history               | Any adaptations applied → agent is learning        |
| `knowledge_growth`    | Knowledge Graph   | KnowledgeGraphService.getStats()          | Entity and relationship count                      |
| `task_success_rate`   | Task Success Rate | PlaybookService (success/failure entries) | Percentage of recorded tasks that succeeded        |
| `style_alignment`     | Style Alignment   | AdaptiveStyleEngine history               | Ratio of proactive vs. feedback-driven adaptations |

Each metric includes a `trend` (`"improving"` / `"stable"` / `"declining"`) and a human-readable `detail` string.

**Overall Score:** Composite 0–100 score weighted by trend directions and bonus points for high success rate and large knowledge graph.

### Daily Briefing integration

The `evolution_metrics` section is added to `BriefingSectionType` and enabled by default in `DEFAULT_BRIEFING_CONFIG`. `DailyBriefingService.buildEvolutionMetrics()` calls `EvolutionMetricsService.computeSnapshot()` and maps metrics to `BriefingItem[]`.

Example briefing output:

```
Agent Evolution (Day 45, 123 tasks completed):
  [+] Task Success Rate: 84% — 103 succeeded, 20 failed out of 123 recorded tasks
  [+] Knowledge Graph: 47 entities — 47 entities, 82 relationships, 310 observations
  [=] Correction Rate: 2/week — Correction rate is stable
  [+] Style Adaptations: 3 total — 89 messages observed, 3 adaptations applied
  [+] Style Alignment: 100% — No adaptations yet — using default style
  Overall Evolution Score: 72/100
```

---

---

## 6. Daily Summaries

**Files:** `src/electron/memory/DailyLogSummarizer.ts` (read and write), `src/electron/memory/MemoryConsolidator.ts` (writer)

### Purpose

Keeps a small per-day activity index in `.cowork/memory/summaries/<YYYY-MM-DD>.md` and turns recent days into ranked `daily_summary` fragments for the structured-memory lane. There is no separate raw daily log.

### How summaries are written

When `backgroundConsolidationEnabled` is on (default off), `MemoryConsolidator` runs after each completed task and calls `DailyLogSummarizer.appendTaskLine()`. Each task gets one line, replaced if the task is consolidated again the same day. A file keeps at most 40 lines of at most 200 characters. Raw transcript payloads are never copied in; files in the older "Consolidated Signals" layout are replaced on the next append. A consolidation lock older than 10 minutes (left by a crashed run) is removed.

### Summary file format

```md
---
updated: 2026-03-14
source: daily_log_synthesizer
day: 2026-03-14
---

## Task Activity
- [task:<id>] 15:30 UTC: <task prompt excerpt> (12 transcript events)
```

These summaries are an activity index, not a synthesis of decisions, preferences or lessons.

### Retrieval ranking

| Source          | Base relevance       | Notes                      |
| --------------- | -------------------- | -------------------------- |
| `user_profile`  | 0.70                 | Always somewhat relevant   |
| `daily_summary` | 0.55 × recency decay | Recency half-life = 7 days |

### Integration

`MemorySynthesizer.synthesize()` calls `DailyLogSummarizer.getRecentSummaryFragments()` for the last 7 days and adds the results to the structured-memory lane as `daily_summary` fragments. They render under `## Recent Summaries` inside `<cowork_structured_memory>`.

`DailyLogSummarizer.countRecentSummaries(workspacePath, 7)` returns the number of summary files in the last 7 days; `LayeredMemoryIndexService` uses it.

---

## 7. Message Feedback

**UI:** `src/renderer/components/MainContent/MainContent.tsx` (assistant-message feedback controls)

**IPC:** `kit:submitMessageFeedback` → validated, then logged as a `user_feedback` task event

### Interaction

The latest completed assistant message exposes 👍 / 👎 controls for message-level feedback. Thumbs-down uses the following structured reason vocabulary:

| Reason key             | Label                |
| ---------------------- | -------------------- |
| `incorrect`            | Incorrect            |
| `too_verbose`          | Too verbose          |
| `ignored_instructions` | Ignored instructions |
| `wrong_tone`           | Wrong tone           |
| `unsafe`               | Unsafe / unwanted    |

### IPC payload

```ts
window.electronAPI.submitMessageFeedback({
  taskId: string,
  messageId?: string,          // present for message-scoped feedback
  decision: "accepted" | "rejected",
  reason?: string,             // one of the keys above
  note?: string,               // optional free-text (future)
});
```

The daemon handles the `user_feedback` event: it archives a compact `decision` memory, calls `AwarenessService.captureFeedback()` and `AdaptiveStyleEngine.observeFeedback()`, and `FeedbackService` records it in the auto-managed block of `.cowork/MISTAKES.md`. Feedback does not feed `UserProfileService` or `RelationshipMemoryService`. The daemon's memory and style handling is skipped for `<no-memory>` tasks, tasks with `retainMemory` off and shared (group/public) contexts.

---

## Governance Summary

All improvements respect CoWork OS's security-first positioning:

| Improvement            | Guardrail flag                                                                                | Default                                        | Rate limit                                 | Audit trail                                           |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Layered Memory Runtime | `defaultArchiveInjectionEnabled` controls archive injection; hot/structured memory default on | Curated + structured on, archive off           | Token budgets per section                  | Source attribution by lane + tool-level recall traces |
| Adaptive Style Engine  | `adaptiveStyleEnabled`                                                                        | Off                                            | `adaptiveStyleMaxDriftPerWeek` (default 1) | `getAdaptationHistory()`                              |
| Playbook-to-Skill      | —                                                                                             | Always active (post-task hook)                 | 10 min cooldown, max 1/check               | Full proposal review workflow                         |
| Channel Persona        | `channelPersonaEnabled`                                                                       | Off                                            | —                                          | Visible in system prompt                              |
| Evolution Metrics      | —                                                                                             | Computed on-demand                             | —                                          | Read-only, no mutations                               |
| Daily Summaries        | `backgroundConsolidationEnabled` (writer)                                                     | Off; read when summary files exist             | 40 lines per day; token budget (ranked)    | Summary files in `.cowork/memory/summaries/`          |
| Message Feedback       | —                                                                                             | Always visible on completed messages           | IPC: `limited` tier                        | `user_feedback` task event                            |

---

## Test Coverage

| Service                   | Test file                                                         |
| ------------------------- | ----------------------------------------------------------------- |
| MemorySynthesizer         | `src/electron/memory/__tests__/MemorySynthesizer.test.ts`         |
| CuratedMemoryService      | `src/electron/memory/__tests__/CuratedMemoryService.test.ts`      |
| DreamingService           | `src/electron/memory/__tests__/DreamingService.test.ts`           |
| SessionRecallService      | `src/electron/memory/__tests__/SessionRecallService.test.ts`      |
| LayeredMemoryIndexService | `src/electron/memory/__tests__/LayeredMemoryIndexService.test.ts` |
| AdaptiveStyleEngine       | `src/electron/memory/__tests__/AdaptiveStyleEngine.test.ts`       |
| PlaybookSkillPromoter     | `src/electron/memory/__tests__/PlaybookSkillPromoter.test.ts`     |
| ChannelPersonaAdapter     | `src/electron/memory/__tests__/ChannelPersonaAdapter.test.ts`     |
| EvolutionMetricsService   | `src/electron/memory/__tests__/EvolutionMetricsService.test.ts`   |
