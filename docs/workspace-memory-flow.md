# Workspace Memory Flow

This document describes how CoWork OS builds, stores, and retrieves workspace-scoped memory — from raw operational logs through to the synthesized context injected into every task prompt.

---

## Overview

```
User messages / task events
        │
        ▼
DailyLogService.appendEntry()
        │
        ▼
.cowork/memory/daily/<YYYY-MM-DD>.md
        │   (never injected raw)
        ▼
DailyLogSummarizer.writeSummary()
  (external trigger: cron job or post-task hook)
        │
        ▼
.cowork/memory/summaries/<YYYY-MM-DD>.md
        │
        ▼
DailyLogSummarizer.getRecentSummaryFragments()
        │
        ▼
MemorySynthesizer.synthesize()   ← merges all 7 sources
        │
        ▼
<cowork_synthesized_memory> block injected into system prompt
```

---

## Layer 1 — Operational Daily Log

**Service:** `src/electron/memory/DailyLogService.ts`
**Location:** `.cowork/memory/daily/<YYYY-MM-DD>.md`

Structured entries written during task execution for:

- User feedback events (thumbs up/down, reason)
- Task completions
- Notable decisions
- High-value memory saves or corrections

**Key rule:** Raw daily log files are never retrieved for prompt injection. They exist solely as input for the summarizer.

---

## Layer 2 — Daily Summaries

**Service:** `src/electron/memory/DailyLogSummarizer.ts`
**Location:** `.cowork/memory/summaries/<YYYY-MM-DD>.md`

Synthesized summaries generated from the raw daily log. Each summary file uses a standard schema:

```md
---
updated: 2026-03-14
source: daily_log_synthesizer
day: 2026-03-14
---

# Daily Summary

## Important Decisions
## User Preferences Observed
## Active Threads
## Corrections / Lessons
## Follow-ups
```

**Retrieval ranking:** Base relevance `0.55` with exponential recency decay (half-life 7 days). This places daily summaries below user profile and relationship memory, but above raw snippets.

---

## Layer 3 — Memory Synthesis

**Service:** `src/electron/memory/MemorySynthesizer.ts`

Collects fragments from all 7 sources, deduplicates by 120-character fingerprint, ranks by composite score, and budget-constrains the final output.

### Source ranking (approximate)

| Source | Base relevance | Budget |
|--------|---------------|--------|
| `user_profile` | 0.70 | Shared fragment budget |
| `relationship` | variable | Shared fragment budget |
| `playbook` | variable | Shared fragment budget |
| `memory` | variable | Shared fragment budget |
| `knowledge_graph` | variable | Shared fragment budget |
| `daily_summary` | 0.55 × recency | Shared fragment budget |
| `workspace_kit` | — | Separate 35% budget |

### Composite score

```
score = relevance × 0.45 + confidence × 0.3 + recency × 0.25
```

Recency uses exponential decay with a 14-day half-life for general memory fragments and a 7-day half-life for daily summaries.

---

## Workspace Kit Context

**Service:** `src/electron/memory/WorkspaceKitContext.ts`
**Location:** `.cowork/*.md` (governed files)

The workspace kit is handled separately from the synthesis pipeline. It has its own 35% token budget and is injected *before* the synthesized memory block in the final prompt. Kit files are governed by contracts (`kit-contracts.ts`) that define:

- prompt budget (`maxChars`)
- freshness window (`freshnessDays`)
- mutability (`system_locked`, `user_owned`, `agent_maintained`, …)
- scope (`task`, `main-session`, `role`, `company-ops`, `heartbeat`, `bootstrap`)

### Quick-open kit files

From **Settings → Memory Hub → Per Workspace**, the "Open USER.md" and "Open MEMORY.md" buttons open (or create if missing) these files directly in the system editor via `kit:openFile` IPC.

---

## Message Feedback → Memory

User feedback on individual assistant messages flows into the memory pipeline:

```
User clicks 👍 or 👎 (+ optional reason)
        │
        ▼
kit:submitMessageFeedback IPC
        │
        ▼
UserProfileService.ingestUserFeedback()
        │
        ├─→ RelationshipMemoryService (commitment / correction layer)
        └─→ AdaptiveStyleEngine.observeFeedback()  [if adaptiveStyleEnabled]
```

Feedback reason values: `incorrect`, `too_verbose`, `ignored_instructions`, `wrong_tone`, `unsafe`.

---

## Bootstrap Lifecycle

The workspace bootstrap flow records onboarding progress in `.cowork/workspace-state.json`:

| Event | State change |
|-------|-------------|
| BOOTSTRAP.md appears | `bootstrapSeededAt` set |
| BOOTSTRAP.md deleted | `onboardingCompletedAt` set |

`ensureBootstrapLifecycleState()` is the only function that writes this file. `computeWorkspaceKitStatus()` is pure read-only. The `KIT_GET_STATUS` handler calls `ensureBootstrapLifecycleState()` before each pure status read to keep timestamps current.

---

## Related docs

- [Evolving Agent Intelligence](evolving-agent-intelligence.md) — full service details
- [Behavior Adaptation](behavior-adaptation.md) — adaptive style and channel persona controls
- [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md) — bootstrap and kit contract reference
