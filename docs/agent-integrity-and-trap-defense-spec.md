# Agent Integrity and Trap Defense — Product Spec

This document turns the "AI Agent Traps" threat model into a concrete CoWork OS product and engineering spec. It is intended to guide future development across ingestion, memory, permissions, delegation, and operator UX.

## 1. Problem Statement

CoWork OS is increasingly capable in the exact areas the report highlights as high risk:

- external web ingestion via `web_fetch`, browser tools, and scraping
- imported documents, email, and connector content
- persistent memory and knowledge synthesis
- auto-promotion of repeated patterns into playbooks and skill proposals
- multi-agent delegation and remote orchestration
- human approval flows for high-impact actions

Today, CoWork OS already has meaningful defenses:

- prompt-injection hardening and non-blocking detection in [docs/security/security-model.md](security/security-model.md) and [src/electron/agent/security/input-sanitizer.ts](../src/electron/agent/security/input-sanitizer.ts)
- output monitoring in [src/electron/agent/security/output-filter.ts](../src/electron/agent/security/output-filter.ts)
- memory sanitization in [src/electron/memory/MemoryService.ts](../src/electron/memory/MemoryService.ts) and [src/electron/memory/MemorySynthesizer.ts](../src/electron/memory/MemorySynthesizer.ts)
- layered permissions in [docs/permission-system.md](permission-system.md)
- task-level [access profiles](access-profiles.md) that combine sandbox, approvals, reviewer behavior, filesystem, network, and domain boundaries
- per-app computer-use risk tiers in [docs/computer-use.md](computer-use.md) and [src/electron/computer-use/app-risk-profile.ts](../src/electron/computer-use/app-risk-profile.ts)

The core gap is that the current model is still mostly:

- transparent
- regex and heuristic driven
- non-blocking by default
- localized to single inputs or outputs

The report’s threat model is broader. It includes hidden content, semantic biasing, poisoned memory, malicious sub-agent spawning, correlated multi-agent failures, and approval fatigue. CoWork OS needs a productized "agent integrity" layer that persists trust state across the full runtime, not only at a single parsing step.

## 2. Goals

1. Prevent untrusted external content from silently driving high-impact actions.
2. Distinguish between observed content, verified facts, and promotable durable knowledge.
3. Propagate trust and suspicion signals across memory, delegation, approvals, and automation.
4. Give operators clear provenance and risk explanations without drowning them in security noise.
5. Create a repeatable eval and red-team harness for agent-trap scenarios.

## 3. Non-Goals

- Solve all jailbreak and prompt-injection classes at the model level.
- Guarantee perfect classification of all hostile content.
- Replace existing permission, guardrail, or sandbox systems.
- Block all automation by default.
- Introduce remote trust services as a hard dependency for local-first usage.

## 4. Scope

This spec applies to:

- web fetch and browser content
- scraping and persistent scrape sessions
- email and connector-ingested text
- imported documents and extracted OCR text
- workspace memory, summaries, and knowledge graph inputs
- playbook reinforcement and skill proposal generation
- child-task delegation, agent teams, and ACP/A2A remote delegation
- approval UX for destructive, external, financial, or sensitive actions

This spec does not initially cover:

- provider-side model fine-tuning defenses
- code execution sandbox internals beyond policy integration
- malware scanning for arbitrary binaries

## 5. Threat Model Mapped to CoWork OS

| Trap class from report | CoWork OS exposure | Primary failure mode |
|---|---|---|
| Content injection | `web_fetch`, `browser_get_content`, scraping, documents, OCR, email | Hidden or machine-only instructions enter context |
| Semantic manipulation | research, summarization, drafting, ranking, triage | Agent adopts attacker framing or false confidence |
| Cognitive state poisoning | memory capture, daily summaries, KG, playbooks, skills | Poisoned facts persist and later drive actions |
| Behavioral control | tool calls, shell, browser, computer use, spend | External content causes unauthorized side effects |
| Systemic traps | agent teams, collaborative mode, remote delegation, automations | Correlated agent failure, cascades, quota exhaustion |
| Human-in-the-loop traps | approvals, summaries, review dialogs | Operator approves risky action because risk is obscured |

