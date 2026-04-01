# OpenClaw vs CoWork OS Feature Comparison

This document compares the features shown in the provided comparison list against the current evidence available in the **CoWork OS** repository and the **OpenClaw** repository.

## Scope

Compared features:

- Memory system
- Memory size
- Memory nudges
- Memory flush
- Memory injection security
- Skill system
- Skill standard
- Autonomous skill creation
- Skill self-improvement
- Skill security scanning
- Session history search
- Cross-session user modeling
- Cache-stable memory

## Summary

High level:

- **OpenClaw** appears stronger on plain-markdown workspace memory, public skill registry/discovery, explicit session-history tooling, and cache-stable prompt design.
- **CoWork OS** appears stronger on structured memory architecture, self-improvement loops, approval-gated skill creation, built-in governance/security controls, and now a shared turn kernel / tool scheduler / orchestration graph stack for delegated work.
- Some items in the screenshot are not first-class product terms in either repo, so a few rows are marked **Partial** or **Unclear**.

## Comparison Table

| Feature | CoWork OS | OpenClaw | Notes |
|---|---|---|---|
| Memory system | Yes | Yes | CoWork OS has multi-layer memory, knowledge graph, relationship memory, workspace kit, and imported ChatGPT history. OpenClaw uses workspace markdown memory files such as `MEMORY.md` and `memory/YYYY-MM-DD.md`. |
| Memory size | Partial / not explicit | Partial / not explicit | Neither repo clearly presents a specific memory-capacity feature or configurable marketed size in the reviewed docs. Both focus more on compaction and management. |
| Memory nudges | Partial | Yes | CoWork OS has failure-pattern nudges and proactive reminder-style behavior via memory/persona systems, but not a clearly named “memory nudge” feature. OpenClaw explicitly references heartbeat nudges. |
| Memory flush | Yes | Yes | CoWork OS flushes compaction summaries into durable memory. OpenClaw documents automatic pre-compaction memory flush and silent memory flush to disk. |
| Memory injection security | Partial | Partial | Both have adjacent controls, but not necessarily under this exact label. CoWork OS documents sanitization, privacy protection, prompt hardening, and memory controls. OpenClaw documents trust boundaries and explicitly treats prompt-injection-only findings as out of scope without a boundary bypass. |
| Skill system | Yes | Yes | Both repos clearly support reusable skills. |
| Skill standard | Yes | Yes | CoWork OS has a documented skill quality specification. OpenClaw has a documented skill bundle structure centered on `SKILL.md` plus registry metadata. |
| Autonomous skill creation | Partial, approval-gated | Partial / unclear | CoWork OS supports `skill_proposal.create` but requires approval before a skill is materialized. OpenClaw supports publish/install/discovery flows, but reviewed docs do not clearly show autonomous self-authoring by the agent. |
| Skill self-improvement | Yes | Partial | CoWork OS has explicit self-improving-agent documentation, reinforcement loops, correction capture, and `memory_save`. OpenClaw has learning/self-improve references, but not as clearly productized in the reviewed sources. |
| Skill security scanning | Yes | Partial | CoWork OS documents skill validation/audit tooling. OpenClaw shows install gating and unsafe-skill reporting, but no equally explicit skill scan pipeline was found in the reviewed material. |
| Session history search | Yes | Yes | CoWork OS supports persistent memory search and imported/global history retrieval. OpenClaw includes a dedicated sessions history tool. |
| Cross-session user modeling | Yes | Partial | CoWork OS has relationship memory, user profile extraction, and adaptive style/personalization. OpenClaw has personal assistant and profile/persona concepts, but less explicit structured cross-session user modeling in the reviewed docs. |
| Cache-stable memory | Partial | Yes | CoWork OS emphasizes unified memory and context compaction. OpenClaw explicitly documents cache-stable prompt behavior by keeping the time-zone section stable. |

## Detailed Notes by Feature

### 1. Memory system

**CoWork OS**

- README describes a persistent memory system, knowledge graph, relationship memory, workspace kit, and ChatGPT history import.
- `docs/features.md` describes hybrid `search_memories`, memory compression, privacy protection, and auto-capture.
- `docs/architecture.md` points to `MemoryService`, `RelationshipMemoryService`, `UserProfileService`, and workspace kit indexing.

**OpenClaw**

- `docs/concepts/memory.md` states that memory is plain Markdown in the agent workspace.
- Default layout includes `memory/YYYY-MM-DD.md` and optional `MEMORY.md`.

### 2. Memory size

Neither repo, in the reviewed sources, positions “memory size” as a clear feature with a concrete product-level quota or configurable marketed capacity.

- CoWork OS focuses on compaction, compression, hybrid retrieval, and flush behavior.
- OpenClaw focuses on compaction, session summaries, and memory flush to disk.

### 3. Memory nudges

**CoWork OS**

- Has adjacent behavior rather than a directly named memory-nudge feature.
- `docs/changelog.md` mentions repeated-failure detection that nudges the agent to switch strategy.
- Relationship memory and proactive twin workflows also create reminder-like continuity behavior.

**OpenClaw**

- `docs/gateway/heartbeat.md` explicitly frames periodic heartbeat behavior and user-facing reminder-style routing.
- Repository search also surfaced explicit “nudge” references.

### 4. Memory flush

**CoWork OS**

- `docs/context-compaction.md` states that compaction summaries are flushed to `MemoryService` for cross-session recall.
- The same document describes pre-compaction flush and proactive compaction behavior.

**OpenClaw**

- `docs/concepts/memory.md` references automatic pre-compaction memory flush.
- `docs/concepts/compaction.md` states OpenClaw can run a silent memory flush turn to store durable notes to disk before compaction.

### 5. Memory injection security

