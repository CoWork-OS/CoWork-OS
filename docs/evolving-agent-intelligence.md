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
   - current knowledge graph entities/relationships
   - daily summaries
   - archive memory only when explicitly enabled
3. **L2 Topic Packs** as explicit `.cowork/memory/topics/*.md` loads through `memory_topics_load`
4. **L3 Deep Recall** as explicit tools:
   - `search_quotes`
   - `search_sessions`
   - `search_memories`

Workspace kit context still renders separately before memory sections, and only `L0 + L1` are injected into the live prompt by default.

### Configuration

Default runtime behavior:

| Setting | Default |
|---------|---------|
| `L0 Identity` injection | `on` |
| `L1 Essential Story` injection | `on` |
| Archive memory injection | `off` (`defaultArchiveInjectionEnabled: false`) |
| Quote/session/archive recall | tool-driven (`search_quotes`, `search_sessions`, `search_memories`) |
| Topic packs | tool-driven (`memory_topics_load`) |

### Curated-memory guardrails

- Curated entry content is capped at **320 characters**
- `match` strings for replace/remove are capped at **120 characters**
- `memory_curate` supports stable `id` values so replace/remove operations can be deterministic
- Curated file sync into `.cowork/USER.md` and `.cowork/MEMORY.md` is serialized per workspace and retried on file-change races

### Dreaming curation

Dreaming runs above the layered memory runtime as a review-first memory hygiene pass. It reads recent transcript spans, structured observations, and curated hot memory, then proposes `dreaming_candidates` for stale entries, corrections, open loops, recurring tasks, constraints, ignored-noise patterns, or curated-memory cleanup.

Dreaming does not change what is injected into prompts by itself. Accepted candidates still flow through the owning memory service before they affect `L0`, `L1`, topic packs, or recall behavior.

### Sources

The runtime now thinks about sources by wake-up layer instead of one flat synthesis list:

| Layer | Sources |
|------|---------|
| **L0 Identity** | `CuratedMemoryService`, `UserProfileService`, `RelationshipMemoryService`, workspace-kit essentials |
| **L1 Essential Story** | `PlaybookService`, `KnowledgeGraphService`, `DailyLogSummarizer`, optional archive fragments from `MemoryService` |
| **L2 Topic Packs** | `memory_topics_load` over `.cowork/memory/topics/*.md` |
| **L3 Deep Recall** | `search_quotes`, `search_sessions`, `search_memories` |
| **Dreaming Evidence** | transcript spans, structured observations, curated hot memory, and heartbeat memory-drift signals |

`daily_summary` fragments come from `.cowork/memory/summaries/<YYYY-MM-DD>.md` files produced by `DailyLogSummarizer`. Raw daily log files (`.cowork/memory/daily/`) are **never** injected into prompts.

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

## Known Entities
- [KnowledgeGraph entity]

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

| Setting | Default | Description |
|---------|---------|-------------|
| `adaptiveStyleEnabled` | `false` | Master enable — no observation or adaptation when off |
| `adaptiveStyleMaxDriftPerWeek` | `1` | Max style-level shifts per 7-day period |

The **Behavior Adaptation** section in Guardrail Settings exposes these toggles alongside a **Reset learned style** button that calls `AdaptiveStyleEngine.reset()` via the `kit:resetAdaptiveStyle` IPC channel.

### Integration points

- `daemon.ts` — calls `AdaptiveStyleEngine.observe(text)` after every `UserProfileService.ingestUserMessage()`
- `daemon.ts` — calls `AdaptiveStyleEngine.observeFeedback(decision, reason)` alongside `UserProfileService.ingestUserFeedback()`
- `GuardrailSettings.tsx` — renders toggle, drift input, and reset button under "Behavior Adaptation"

---

## 3. Playbook-to-Skill Auto-Promotion Pipeline

**File:** `src/electron/memory/PlaybookSkillPromoter.ts`

### Problem

`PlaybookService` detects repeated successful patterns. `SkillProposalService` has a full admin approval workflow for new skills. They were not connected — no automation converted proven patterns into governed, reusable skills.

### Solution

When a playbook pattern is reinforced **3+ times** (configurable `threshold`), `PlaybookSkillPromoter.maybePropose()` auto-generates a skill proposal with:

- **Problem statement** — "Recurring task pattern detected (reinforced N times): …"
- **Evidence** — reinforcement count, common tools, example requests
- **Draft skill** — ID, name, description, prompt template (generated from evidence), icon, category
- **Required tools** list

The proposal enters the existing `SkillProposalService` governance workflow — an admin sees the evidence and approves or rejects with one click. No skill is created automatically.