## 6. Product Principles

1. **Trust is stateful**
   Trust must survive beyond the current turn. It should attach to content, claims, tasks, approvals, memory entries, and delegated runs.

2. **Provenance before autonomy**
   The system should prefer "show why this is believable" over "assume this is fine."

3. **Suspicion must degrade capabilities**
   Suspicious content should not only be annotated. It should narrow which downstream actions are allowed.

4. **Verification is tiered**
   Some workflows need one corroborating source. Others need two independent sources or explicit operator approval.

5. **Operator trust requires good UX**
   Risk signals need to be visible in task details and approval prompts, not buried in logs.

## 7. Proposed Product: Agent Integrity Layer

Introduce a new cross-cutting subsystem: **Agent Integrity**.

It adds:

- trust classification for external content
- provenance chains for claims and actions
- taint propagation into memory, delegation, and approvals
- verification gates for knowledge promotion
- dedicated operator visibility and review surfaces
- repeatable eval coverage

### 7.1 Core Concepts

#### Content Integrity Record

Represents a fetched or imported content item.

Minimum fields:

- `id`
- `workspaceId`
- `sourceType` (`web_fetch`, `browser`, `scrape`, `email`, `document`, `connector`, `ocr`)
- `sourceLocator` (URL, file path, message id, connector object id)
- `domain` or origin
- `fetchMode` (`default`, `browser`, `scrape_default`, `scrape_stealth`, `scrape_playwright`, `local_file`, etc.)
- `capturedAt`
- `contentHash`
- `integrityVerdict` (`trusted`, `caution`, `suspicious`, `blocked`)
- `riskSignals[]`
- `humanVisibleExcerpt`
- `machineParsedExcerpt`
- `renderMismatchScore`
- `hiddenInstructionScore`
- `verificationStatus`

#### Claim Provenance

Represents a claim later used in memory, summaries, or actions.

Minimum fields:

- `claimId`
- `normalizedClaim`
- `originContentIds[]`
- `supportingContentIds[]`
- `contradictingContentIds[]`
- `verificationLevel` (`unverified`, `single_source`, `multi_source`, `operator_confirmed`)
- `promotionStatus` (`ephemeral`, `candidate`, `durable`)

#### Task Integrity State

Represents the accumulated trust posture of a task.

Minimum fields:

- `taskId`
- `highestObservedRisk`
- `suspiciousContentCount`
- `blockedActionCount`
- `taintedTools[]`
- `verificationRequirements`
- `delegationRestrictions`

## 8. Functional Requirements

## 8.1 Ingestion Risk Classification

Every external content ingestion path must produce an integrity verdict before its text is injected into the main planning loop.

### Requirements

- Add a unified integrity classifier for:
  - `web_fetch`
  - `browser_get_content`
  - scrape tools
  - imported docs/PDF/OCR text
  - email thread content
  - connector-returned free text
- Detect and score at minimum:
  - hidden HTML comments and metadata instructions
  - CSS-hidden or off-screen content when available
  - large machine-visible / human-visible divergence
  - suspicious instruction markers
  - encoded prompt-like payloads
  - suspicious authority framing and action-oriented override language
  - content from stealth/bypass fetch modes
- Persist results as `ContentIntegrityRecord`, not only inline annotations.

### Product behavior

- `trusted`: normal use
- `caution`: allow read/summarize, but raise provenance requirements for action
- `suspicious`: allow limited inspection, but no direct action planning from this content without corroboration
- `blocked`: do not inject into planning context; show as quarantined

### Implementation hooks

- extend [src/electron/agent/security/input-sanitizer.ts](../src/electron/agent/security/input-sanitizer.ts)
- extend [src/electron/agent/security/output-filter.ts](../src/electron/agent/security/output-filter.ts)
- integrate at [src/electron/agent/tools/web-fetch-tools.ts](../src/electron/agent/tools/web-fetch-tools.ts)
- integrate at [src/electron/agent/tools/browser-tools.ts](../src/electron/agent/tools/browser-tools.ts)
- integrate at [src/electron/agent/tools/scraping-tools.ts](../src/electron/agent/tools/scraping-tools.ts)