This feature label is somewhat interpretation-dependent, so the comparison below is based on adjacent security controls.

**CoWork OS**

- `docs/security-guide.md` documents sanitization, prompt/skill hardening, validation, and protections around memory/context injection.
- `docs/self-improving-agent.md` mentions memory sanitization before prompt injection.
- Overall posture is governance-heavy: approvals, sandboxing, privacy-aware storage, and configurable guardrails.

**OpenClaw**

- `SECURITY.md` clearly says prompt-injection-only findings are out of scope unless they bypass an auth, policy, allowlist, approval, or sandbox boundary.
- OpenClaw documents trust boundaries and an explicit trusted-operator model rather than presenting “memory injection security” as a standalone feature.

### 6. Skill system

Both repos clearly have a real skill system.

**CoWork OS**

- README advertises 137 built-in skills.
- `resources/skills/` contains bundled skills.
- Plugin packs can expose and toggle individual skills.

**OpenClaw**

- README links directly to skills and onboarding around skills.
- `docs/tools/clawhub.md` describes the public skill registry, publishing, installation, and discovery.

### 7. Skill standard

**CoWork OS**

- `docs/skills-quality-spec.md` defines quality standards for bundled skills.
- Validation and audit commands are documented in `docs/development.md`.

**OpenClaw**

- `docs/tools/clawhub.md` describes a standardized skill-bundle model.
- Skills are represented as folders with `SKILL.md` plus supporting files and metadata.

### 8. Autonomous skill creation

**CoWork OS**

- Supports approval-gated skill creation via `skill_proposal.create`, `approve`, and `reject`.
- `docs/integration-skill-bootstrap-lifecycle.md` is explicit that proposals do not directly mutate skills without approval.

**OpenClaw**

- Supports creation/publishing in a broader ecosystem sense through ClawHub.
- However, in the reviewed docs, I did not find clear evidence of autonomous agent-authored skill creation as a first-class governed runtime feature.

### 9. Skill self-improvement

**CoWork OS**

- `docs/self-improving-agent.md` documents a multi-layered self-improvement architecture.
- Includes correction capture, playbook reinforcement, user preference learning, and agent-initiated `memory_save`.

**OpenClaw**

- Repository search shows references to self-improve/learning/feedback.
- But the reviewed docs do not present an equally explicit, centralized architecture page comparable to CoWork OS’s self-improving-agent design.

### 10. Skill security scanning

**CoWork OS**

- `docs/skills-quality-spec.md` and `docs/development.md` document validation and audit tooling:
  - `npm run skills:validate-routing`
  - `npm run skills:validate-content`
  - `npm run skills:audit`
  - `npm run skills:check`

**OpenClaw**

- `docs/tools/clawhub.md` includes unsafe-skill reporting and install/discovery flows.
- That is useful, but I did not find equally explicit repository-native skill scanning/audit commands in the reviewed material.

### 11. Session history search

**CoWork OS**

- `docs/features.md` documents unified memory search and imported memory search.
- Session continuity is also supported through compaction summaries and persistent memory.

**OpenClaw**

- `src/agents/tools/sessions-history-tool.ts` is direct evidence of a dedicated session-history tool.
- `src/agents/tools/sessions-access.ts` defines session access controls around history/list/send behavior.

### 12. Cross-session user modeling

**CoWork OS**

- `docs/relationship-agent-architecture.md` and `docs/self-improving-agent.md` document relationship memory, user profile extraction, commitment tracking, and personalization.
- README also describes Adaptive Style Engine and related evolving-intelligence behavior.

**OpenClaw**

- README positions OpenClaw as a personal AI assistant and mentions profiles/persona-adjacent concepts in the repo.
- However, I did not find equally explicit structured cross-session user-modeling architecture in the reviewed subset.

### 13. Cache-stable memory

**CoWork OS**

- CoWork OS clearly has compaction and memory durability features.
- But I did not find the specific phrase or mechanism framed as “cache-stable memory” in the same explicit way.

**OpenClaw**

- `docs/concepts/system-prompt.md` explicitly says the current date/time section is kept cache-stable by including only the time zone and not a dynamic clock.

## Verdict

If the goal is a feature-for-feature comparison against the provided list:

- **CoWork OS leads** on structured memory architecture, self-improvement, user modeling, approval-gated skill creation, and skill validation/audit.
- **OpenClaw leads** on explicit session-history tooling, public skill-registry/discovery workflows, simple workspace-native memory files, heartbeat-style nudges, and explicitly documented cache-stable prompt behavior.
- **Both** support core memory and skills, but they package these capabilities differently:
  - **CoWork OS** favors governance, structure, and production controls.
  - **OpenClaw** favors personal-assistant workflows, workspace-native simplicity, and extensible operator tooling.

## Evidence References

### CoWork OS

- `README.md`
- `docs/features.md`
- `docs/context-compaction.md`
- `docs/security-guide.md`
- `docs/self-improving-agent.md`
- `docs/skills-quality-spec.md`
- `docs/integration-skill-bootstrap-lifecycle.md`
- `docs/relationship-agent-architecture.md`
- `docs/architecture.md`

### OpenClaw

- `/tmp/openclaw-compare/README.md`
- `/tmp/openclaw-compare/docs/concepts/memory.md`
- `/tmp/openclaw-compare/docs/concepts/compaction.md`
- `/tmp/openclaw-compare/docs/gateway/heartbeat.md`
- `/tmp/openclaw-compare/docs/tools/clawhub.md`
- `/tmp/openclaw-compare/docs/concepts/system-prompt.md`
- `/tmp/openclaw-compare/src/agents/tools/sessions-history-tool.ts`
- `/tmp/openclaw-compare/src/agents/tools/sessions-access.ts`
- `/tmp/openclaw-compare/SECURITY.md`