**Flow:**
```
Task completes successfully
  → PlaybookService.reinforceEntry() writes reinforcement memory
  → PlaybookService.events.emit("pattern-reinforced")
  → executor.ts calls PlaybookSkillPromoter.maybePropose() (async, fire-and-forget)
    → findCandidates() groups reinforcement memories by normalized task description
    → if count ≥ threshold: proposeSkill() via SkillProposalService.create()
    → proposal enters admin review queue
```

**Cooldown:** 10 minutes per workspace between promotion checks. Max 1 proposal per check.

**Dedup:** `SkillProposalService.create()` handles duplicate detection — returns `duplicateOf` if a similar proposal already exists.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `DEFAULT_PROMOTION_THRESHOLD` | `3` | Min reinforcements before proposing |
| `PROMOTION_COOLDOWN_MS` | `10 min` | Min time between checks per workspace |
| `MAX_PROPOSALS_PER_CHECK` | `1` | Max new proposals per check |

---

## 4. Cross-Channel Persona Coherence

**File:** `src/electron/memory/ChannelPersonaAdapter.ts`

### Problem

The agent connects to 15+ channels but delivers the same personality regardless of channel norms. A Slack reply should feel different from an email reply — not because the agent has different knowledge or values, but because each platform has its own communication culture.

### Solution

`ChannelPersonaAdapter.adaptForChannel()` takes the detected `originChannel` (from `task.agentConfig.originChannel`) and returns a channel-specific directive that is **appended to** (not replacing) the core personality prompt.

**Channel profiles:**

| Channel | Length | Formatting | Emoji | Formal framing |
|---------|--------|-----------|-------|----------------|
| `slack` | Shorter | Structured | No | No |
| `email` | Longer | Structured | No | Yes (greeting + sign-off) |
| `whatsapp` | Shorter | Plain | Yes | No |
| `imessage` | Shorter | Plain | Yes | No |
| `signal` | Shorter | Plain | No | No |
| `discord` | Normal | Structured + markdown | Yes | No |
| `teams` | Normal | Structured | No | No |
| `telegram` | Shorter | Minimal | No | No |
| `mattermost` | Normal | Structured | No | No |
| `matrix` | Normal | Structured | No | No |
| `googlechat` | Shorter | Plain | No | No |
| `twitch` | Shorter | Plain | Yes | No |

**Group/public context overlay:** When `gatewayContext` is `"group"` or `"public"`, an additional privacy-aware directive is layered on (do not share sensitive information, be aware others are reading).

### Configuration (GuardrailSettings → Behavior Adaptation)

| Setting | Default | Description |
|---------|---------|-------------|
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

CoWork OS tracks basic relationship stats (tasks completed, days together) but has no concept of measuring agent *improvement over time*. For enterprise buyers, quantifiable ROI is the difference between a tool and a strategic investment.

### Solution

`EvolutionMetricsService.computeSnapshot()` computes 5 metrics on-demand from existing service data:

| Metric ID | Label | Source | Interpretation |
|-----------|-------|--------|----------------|
| `correction_rate` | Correction Rate | PlaybookService (failure entries) | Lower this week vs. prior 3-week avg → "improving" |
| `adaptation_velocity` | Style Adaptations | AdaptiveStyleEngine history | Any adaptations applied → agent is learning |
| `knowledge_growth` | Knowledge Graph | KnowledgeGraphService.getStats() | Entity and relationship count |
| `task_success_rate` | Task Success Rate | PlaybookService (success/failure entries) | Percentage of recorded tasks that succeeded |
| `style_alignment` | Style Alignment | AdaptiveStyleEngine history | Ratio of proactive vs. feedback-driven adaptations |

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

## 6. Daily Operational Log

**File:** `src/electron/memory/DailyLogService.ts`

### Purpose

Provides structured per-day journaling as input for the summary-first memory pipeline. Entries are written to `.cowork/memory/daily/<YYYY-MM-DD>.md`.

### When to write entries

| Category | Trigger |
|----------|---------|
| `feedback` | User thumbs-up/down events |
| `task` | Task completions |
| `decision` | Notable agent decisions |
| `observation` | High-value memory saves or corrections |

Raw log files are **never** injected into prompts directly. They exist only as input for `DailyLogSummarizer`.

### Entry format

```md
## 2026-03-14T15:30:00.000Z
source: user
category: feedback
taskId: task-abc123
tags: tone, correction

User flagged response as "wrong tone".
```

### API

```ts
await DailyLogService.appendEntry(workspacePath, {
  timestamp: new Date().toISOString(),
  source: "user",
  category: "feedback",
  text: "User flagged response as wrong tone.",
  taskId: "task-abc123",
  tags: ["tone"],
});
```

---

## 7. Daily Log Summarizer

**File:** `src/electron/memory/DailyLogSummarizer.ts`