## 8.2 Trusted vs Untrusted Memory Lanes

Memory must stop behaving as a flat durable store.

### Requirements

- Split memory and memory-like artifacts into three lanes:
  - `observed`: raw captured facts from external or uncertain sources
  - `verified`: corroborated or operator-confirmed facts
  - `derived`: internal lessons, decisions, and patterns created by the agent
- `observed` entries may be searchable, but must not be injected into prompt recall as durable truth unless policy explicitly allows it.
- `verified` entries can participate fully in `MemorySynthesizer`.
- `derived` entries may be promotable, but only if their source claims are not tainted.
- Daily summaries and auto-digests must record source integrity levels.

### Product behavior

- Users can still inspect untrusted memories.
- The runtime should prefer verified memories when constructing context.
- A suspicious source cannot silently become an evergreen memory entry.

### Implementation hooks

- [src/electron/memory/MemoryService.ts](../src/electron/memory/MemoryService.ts)
- [src/electron/memory/MemorySynthesizer.ts](../src/electron/memory/MemorySynthesizer.ts)
- [src/electron/memory/LayeredMemoryIndexService.ts](../src/electron/memory/LayeredMemoryIndexService.ts)
- [src/electron/memory/DailyLogSummarizer.ts](../src/electron/memory/DailyLogSummarizer.ts)

## 8.3 Knowledge Promotion Gates

Promotion into the KG, playbooks, and skill proposals needs stronger gating than "this worked a few times."

### Requirements

- Do not promote claims from `suspicious` or `blocked` content into:
  - knowledge graph
  - playbooks
  - skill proposals
  - adaptive persona/profile learning
- Playbook reinforcement must carry source-integrity summaries.
- Skill proposals must surface risk provenance in the proposal UI.
- If the repeated pattern came from tainted or low-trust inputs, the proposal should remain blocked or require manual review.

### Implementation hooks

- [src/electron/memory/PlaybookSkillPromoter.ts](../src/electron/memory/PlaybookSkillPromoter.ts)
- related proposal services in `src/electron/agent/skills/`
- KG ingest services

## 8.4 Action Provenance and Verification Gates

High-impact actions should require provenance-aware policy decisions.

### Requirements

- The permission engine must receive:
  - the task integrity state
  - whether the triggering evidence is trusted
  - whether action justification depends on single-source suspicious content
- Add policy primitives such as:
  - `require_multi_source_for_external_action`
  - `require_operator_confirmation_for_tainted_spend`
  - `deny_remote_delegation_from_suspicious_context`
  - `deny_memory_promotion_from_tainted_content`
- Approval dialogs must explain:
  - what content triggered this action
  - where it came from
  - its integrity verdict
  - whether corroboration exists

### Product behavior

- A command-tool call triggered by a dubious scraped page should not look identical to a command-tool call triggered by a local repo task.
- Integrity-aware restrictions may narrow the task's effective access profile, but they must never widen it.
- Sensitive actions should be harder to approve when trust is low.

### Implementation hooks

- [docs/permission-system.md](permission-system.md)
- permission runtime and related security managers
- existing approval UI in renderer

## 8.5 Delegation and Multi-Agent Taint Propagation

Delegation is one of the highest-leverage risks from the report.

### Requirements

- Child tasks inherit integrity posture from parent tasks.
- If a parent task is tainted:
  - remote ACP/A2A delegation is denied by default
  - only a reduced tool set is allowed for child tasks
  - synthesis cannot treat tainted child output as independently trustworthy unless the child re-verifies against trusted sources
- Team runs must support:
  - independent retrieval by multiple workers
  - source-diversity checks at synthesis
  - quorum rules for high-impact outputs
  - caps to prevent cascade loops or congestion storms

### Product behavior

- Suspicious content can still be analyzed.
- It cannot fan out into a larger autonomous system without explicit policy and operator intent.

### Implementation hooks

- [src/electron/agents/AgentTeamOrchestrator.ts](../src/electron/agents/AgentTeamOrchestrator.ts)
- orchestration graph runtime
- remote delegation / ACP / A2A handlers

## 8.6 Human-in-the-Loop Hardening

The approval surface itself is an attack target.

### Requirements

- Approval UIs must show a concise integrity summary:
  - `Source risk: trusted/caution/suspicious`
  - `Evidence: 1 source / 2 independent sources / operator confirmed`
  - `Why elevated: action derived from hidden-content or unverified external source`
- Add approval friction controls:
  - rate limit repetitive approvals from the same suspicious task
  - aggregate low-signal prompts into one review step where safe
  - highlight unusually technical or low-explainability summaries
- Add a "show evidence" drawer with source excerpts and provenance chain.

### Product behavior

- Reduce approval fatigue.
- Make it obvious when the system is asking for approval on the basis of dubious input.

### Implementation hooks

- approval dialogs in renderer
- task detail and Mission Control surfaces

## 8.7 Integrity Dashboard

Add a dedicated user-facing surface under Security or Mission Control.

### Requirements

- Show recent suspicious ingestions
- Show quarantined content
- Show blocked memory promotions
- Show tainted delegated runs
- Show domains/origins with repeated suspicious hits
- Support per-workspace tuning and allowlists

### Initial UX sections

- `Recent Detections`
- `Quarantine Queue`
- `Memory Promotions Waiting Review`
- `Approval Escalations`
- `High-Risk Domains and Origins`

## 8.8 Benchmarking and Red Teaming

CoWork OS should treat this as an eval problem, not only a runtime problem.

### Requirements

- Add an `agent_traps` eval suite that covers:
  - hidden HTML comments
  - CSS-invisible text
  - aria-label / metadata payloads
  - Markdown and LaTeX masking
  - image/OCR prompt contamination
  - biased-framing manipulation
  - poisoned memory recall
  - tainted skill-promotion attempts
  - malicious sub-agent spawning attempts
  - approval-fatigue scenarios
- Measure both:
  - detection quality
  - action prevention quality

### Success condition

The product should not only detect the trap. It should also prevent unsafe downstream autonomy.

## 9. UX Requirements

## 9.1 Task Timeline

Add timeline events for:

- content classified as `caution`, `suspicious`, or `blocked`
- memory promotion denied due to provenance
- delegation denied due to task taint
- approval escalated due to integrity risk

## 9.2 Approval Dialog

Add fields:

- `Source`
- `Integrity verdict`
- `Verification level`
- `Corroborating evidence`
- `Reason this action is restricted`

## 9.3 Memory and Recall Surfaces

Show trust badges on:

- memories
- daily summaries
- KG-derived facts
- playbook entries

Support filtering by:

- verified only
- all
- quarantined / review needed

## 9.4 Settings

Add an "Agent Integrity" section under security settings with:

- strictness profile
- external content default posture
- memory promotion policy
- delegation restrictions for tainted tasks
- domain allowlists and deny overrides

## 10. Data Model

The exact schema can evolve, but Phase 1 should add durable storage for:

### `content_integrity_records`

- `id`
- `workspace_id`
- `source_type`
- `source_locator`
- `origin_domain`
- `fetch_mode`
- `content_hash`
- `integrity_verdict`
- `risk_score`
- `risk_signals_json`
- `verification_status`
- `human_excerpt`
- `machine_excerpt`
- `created_at`

### `claim_provenance`

- `id`
- `workspace_id`
- `normalized_claim`
- `verification_level`
- `promotion_status`
- `supporting_sources_json`
- `contradicting_sources_json`
- `created_at`
- `updated_at`

### `task_integrity_state`

- `task_id`
- `workspace_id`
- `highest_risk`
- `suspicious_content_count`
- `delegation_restricted`
- `action_escalation_required`
- `state_json`

Memory records should gain:

- `trust_lane`
- `source_claim_ids_json`
- `source_integrity_max`

## 11. Architecture Changes

## 11.1 New Services

- `ContentIntegrityService`
- `ClaimProvenanceService`
- `TaskIntegrityService`
- `IntegrityPolicyAdapter`
- `IntegrityEvalRunner`

## 11.2 Integration Points

### Ingestion

- web tools
- browser content extraction
- scraping tools
- connector text fetches
- document/OCR import

### Runtime

- task executor
- permission engine
- approval generation
- team orchestration

### Knowledge systems