### Purpose

Produces ranked `MemoryFragment` objects from pre-written daily summary files (`.cowork/memory/summaries/<YYYY-MM-DD>.md`). This completes the summary-first retrieval pipeline: summaries rank higher than raw log snippets but lower than user profile and relationship memory.

### Directory layout

```
.cowork/
  memory/
    daily/
      2026-03-14.md    ← raw operational log (DailyLogService writes)
    summaries/
      2026-03-14.md    ← synthesized summary (written externally, e.g. cron)
```

### Summary file format

```md
---
updated: 2026-03-14
source: daily_log_synthesizer
day: 2026-03-14
---

# Daily Summary

## Important Decisions
- ...

## User Preferences Observed
- ...

## Active Threads
- ...

## Corrections / Lessons
- ...

## Follow-ups
- ...
```

### Retrieval ranking

| Source | Base relevance | Notes |
|--------|---------------|-------|
| `user_profile` | 0.70 | Always somewhat relevant |
| `daily_summary` | 0.55 × recency decay | Recency half-life = 7 days |
| Raw daily logs | never returned | Not injected by this service |

### Integration

`MemorySynthesizer.synthesize()` calls `DailyLogSummarizer.getRecentSummaryFragments()` for the last 7 days and adds the results to the structured-memory lane as `daily_summary` fragments. They render under `## Recent Summaries` inside `<cowork_structured_memory>`.

### Helper

```ts
DailyLogSummarizer.countRecentSummaries(workspacePath, 7)
// → number of summary files present in the last 7 days
// Used by the Improvement Signals card
```

---

## 8. Message Feedback

**UI:** `src/renderer/components/MainContent/MainContent.tsx` (assistant-message feedback controls)

**IPC:** `kit:submitMessageFeedback` → `UserProfileService.ingestUserFeedback()`

### Interaction

The latest completed assistant message exposes 👍 / 👎 controls for message-level feedback. Thumbs-down uses the following structured reason vocabulary:

| Reason key | Label |
|-----------|-------|
| `incorrect` | Incorrect |
| `too_verbose` | Too verbose |
| `ignored_instructions` | Ignored instructions |
| `wrong_tone` | Wrong tone |
| `unsafe` | Unsafe / unwanted |

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

Feedback is routed to `UserProfileService.ingestUserFeedback()` and (via daemon) to `AdaptiveStyleEngine.observeFeedback()`.

---

## Governance Summary

All improvements respect CoWork OS's security-first positioning:

| Improvement | Guardrail flag | Default | Rate limit | Audit trail |
|-------------|---------------|---------|------------|-------------|
| Layered Memory Runtime | `defaultArchiveInjectionEnabled` controls archive injection; hot/structured memory default on | Curated + structured on, archive off | Token budgets per section | Source attribution by lane + tool-level recall traces |
| Adaptive Style Engine | `adaptiveStyleEnabled` | Off | `adaptiveStyleMaxDriftPerWeek` (default 1) | `getAdaptationHistory()` |
| Playbook-to-Skill | — | Always active (post-task hook) | 10 min cooldown, max 1/check | Full proposal review workflow |
| Channel Persona | `channelPersonaEnabled` | Off | — | Visible in system prompt |
| Evolution Metrics | — | Computed on-demand | — | Read-only, no mutations |
| Daily Log | — | Available when a writer uses `DailyLogService` | File append only | Per-day markdown files |
| Daily Summaries | — | Active when summary files exist | Token budget (ranked) | Summary files in `.cowork/memory/summaries/` |
| Message Feedback | — | Always visible on completed messages | IPC: `limited` tier | Routed to UserProfileService |

---

## Test Coverage

| Service | Test file |
|---------|-----------|
| MemorySynthesizer | `src/electron/memory/__tests__/MemorySynthesizer.test.ts` |
| CuratedMemoryService | `src/electron/memory/__tests__/CuratedMemoryService.test.ts` |
| DreamingService | `src/electron/memory/__tests__/DreamingService.test.ts` |
| SessionRecallService | `src/electron/memory/__tests__/SessionRecallService.test.ts` |
| LayeredMemoryIndexService | `src/electron/memory/__tests__/LayeredMemoryIndexService.test.ts` |
| AdaptiveStyleEngine | `src/electron/memory/__tests__/AdaptiveStyleEngine.test.ts` |
| PlaybookSkillPromoter | `src/electron/memory/__tests__/PlaybookSkillPromoter.test.ts` |
| ChannelPersonaAdapter | `src/electron/memory/__tests__/ChannelPersonaAdapter.test.ts` |
| EvolutionMetricsService | `src/electron/memory/__tests__/EvolutionMetricsService.test.ts` |