- MemoryService
- MemorySynthesizer
- knowledge graph ingest
- playbook reinforcement
- skill proposals

## 12. Rollout Plan

## Phase 1 — Foundations

Ship the minimum durable integrity layer.

- add `ContentIntegrityRecord`
- classify web/browser/scrape/email/doc inputs
- persist verdicts
- show task-level risk badges
- pass task integrity into approval prompts

**Primary outcome:** suspicious content is visible and durable.

## Phase 2 — Memory and Knowledge Gating

- split memory into trust lanes
- block tainted promotion into durable recall
- gate KG / playbook / skill proposal promotion
- add trust badges in memory surfaces

**Primary outcome:** poisoned inputs do not silently become durable knowledge.

## Phase 3 — Provenance-Aware Actions

- extend permission engine with provenance-aware decisions
- require corroboration for sensitive actions
- add stricter spend / external / destructive gates
- improve approval explainability

**Primary outcome:** suspicious evidence can no longer directly trigger meaningful side effects.

## Phase 4 — Delegation and Systemic Risk Controls

- propagate taint to child tasks
- restrict remote delegation
- add quorum and source-diversity checks in team synthesis
- add resource caps for suspicious multi-agent runs

**Primary outcome:** one poisoned artifact cannot easily fan out through the whole autonomous runtime.

## Phase 5 — Integrity Dashboard and Evals

- ship Integrity dashboard
- ship `agent_traps` eval suite
- add release gating for severe regressions

**Primary outcome:** defenses are measurable and operable.

## 13. Metrics

## Security Metrics

- suspicious-ingestion detection rate
- blocked high-risk action rate
- false positive rate on benign content
- poisoned-memory promotion prevention rate
- remote-delegation denial rate for tainted tasks

## Product Metrics

- percentage of approvals with provenance shown
- operator evidence-view open rate
- reduction in low-context approvals
- number of quarantined items reviewed
- number of integrity-based policy overrides by workspace

## Eval Metrics

- pass rate on hidden-content tests
- pass rate on tainted-memory tests
- pass rate on malicious delegation tests
- pass rate on approval-fatigue simulations

## 14. Open Questions

1. Should integrity verdicts be fully local heuristics in Phase 1, or allow optional provider-assisted scoring?
2. What is the right default posture for stealth scraping content: `caution` or `suspicious`?
3. Should users be allowed to manually promote suspicious content into verified memory?
4. How should domain allowlists interact with content-based suspicious signals?
5. Should we store full machine-visible render snapshots for forensic replay, or only hashes and excerpts?

## 15. Recommended First Slice

If only one slice is funded next, build this:

1. `ContentIntegrityService` for `web_fetch`, browser content, scraping, email, and imported docs.
2. task-level integrity state persisted with verdicts and reasons.
3. approval dialog upgrade with provenance and risk summary.
4. memory trust lanes with promotion blocking from suspicious content.

This is the smallest slice that materially changes runtime safety instead of only improving observability.

## 16. Code References

- [src/electron/agent/security/input-sanitizer.ts](../src/electron/agent/security/input-sanitizer.ts)
- [src/electron/agent/security/output-filter.ts](../src/electron/agent/security/output-filter.ts)
- [src/electron/agent/tools/web-fetch-tools.ts](../src/electron/agent/tools/web-fetch-tools.ts)
- [src/electron/agent/tools/browser-tools.ts](../src/electron/agent/tools/browser-tools.ts)
- [src/electron/agent/tools/scraping-tools.ts](../src/electron/agent/tools/scraping-tools.ts)
- [src/electron/memory/MemoryService.ts](../src/electron/memory/MemoryService.ts)
- [src/electron/memory/MemorySynthesizer.ts](../src/electron/memory/MemorySynthesizer.ts)
- [src/electron/memory/PlaybookSkillPromoter.ts](../src/electron/memory/PlaybookSkillPromoter.ts)
- [src/electron/agents/AgentTeamOrchestrator.ts](../src/electron/agents/AgentTeamOrchestrator.ts)
- [docs/security/security-model.md](security/security-model.md)
- [docs/permission-system.md](permission-system.md)
- [docs/computer-use.md](computer-use.md)
