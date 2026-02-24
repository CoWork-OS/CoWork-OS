# Digital Twin Personas: Comprehensive Guide

Digital Twin Personas turn CoWork OS into a cognitive offload engine for every role in an organization. Each twin is an AI agent that continuously absorbs the repetitive information-gathering, status-tracking, and preparation work that fragments a person's attention throughout the day. The human focuses on judgment, relationships, and creative work. The twin handles everything else.

This guide covers the full system in detail: how twins work, what each built-in persona does, day-in-the-life scenarios for every role, and the broader set of job functions where digital twins can be applied.

---

## Table of Contents

- [How Digital Twins Work](#how-digital-twins-work)
- [The Cognitive Offload Model](#the-cognitive-offload-model)
- [Built-In Personas (Detailed)](#built-in-personas-detailed)
  - [Software Engineer](#software-engineer)
  - [Hardware Engineer](#hardware-engineer)
  - [QA / System Test Engineer](#qa--system-test-engineer)
  - [DevOps / SRE Engineer](#devops--sre-engineer)
  - [Engineering Manager](#engineering-manager)
  - [Technical Director](#technical-director)
  - [VP of Engineering](#vp-of-engineering)
  - [Product Manager](#product-manager)
  - [Data Scientist / Analyst](#data-scientist--analyst)
  - [Technical Writer](#technical-writer)
- [Bundled Skills](#bundled-skills)
- [Day-in-the-Life Scenarios](#day-in-the-life-scenarios)
- [Scaling Across an Organization](#scaling-across-an-organization)
- [Expanding to Other Job Areas](#expanding-to-other-job-areas)
  - [Design](#design)
  - [Security](#security)
  - [Sales & Revenue](#sales--revenue)
  - [Customer Success & Support](#customer-success--support)
  - [Human Resources & People Ops](#human-resources--people-ops)
  - [Finance & Accounting](#finance--accounting)
  - [Legal & Compliance](#legal--compliance)
  - [Marketing](#marketing)
  - [Research & Development](#research--development)
  - [Executive Leadership](#executive-leadership)
  - [Education & Training](#education--training)
  - [Healthcare & Life Sciences](#healthcare--life-sciences)
  - [Supply Chain & Logistics](#supply-chain--logistics)
- [Creating Custom Templates](#creating-custom-templates)
- [Channel Integration](#channel-integration)
- [FAQ](#faq)

---

## How Digital Twins Work

A digital twin has two operational modes:

### Proactive Mode (Heartbeat-Driven)

The twin wakes up on a configurable interval (every 5 minutes to 4 hours) and automatically executes its enabled proactive tasks. Each task has its own frequency — a twin with a 30-minute heartbeat might run PR triage every 60 minutes but dependency checks every 8 hours. The heartbeat service tracks which tasks are due each cycle.

Results appear as completed tasks in Mission Control. The human sees a stream of prepared artifacts — review queues, status digests, risk assessments — without having asked for them.

### Reactive Mode (On-Demand)

The human assigns work directly:

- Drag a task onto the twin's column in the Mission Control Kanban board
- @mention the twin in a conversation: `@sw-twin summarize auth module changes this week`
- Invoke a bundled skill: `@twin prepare meeting brief for tomorrow's architecture review`
- Reach the twin via any of CoWork OS's 14 messaging channels (Slack, Teams, Discord, Email, etc.)

### What a Persona Template Contains

Each template is a JSON blueprint that bundles:

| Component | What It Defines |
|-----------|----------------|
| **Role configuration** | Capabilities (code, review, test, analyze, etc.), autonomy level (specialist or lead), personality profile, and a deep system prompt that defines the twin's behavior boundaries |
| **Heartbeat configuration** | Default wake interval and stagger offset (prevents all twins from firing simultaneously) |
| **Cognitive offload categories** | Which types of mental work the twin absorbs (from a taxonomy of 10 categories) |
| **Proactive tasks** | 2-4 heartbeat-driven tasks, each with a prompt template, frequency, priority, and enabled/disabled flag |
| **Skill references** | Recommended skills the twin should have access to, with reasons and required/optional flags |
| **Metadata** | Category, tags, seniority range, and industry-agnostic flag for gallery filtering |

Activating a template creates a fully configured AgentRole in one click. After activation, every property is editable — the template is a starting point, not a constraint.

---

## The Cognitive Offload Model

Digital twins target 10 categories of work that fragment human attention. Every role has a different mix. The cognitive offload model maps each category to specific types of mental burden:

| Category | What It Absorbs | Example |
|----------|----------------|---------|
| **Context Switching** | Gathering context when moving between projects, repos, or discussions | "What was the status of the auth migration when I left it Friday?" |
| **Status Reporting** | Compiling progress updates, standup summaries, sprint reviews, executive briefs | "Prepare my standup update from yesterday's git activity" |
| **Information Triage** | Filtering, prioritizing, and routing incoming information (PRs, issues, messages, alerts) | "Which of these 47 new issues actually need my attention?" |
| **Decision Preparation** | Assembling data, options, trade-offs, and recommendations for pending decisions | "What are the pros/cons of migrating to GraphQL vs. staying REST?" |
| **Documentation** | Keeping docs current, writing changelogs, maintaining audit trails | "Which docs are stale after this week's API changes?" |
| **Review Preparation** | Building review queues, risk assessments, checklists, and pre-review summaries | "Rank open PRs by risk and staleness for my review session" |
| **Dependency Tracking** | Monitoring external dependencies, vulnerabilities, upstream changes, blockers | "Are any of our npm packages affected by the latest CVE?" |
| **Compliance Checks** | Checking against standards, SLAs, regulatory requirements, internal policies | "Are we meeting our 99.9% uptime SLA this quarter?" |
| **Knowledge Curation** | Organizing, tagging, and surfacing institutional knowledge | "What design decisions were made about the notification system?" |
| **Routine Automation** | Handling repetitive checks, scheduled scans, and operational housekeeping | "Run the daily flaky test scan and report results" |

Each persona template declares 3-4 primary categories. These shape both the proactive tasks and the twin's general behavior when given ad-hoc work.

---

## Built-In Personas (Detailed)

### Software Engineer

**Category**: Engineering | **Autonomy**: Specialist | **Default Heartbeat**: 30 minutes

**What it absorbs**: Review preparation, dependency tracking, context switching, documentation

**System prompt behavior**: The twin never makes production changes without approval. It surfaces information and recommendations — prioritized review queues, coverage gaps, dependency risks — but leaves all decisions to the human.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| PR Triage & Review Prep | Every 60 min | Scans open PRs, summarizes changes in 2-3 lines per PR, assesses risk (low/medium/high) based on files touched and complexity, notes missing tests or failing CI, flags PRs older than 48 hours. Outputs a prioritized review queue. |
| Test Coverage Gap Analysis | Every 4 hours | Reviews last 24 hours of git history, identifies modified files lacking corresponding test updates, lists specific functions that should have tests, prioritizes by risk. |
| Dependency Health Check | Every 8 hours | Analyzes project dependencies for security vulnerabilities, major version updates, deprecated packages, and license compliance issues. Summarizes with severity ratings. |
| Technical Debt Scanner | Every 24 hours (disabled by default) | Scans codebase for TODO/FIXME/HACK comments added in the last week, categorizes by severity and area, suggests priority order. |

**Recommended skills**: `code-review` (required), `write-tests` (required), `twin-pr-triage` (required), `twin-status-report`, `refactor-code`, `explain-code`

**Best for**: Backend, frontend, and fullstack developers at any seniority level (junior through principal).

---

### Hardware Engineer

**Category**: Engineering | **Autonomy**: Specialist | **Default Heartbeat**: 60 minutes

**What it absorbs**: Documentation, compliance checks, dependency tracking, decision preparation

**System prompt behavior**: Presents information in structured tables and specification-style formatting. Tracks cross-functional alignment between HW, FW, and manufacturing teams. Flags specification mismatches and schedule conflicts proactively.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Design Review Action Items | Every 2 hours | Extracts open action items from design review notes, identifies owners and due dates, flags overdue items. |
| Specification Mismatch Detection | Every 8 hours | Scans documentation for parameter inconsistencies across electrical, mechanical, and firmware interfaces — voltage levels, pin assignments, timing constraints, protocols. |
| Component Alternatives Research | Every 24 hours (disabled by default) | For flagged components with supply chain risk, researches 2-3 alternatives comparing availability, lead time, pin compatibility, electrical characteristics, and cost. |

**Recommended skills**: `twin-status-report` (required), `twin-decision-prep` (required), `twin-meeting-prep` (required), `explain-code`

**Best for**: Electrical, mechanical, embedded, and PCB engineers at mid through principal level.

---

### QA / System Test Engineer

**Category**: Engineering | **Autonomy**: Specialist | **Default Heartbeat**: 60 minutes

**What it absorbs**: Review preparation, compliance checks, routine automation, status reporting

**System prompt behavior**: Thorough and methodical, always referencing specific test cases and evidence. Flags quality risks with clear severity assessments. Prepares data for release decisions but never approves releases or signs off on quality.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Test Coverage Report | Every 4 hours | Reports overall coverage percentage, lowest-coverage areas, recently changed files without test updates, and coverage trends. |
| Flaky Test Detector | Every 8 hours | Reviews CI/CD runs for tests with inconsistent pass/fail patterns. Categorizes by likely root cause (timing, state, environment, resource contention). |
| Release Readiness Assessment | Every 24 hours (disabled by default) | Prepares release readiness data: test pass rate, open bugs by severity, untested changes, performance regression indicators. Provides risk-rated summary without making the go/no-go decision. |

**Recommended skills**: `write-tests` (required), `code-review` (required), `twin-status-report` (required), `twin-pr-triage`

**Best for**: QA engineers, SDET, and system test engineers at mid through staff level.

---

### DevOps / SRE Engineer

**Category**: Engineering | **Autonomy**: Specialist | **Default Heartbeat**: 30 minutes

**What it absorbs**: Routine automation, compliance checks, dependency tracking, context switching

**System prompt behavior**: Reliability-focused and security-aware. Flags anomalies and degradation patterns early. Never executes infrastructure changes or deployments without explicit approval.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Security Advisory Scan | Every 4 hours | Scans for recent CVEs and vulnerability disclosures affecting the technology stack. Assesses exposure risk, identifies affected components, recommends remediation with priority. |
| Incident Postmortem Action Tracker | Every 8 hours | Reviews open action items from incident postmortems. Identifies owners, due dates, overdue items, and stalled actions. Reports overall completion rate. |
| SLA Compliance Report | Every 24 hours (disabled by default) | Calculates uptime percentages, error rates, and latency metrics against SLOs. Identifies services approaching error budget limits. Flags breaches and near-misses. |

**Recommended skills**: `twin-status-report` (required), `code-review` (required), `twin-decision-prep`

**Best for**: DevOps engineers, SREs, infrastructure engineers, and platform engineers at mid through staff level.

---

### Engineering Manager

**Category**: Management | **Autonomy**: Lead | **Default Heartbeat**: 30 minutes

**What it absorbs**: Status reporting, context switching, decision preparation, information triage

**System prompt behavior**: Organized, empathetic, action-oriented. Handles information-gathering and status-tracking so the manager focuses on people, strategy, and unblocking. Never makes people decisions or communicates on behalf of the manager without approval.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Sprint Health Check | Every 2 hours | Reviews sprint status per team member: tasks completed, in-progress items, blockers. Calculates sprint progress percentage. Flags at-risk items and stalled work (3+ days without updates). |
| 1-on-1 Meeting Prep | Every 24 hours | For each team member: summarizes recent work, identifies blockers, notes recognition-worthy accomplishments, lists open action items from previous meetings, suggests 2-3 discussion topics. |
| Cross-Team Dependency Scan | Every 4 hours | Identifies items blocked by external teams, pending external reviews, shared resource conflicts, and upcoming milestones dependent on other teams. Risk-rates each dependency. |

**Recommended skills**: `twin-status-report` (required), `twin-meeting-prep` (required), `twin-pr-triage`, `twin-decision-prep`

**Best for**: Engineering managers and team leads at mid through senior level.

---

### Technical Director

**Category**: Management | **Autonomy**: Lead | **Default Heartbeat**: 60 minutes

**What it absorbs**: Decision preparation, status reporting, context switching, knowledge curation

**System prompt behavior**: Strategic, analytical, systems-thinker. Focuses on system-level architecture, technical debt at scale, platform decisions, and cross-team alignment. Presents options with trade-offs, not just recommendations. Never makes architecture decisions unilaterally.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Technical Strategy Brief | Every 24 hours | Covers system reliability trends, pending architecture decisions, technical debt hotspots, platform risks, and upcoming milestones. Risk-rated with items requiring director attention. |
| Architecture Decision Review | Every 8 hours | Reviews pending architecture decisions and technical RFCs. Summarizes proposals, lists trade-offs, identifies stakeholders who haven't weighed in, flags stalled decisions. |
| Technical Risk Register Update | Every 24 hours | Scans for new risks from incidents, architecture changes, and dependency updates. Assesses probability, impact, and mitigation status. Flags risks with increased severity. |

**Recommended skills**: `twin-decision-prep` (required), `twin-status-report` (required), `twin-meeting-prep` (required), `code-review`

**Best for**: Technical directors, principal engineers in leadership roles, and distinguished engineers.

---

### VP of Engineering

**Category**: Management | **Autonomy**: Lead | **Default Heartbeat**: 120 minutes

**What it absorbs**: Status reporting, decision preparation, information triage, context switching

**System prompt behavior**: Operates at organizational altitude. Focuses on patterns, not individual tasks. Presents information high-level with drill-down available. Flags strategic risks and opportunities. Never represents the VP in communications or makes organizational decisions.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Executive Brief Preparation | Every 24 hours | Covers key engineering metrics (velocity, quality, uptime), notable accomplishments, strategic risks, hiring pipeline status (open roles, interviews, offers), and upcoming milestones. One-page executive summary format. |
| OKR Progress Tracker | Every 24 hours | Reviews quarterly OKR progress for the engineering org. Summarizes key result progress (on-track/at-risk/behind), notes blockers, identifies objectives needing VP intervention. Overall confidence rating. |
| Organizational Health Dashboard | Every 24 hours (disabled by default) | Compiles team velocity trends, PR review times, incident frequency, on-call burden distribution, and team-level anomalies. Flags teams needing support. |

**Recommended skills**: `twin-status-report` (required), `twin-decision-prep` (required), `twin-meeting-prep` (required)

**Best for**: VPs of Engineering, SVPs, and CTOs.

---

### Product Manager

**Category**: Product | **Autonomy**: Lead | **Default Heartbeat**: 60 minutes

**What it absorbs**: Information triage, decision preparation, documentation, context switching

**System prompt behavior**: User-focused, data-informed, strategic. Presents information through the lens of user value and business impact. Helps maintain the backlog with data-driven prioritization inputs. Never commits to features or timelines on behalf of the PM.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Feature Request Triage | Every 4 hours | Reviews recent feature requests and bug reports. Categorizes by product area, assesses user impact, identifies duplicates, suggests priority relative to roadmap. Groups related requests into themes. |
| Sprint Goal Alignment Check | Every 8 hours | Reviews current sprint work against stated sprint goals and quarterly objectives. Identifies scope creep, goals at risk, and unplanned work consuming capacity. Provides alignment score. |
| Customer Feedback Digest | Every 24 hours (disabled by default) | Compiles and synthesizes customer feedback. Groups into themes, ranks by frequency and severity, identifies emerging patterns, notes feedback contradicting current assumptions. |

**Recommended skills**: `twin-status-report` (required), `twin-decision-prep` (required), `twin-meeting-prep` (required)

**Best for**: Product managers, program managers, and TPMs at mid through staff level.

---

### Data Scientist / Analyst

**Category**: Data & Analytics | **Autonomy**: Specialist | **Default Heartbeat**: 60 minutes

**What it absorbs**: Decision preparation, context switching, documentation, knowledge curation

**System prompt behavior**: Rigorous about data quality and statistical validity. Presents findings with appropriate caveats and confidence intervals. Never publishes analysis results or makes data-driven recommendations without human review.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Data Quality Monitor | Every 4 hours | Reviews data pipeline outputs for missing values, unexpected distributions, schema changes, late-arriving data, and anomalous patterns. Assesses severity, identifies downstream impact. Overall data quality score. |
| Experiment Status Tracker | Every 8 hours | Reports on active A/B tests: current vs. required sample size, estimated time to significance, preliminary results with early-peeking caveats, data quality concerns. |
| Data Pipeline Health Check | Every 2 hours (disabled by default) | Identifies failed/delayed pipeline runs, stale datasets, resource usage anomalies, and configuration drift. Dashboard-style summary with freshness timestamps. |

**Recommended skills**: `twin-status-report` (required), `twin-decision-prep` (required), `explain-code`, `write-tests`

**Best for**: Data scientists, data analysts, ML engineers, and analytics engineers at mid through principal level.

---

### Technical Writer

**Category**: Operations | **Autonomy**: Specialist | **Default Heartbeat**: 120 minutes

**What it absorbs**: Documentation, knowledge curation, review preparation

**System prompt behavior**: Cares deeply about clarity, consistency, and user experience in documentation. Never publishes documentation without explicit review and approval.

**Proactive tasks**:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Documentation Freshness Audit | Every 8 hours | Compares recent code changes against existing docs. Identifies docs referencing changed APIs, outdated README files, stale configuration examples, and broken internal links. Prioritized by user impact. |
| API Changelog Draft | Every 24 hours | Reviews commits and PRs affecting API surfaces. Drafts changelog entries (added, changed, deprecated, removed, fixed, security) in keep-a-changelog format. |
| Style Guide Compliance Check | Every 24 hours (disabled by default) | Reviews recent doc changes for consistent terminology, heading hierarchy, code example formatting, alt text, and cross-reference integrity. Lists violations with suggested corrections. |

**Recommended skills**: `twin-status-report` (required), `explain-code` (required), `code-review`

**Best for**: Technical writers, documentation engineers, and developer advocates at mid through staff level.

---

## Bundled Skills

Four skills ship with the Digital Twin system. These can be invoked on-demand by any twin (or any agent).

### Status Report Generator (`twin-status-report`)

Generates a concise status report from recent activity, tasks, commits, and conversations.

**Parameters**:
- `period` — Time period to cover (default: "24 hours")
- `audience` — Who the report is for: team standup, engineering leadership, cross-functional stakeholders, or executive summary

**Output**: Markdown status report organized by: completed work, in progress, blocked/at risk, upcoming.

**Use when**: Standup updates, progress summaries, sprint reviews, weekly reports.

---

### PR Triage & Review Queue (`twin-pr-triage`)

Scans open pull requests, assesses risk and complexity, and builds a prioritized review queue.

**Parameters**:
- `stale_hours` — Hours after which a PR is considered stale (default: 48)

**Output**: Prioritized PR review queue with risk assessments, age, CI status, and merge conflict flags.

**Requires**: `gh` CLI installed.

**Use when**: Triaging open PRs, building a review queue, assessing PR backlog health.

---

### Meeting Preparation Brief (`twin-meeting-prep`)

Prepares a structured brief for an upcoming meeting with relevant context, open items, data points, and talking points.

**Parameters**:
- `meeting_topic` (required) — What the meeting is about (e.g., "Sprint planning", "Architecture review for auth service", "1-on-1 with Sarah")

**Output**: A scannable document covering context, open items, key questions, talking points, data points, and attendee context. Designed to be reviewed in 5 minutes before the meeting.

**Use when**: Preparing for meetings, 1-on-1s, reviews, planning sessions, or any scheduled discussion.

---

### Decision Preparation Package (`twin-decision-prep`)

Assembles data, options, and analysis for a pending decision. Presents trade-offs and recommendations without making the decision.

**Parameters**:
- `decision_topic` (required) — The decision to prepare for (e.g., "Migrate from REST to GraphQL", "Choose between Redis and Memcached")
- `num_options` — Number of options to analyze (default: "2-4")

**Output**: Structured decision package with decision statement, context, options with pros/cons/effort/reversibility, data points, stakeholder input, recommendation (labeled as suggestion), and open questions.

**Use when**: Architecture choices, technology selection, resource allocation, or any trade-off evaluation.

---

## Day-in-the-Life Scenarios

### Scenario 1: Software Engineer — "Morning Code Review"

**7:30 AM** — You open your laptop. Your twin ran PR triage at 6:00 AM and again at 7:00 AM.

In Mission Control, you see a completed task: **PR Triage & Review Prep**. The output is a prioritized review queue:

```
1. [HIGH RISK] feat: rewrite auth middleware — 847 lines, touches 12 files, no tests added, open 3 days
2. [MEDIUM] fix: race condition in websocket handler — 23 lines, has tests, CI passing, open 1 day
3. [LOW] chore: update dependencies — 4 lines, lockfile only, open 2 hours
```

You start with the high-risk PR. Before diving in, you @mention your twin: `@sw-twin what's the context for the auth middleware rewrite?`. The twin summarizes the related issue, design discussion, and relevant architecture decisions.

**9:00 AM** — Standup. Your twin already ran `twin-status-report` at 8:30 AM. You paste the output:
- Completed: reviewed 3 PRs, fixed the caching bug (#412)
- In progress: auth service refactor (60% complete)
- Blocked: waiting on DB team for schema change

**2:00 PM** — You have an architecture meeting. Your twin ran `twin-meeting-prep` for "auth service architecture review", pulling together the original design doc, recent changes, open questions, and the 3 approaches discussed in Slack.

**4:00 PM** — The dependency health check flagged a CVE in a transitive dependency. You see: "Critical: CVE-2024-XXXX affects `jsonwebtoken@8.x`. Used in auth-service and api-gateway. Recommend upgrading to `jsonwebtoken@9.2.0`."

**Total time saved**: The engineer spent zero minutes gathering context for reviews, compiling standup notes, preparing for the meeting, or discovering the CVE. That work happened in the background.

---

### Scenario 2: Engineering Manager — "Sprint Planning Week"

**Monday morning** — Your twin's sprint health check shows: 73% sprint complete with 2 days remaining. Three items flagged at-risk: one blocked on another team, one with no updates for 4 days, one with failing CI.

You focus your Monday standup on the three flagged items instead of walking through every ticket.

**Before 1-on-1s** — Your twin prepared per-person briefs:
- **Sarah**: Completed the caching layer. Recognition-worthy: zero bugs in review. Potential concern: she hasn't taken PTO in 6 weeks.
- **Alex**: Blocked on the DB schema change since Thursday. Action from last 1-on-1: investigate GraphQL (still open).

You walk into each 1-on-1 with context instead of spending the first 5 minutes asking "so what are you working on?"

**Wednesday** — Cross-team dependency scan flagged: "Platform team's API deprecation (March 15) affects 3 of your team's services. No migration tickets exist yet." You create tickets and assign them before the deadline becomes a crisis.

**Friday** — Sprint retro. Your twin compiled: velocity trend (down 12% from last sprint), top blocker category (cross-team dependencies), PR review time (median 18 hours, up from 12).

---

### Scenario 3: Product Manager — "Feature Prioritization"

**Tuesday morning** — Your twin triaged 23 new feature requests overnight:
- 5 duplicates of existing requests (auto-grouped)
- 3 high-impact requests related to the new onboarding flow
- 1 request from a top-10 customer (flagged for priority)
- 14 low-priority or already-on-roadmap items

You review the 4 items that need your attention instead of all 23.

**Before sprint planning** — You need to decide whether to ship the dashboard redesign or the API v2 migration. You ask your twin: `@pm-twin prepare decision package for dashboard redesign vs API v2 migration`.

30 minutes later, the twin produces a decision package:
- Dashboard redesign: 3 sprints, affects 80% of daily users, high visibility, fully reversible
- API v2: 2 sprints, unblocks 5 integration partners, high revenue impact, harder to reverse
- Data: customer feedback weighted 3:1 toward API, but churn analysis shows dashboard UX is the #2 reason for churn
- Recommendation: API v2 first (revenue impact + partner commitments), dashboard in Q3

You adjust the recommendation based on context the twin doesn't have (board pressure on growth metrics) and walk into planning with a clear, data-backed proposal.

---

### Scenario 4: VP of Engineering — "Board Prep Week"

**Monday** — Your twin's executive brief lands with org-level metrics:
- Velocity: up 8% org-wide, but Team Bravo down 22% (investigated: key engineer on leave + infrastructure migration)
- Quality: defect escape rate improved from 2.3% to 1.8%
- Incidents: 3 P1s in Q4, down from 7 in Q3. Mean time to resolution: 47 minutes
- Hiring: 4 open roles, 12 candidates in pipeline, 2 offers out

**Wednesday** — OKR tracker shows:
- OKR 1 (Platform reliability): On track (99.95% uptime vs. 99.9% target)
- OKR 2 (Developer velocity): At risk (build times still 40% above target)
- OKR 3 (API v2 launch): Behind (blocked on partner testing)

You focus your leadership sync on OKR 2 and 3 instead of reviewing all objectives.

**Thursday** — Strategic risk scan flagged: "Two senior engineers on Team Alpha have accepted external offers (per HR data). Team Alpha owns the payment processing system. Risk: institutional knowledge loss in a critical system."

You escalate the retention issue before it becomes a surprise.

---

### Scenario 5: DevOps/SRE — "Incident Response Week"

**Monday 6 AM** — Your twin's security advisory scan found 2 new CVEs:
- Critical: CVE affecting your container runtime version. Actively exploited. Affected services: 12 of 47.
- Medium: CVE in a logging library. No known exploit. Affected services: 3.

You patch the critical CVE before most people start work.

**Wednesday** — Incident postmortem action tracker shows: "5 of 8 action items from last week's outage are complete. 2 are overdue: 'Add circuit breaker to payment service' (assigned to Sarah, overdue 3 days) and 'Update runbook for database failover' (unassigned)."

You reassign the stalled items in your daily standup.

**Friday** — SLA compliance report: "99.93% uptime this month against 99.9% SLA. Error budget consumed: 67%. Two services approaching budget limit: API gateway (82% consumed) and notification service (78% consumed)."

You proactively reduce deployment frequency for the at-risk services until the error budget recovers.

---

### Scenario 6: Data Scientist — "Model Monitoring"

**Morning** — Data quality monitor flagged: "Anomalous pattern in user_events table: NULL rate for `session_duration` jumped from 0.3% to 12.7% at 02:00 UTC. Likely cause: schema change in event producer service deployed at 01:45. Affected downstream: recommendation model training pipeline, daily analytics dashboard."

You alert the engineering team about the broken producer before the model retraining picks up bad data.

**Afternoon** — Experiment tracker shows: "A/B test 'new-onboarding-v2' at 73% of required sample size. Estimated 4 more days to statistical significance. Preliminary result: +6.2% activation rate (p=0.08, not yet significant). No data quality concerns."

You update stakeholders that results are trending positive but need more time, backed by actual statistical reasoning instead of gut feel.

---

### Scenario 7: Technical Writer — "Release Documentation"

**Monday** — Documentation freshness audit found:
- 4 API endpoints documented in `api-reference.md` no longer exist (removed in PR #891)
- The `configuration.md` guide references environment variables that were renamed last sprint
- 2 broken internal links in the getting-started guide

You fix the stale docs before users hit them.

**Thursday** — API changelog draft compiled from the week's PRs:
```
### Added
- POST /api/v2/webhooks - Register webhook endpoints
- GET /api/v2/analytics/export - Export analytics data

### Changed
- GET /api/v2/users - Added `include_inactive` query parameter
- POST /api/v2/tasks - `priority` field now accepts string values ("low", "medium", "high")

### Deprecated
- GET /api/v1/reports - Use /api/v2/analytics/export instead
```

You review, edit for clarity, and publish — instead of manually diffing PRs against docs.

---

## Scaling Across an Organization

Digital twins scale linearly. For a 100-person engineering organization:

| Role | Count | Template | Named Example |
|------|-------|----------|---------------|
| Software Engineers | 60 | Software Engineer | "Sarah's Twin", "Alex's Twin" |
| QA Engineers | 8 | QA / System Test Engineer | "QA-Team-Alpha Twin" |
| DevOps/SRE | 5 | DevOps / SRE Engineer | "Platform Twin" |
| Engineering Managers | 8 | Engineering Manager | "Team-Bravo-EM Twin" |
| Product Managers | 6 | Product Manager | "Payments-PM Twin" |
| Data Scientists | 4 | Data Scientist / Analyst | "ML-Team Twin" |
| Technical Writers | 2 | Technical Writer | "Docs Twin" |
| Technical Directors | 3 | Technical Director | "Platform-Director Twin" |
| VP of Engineering | 1 | VP of Engineering | "VP-Eng Twin" |
| Hardware Engineers | 3 | Hardware Engineer | "HW-Team Twin" |

**Total: 100 twins serving 100 people.**

Each twin learns over time through CoWork OS's playbook and relationship memory systems. Corrections, preferences, and successful approaches get captured and reinforced. The knowledge graph builds organizational context (who owns what, cross-team dependencies) that all twins can reference.

### Organizational benefits at scale

- **Consistent reporting**: Every status report follows the same structure, making org-level aggregation trivial
- **Early warning system**: 100 twins scanning for risks means blockers, vulnerabilities, and drift get caught within hours, not weeks
- **Institutional memory**: Twins maintain context even when people are on vacation, change teams, or leave
- **Reduced meeting burden**: When every attendee's twin has prepared a brief, meetings start at "what should we decide?" instead of "let me share my screen and walk you through..."

---

## Expanding to Other Job Areas

The 10 built-in templates cover core technology roles. The persona template system is designed to be extended to any job function where cognitive overhead exists. Below are additional areas where digital twins would apply, with the cognitive offload categories they would target and example proactive tasks.

### Design

**Roles**: UX Designer, UI Designer, UX Researcher, Design Systems Engineer, Brand Designer

**Primary offload**: Review preparation, information triage, documentation, knowledge curation

**Example proactive tasks**:
- **Design Review Queue** (every 4 hours) — Scan design files and Figma links referenced in recent PRs, flag implementations that deviate from design specs, build a review queue prioritized by user-facing impact
- **Component Audit** (every 24 hours) — Check new UI components against the design system library, flag deviations from established patterns, identify opportunities for component reuse
- **Usability Feedback Digest** (every 24 hours) — Aggregate user research findings, support tickets mentioning UX issues, and session recording highlights into a themed digest
- **Accessibility Compliance Scan** (every 8 hours) — Review recent frontend changes for WCAG compliance issues, flag missing alt text, contrast ratio violations, and keyboard navigation gaps

---

### Security

**Roles**: Security Engineer, Application Security Engineer, Security Analyst, CISO

**Primary offload**: Compliance checks, dependency tracking, information triage, routine automation

**Example proactive tasks**:
- **Vulnerability Scan Digest** (every 4 hours) — Aggregate results from SAST/DAST tools, vulnerability scanners, and bug bounty submissions into a prioritized action list
- **Access Review Preparation** (every 24 hours) — Audit recent permission changes, flag elevated privileges, identify dormant accounts, prepare quarterly access review data
- **Threat Intelligence Triage** (every 8 hours) — Monitor threat feeds for indicators relevant to the company's tech stack and industry, summarize actionable intelligence
- **Compliance Posture Check** (every 24 hours) — Review changes against SOC 2, ISO 27001, or industry-specific compliance controls, flag gaps before audit season

---

### Sales & Revenue

**Roles**: Account Executive, Sales Engineer, Revenue Operations Analyst, Sales Manager

**Primary offload**: Information triage, decision preparation, context switching, status reporting

**Example proactive tasks**:
- **Pipeline Health Check** (every 4 hours) — Review CRM pipeline for stalled deals, upcoming close dates, missing next steps, and stage-specific conversion rates
- **Account Intelligence Brief** (every 8 hours) — Compile recent news, earnings, job postings, and org changes for accounts in active deals
- **Competitive Win/Loss Digest** (every 24 hours) — Analyze recent win/loss data, identify patterns by competitor, deal size, and industry vertical
- **Forecast Accuracy Tracker** (every 24 hours) — Compare current pipeline stage-weighted forecast against historical accuracy rates, flag optimistic or pessimistic outliers

---

### Customer Success & Support

**Roles**: Customer Success Manager, Support Engineer, Support Manager, Customer Advocate

**Primary offload**: Information triage, status reporting, context switching, knowledge curation

**Example proactive tasks**:
- **At-Risk Account Scanner** (every 4 hours) — Monitor support ticket volume, NPS trends, feature adoption rates, and contract renewal dates to flag at-risk accounts
- **Ticket Trend Analysis** (every 8 hours) — Identify trending support topics, recurring issues by product area, and resolution time outliers
- **Knowledge Base Gap Detector** (every 24 hours) — Compare top support ticket categories against existing knowledge base articles, identify missing or outdated documentation
- **Renewal Preparation Brief** (every 24 hours) — For upcoming renewals: compile usage metrics, support history, feature requests, and health score into a renewal preparation package

---

### Human Resources & People Ops

**Roles**: HR Business Partner, Recruiter, People Analytics Specialist, HR Manager

**Primary offload**: Information triage, compliance checks, status reporting, decision preparation

**Example proactive tasks**:
- **Hiring Pipeline Status** (every 4 hours) — Summarize active roles: applicants in pipeline, time in each stage, interviewer bottlenecks, offer acceptance rates
- **Onboarding Checklist Tracker** (every 24 hours) — Monitor new hire onboarding progress, flag incomplete checklist items, identify common friction points
- **Compliance Calendar Check** (every 24 hours) — Track upcoming compliance deadlines: mandatory training renewals, benefits enrollment windows, labor law posting updates
- **Attrition Signal Monitor** (weekly) — Analyze engagement survey data, tenure distribution, and behavioral signals to identify retention risks

---

### Finance & Accounting

**Roles**: Financial Analyst, Controller, FP&A Manager, Accounts Payable/Receivable Specialist

**Primary offload**: Compliance checks, status reporting, routine automation, decision preparation

**Example proactive tasks**:
- **Budget vs. Actual Variance Report** (every 24 hours) — Compare spending against budget across departments, flag variances exceeding thresholds, identify trending overruns
- **Invoice Processing Status** (every 4 hours) — Summarize pending invoices, aging receivables, overdue payments, and cash flow projections
- **Expense Policy Compliance Check** (every 24 hours) — Review submitted expenses against policy, flag violations, identify patterns suggesting policy updates
- **Financial Close Preparation** (monthly) — Compile accruals, reconciliation items, and outstanding journal entries needed for month-end close

---

### Legal & Compliance

**Roles**: Corporate Counsel, Compliance Officer, Contract Manager, Privacy Officer

**Primary offload**: Compliance checks, documentation, information triage, knowledge curation

**Example proactive tasks**:
- **Contract Renewal Tracker** (every 24 hours) — Monitor contracts approaching renewal or expiration, flag auto-renewal windows, identify renegotiation opportunities
- **Regulatory Change Monitor** (every 8 hours) — Scan regulatory feeds for changes affecting the business (GDPR, CCPA, industry-specific regulations), summarize impact and required actions
- **Policy Compliance Audit Prep** (weekly) — Review internal processes against documented policies, identify gaps, prepare audit evidence packages
- **IP and Patent Filing Status** (every 24 hours) — Track patent application status, filing deadlines, prior art search results, and maintenance fee due dates

---

### Marketing

**Roles**: Marketing Manager, Content Strategist, Growth Marketer, Marketing Analyst

**Primary offload**: Information triage, status reporting, context switching, routine automation

**Example proactive tasks**:
- **Campaign Performance Dashboard** (every 4 hours) — Aggregate metrics across channels (email, social, paid, organic), flag underperforming campaigns, identify top performers
- **Content Calendar Status** (every 24 hours) — Track content pipeline: drafts in progress, items awaiting review, published content, and gaps in the calendar
- **Competitive Content Monitor** (every 24 hours) — Track competitor blog posts, product announcements, and social media activity, summarize positioning changes
- **SEO Health Check** (weekly) — Monitor keyword rankings, organic traffic trends, broken links, and page speed metrics, flag pages needing attention

---

### Research & Development

**Roles**: Research Scientist, R&D Engineer, Research Manager, Lab Director

**Primary offload**: Knowledge curation, documentation, decision preparation, context switching

**Example proactive tasks**:
- **Literature Review Digest** (every 24 hours) — Scan recent publications in relevant fields (arXiv, PubMed, IEEE), summarize papers related to active research threads
- **Experiment Log Compiler** (every 8 hours) — Aggregate experiment results, maintain a structured log with parameters, outcomes, and observations
- **Patent Landscape Scanner** (weekly) — Monitor new patent filings in the technology area, identify potential conflicts or inspiration for current projects
- **Research Progress Brief** (every 24 hours) — Compile progress across research workstreams, flag experiments that need attention, identify cross-project synergies

---

### Executive Leadership

**Roles**: CEO, COO, CTO, CFO, General Manager

**Primary offload**: Status reporting, decision preparation, information triage, context switching

**Example proactive tasks**:
- **Executive Intelligence Brief** (every 8 hours) — Compile company-wide metrics, market indicators, competitive moves, and internal pulse check into a single-page brief
- **Board Meeting Preparation** (weekly) — Assemble board deck data: financials, OKRs, hiring, product milestones, risk register, competitive positioning
- **Strategic Initiative Tracker** (every 24 hours) — Monitor progress on top-5 company initiatives, flag blockers requiring executive intervention
- **Stakeholder Communication Prep** (every 24 hours) — Prepare talking points for investor calls, all-hands meetings, press inquiries, and partner discussions

---

### Education & Training

**Roles**: Instructional Designer, Training Manager, Corporate Trainer, Curriculum Developer

**Primary offload**: Documentation, knowledge curation, review preparation, status reporting

**Example proactive tasks**:
- **Training Content Freshness Audit** (weekly) — Compare training materials against product changes, flag outdated modules, identify gaps in onboarding coverage
- **Learner Progress Dashboard** (every 24 hours) — Aggregate completion rates, quiz scores, and engagement metrics across training programs
- **New Hire Readiness Check** (every 24 hours) — Track onboarding cohort progress against expected timelines, flag people who may need additional support
- **Skill Gap Analysis** (monthly) — Analyze competency assessment data against role requirements, identify team-level and organization-level skill gaps

---

### Healthcare & Life Sciences

**Roles**: Clinical Research Associate, Regulatory Affairs Specialist, Medical Science Liaison, Lab Manager

**Primary offload**: Compliance checks, documentation, dependency tracking, decision preparation

**Example proactive tasks**:
- **Regulatory Submission Tracker** (every 24 hours) — Monitor submission timelines, flag approaching deadlines, track reviewer feedback and response requirements
- **Protocol Deviation Monitor** (every 8 hours) — Scan for protocol deviations in active studies, categorize by severity, prepare deviation reports
- **Literature Surveillance** (every 24 hours) — Monitor medical literature for safety signals, competitive clinical results, and regulatory guidance changes relevant to active programs
- **Lab Equipment Compliance Check** (weekly) — Track calibration schedules, maintenance logs, and certification expirations for regulated equipment

---

### Supply Chain & Logistics

**Roles**: Supply Chain Analyst, Logistics Coordinator, Procurement Manager, Warehouse Operations Lead

**Primary offload**: Dependency tracking, routine automation, compliance checks, status reporting

**Example proactive tasks**:
- **Shipment Status Tracker** (every 2 hours) — Monitor in-transit shipments, flag delayed deliveries, identify customs holds, provide ETA updates
- **Inventory Level Monitor** (every 4 hours) — Check inventory levels against reorder points, flag items approaching stockout, identify slow-moving inventory
- **Supplier Performance Scorecard** (weekly) — Compile on-time delivery rates, quality metrics, and pricing trends for active suppliers
- **Demand Forecast Variance** (every 24 hours) — Compare actual demand against forecast, flag significant deviations, identify products requiring forecast adjustment

---

## Creating Custom Templates

To add a persona for any job function:

1. Create a JSON file following the `PersonaTemplate` schema
2. Place it in `resources/persona-templates/`
3. Restart CoWork OS — the template appears in the gallery

### Template structure

```json
{
  "id": "your-role-id",
  "version": "1.0.0",
  "name": "Your Role Name",
  "description": "What this twin does for the human in this role.",
  "icon": "emoji",
  "color": "#hexcolor",
  "category": "engineering|management|product|data|operations",
  "role": {
    "capabilities": ["cap1", "cap2"],
    "autonomyLevel": "specialist|lead",
    "personalityId": "technical|professional",
    "systemPrompt": "Detailed behavior instructions...",
    "soul": "{\"name\":\"...\",\"role\":\"...\",\"personality\":\"...\",\"focusAreas\":[...]}"
  },
  "heartbeat": {
    "enabled": true,
    "intervalMinutes": 30,
    "staggerOffset": 0
  },
  "cognitiveOffload": {
    "primaryCategories": ["category-1", "category-2"],
    "proactiveTasks": [
      {
        "id": "task-id",
        "name": "Task Name",
        "description": "What this task does",
        "category": "offload-category",
        "promptTemplate": "The prompt injected into the heartbeat...",
        "frequencyMinutes": 60,
        "priority": 1,
        "enabled": true
      }
    ]
  },
  "skills": [
    {"skillId": "skill-id", "reason": "Why this skill", "required": true}
  ],
  "tags": ["tag1", "tag2"],
  "seniorityRange": ["junior", "mid", "senior", "staff", "principal"],
  "industryAgnostic": true
}
```

### Design principles for good templates

- **System prompt**: Define what the twin does AND what it never does. Every template includes a clear "never does X without explicit approval" boundary.
- **Proactive tasks**: 2-4 tasks. Start with the most valuable one enabled, keep less critical ones disabled by default. Users enable them as they see the value.
- **Frequency**: Higher frequency for time-sensitive tasks (security scans, PR triage). Lower frequency for digest-style tasks (executive briefs, changelog drafts).
- **Priority**: Lower number = higher priority. When multiple tasks are due in the same heartbeat cycle, priority determines execution order.
- **Skills**: Mark skills as `required: true` only if the twin's core function depends on them. Optional skills extend capability but aren't essential.

---

## Channel Integration

Since CoWork OS supports 14 messaging channels, twins are accessible from any surface:

| Channel | Example Usage |
|---------|--------------|
| **Slack** | `/inbox @twin-engineering-manager prepare 1-on-1 notes for tomorrow` |
| **Microsoft Teams** | `@twin-sw-engineer summarize auth module changes this week` |
| **Discord** | `!ask @twin-devops check deployment pipeline status` |
| **Email** | Forward a thread to the twin for context extraction and summarization |
| **Telegram** | Send a message to the twin bot with a task description |
| **WhatsApp** | Quick voice-to-text task assignment |
| **iMessage** | Personal device access to your twin |
| **Signal** | Secure channel for sensitive queries |

Heartbeat results can be delivered to channels — e.g., post the daily PR triage to `#engineering-reviews` in Slack, or send the executive brief to the VP's email every morning.

---

## FAQ

**Can I have multiple twins of the same type?**
Yes. You might have a "Backend Twin" and a "Frontend Twin", both from the Software Engineer template but configured with different system prompts and proactive task priorities.

**Do twins talk to each other?**
Not directly. But twins share the same organizational knowledge graph and task system. An engineering manager twin can see the results produced by the software engineer twins on their team.

**What happens if a recommended skill is missing?**
The twin still works. Missing skills produce a warning during activation but don't prevent the twin from functioning. Proactive tasks and ad-hoc work still operate; the twin just can't invoke the specific skill.

**Can I change a twin's configuration after activation?**
Yes. An activated twin is a standard AgentRole. Edit any property via the Agent Role Editor in Mission Control: capabilities, autonomy, personality, system prompt, heartbeat interval, proactive task settings (in the soul JSON).

**How much does each twin cost in API usage?**
Depends on heartbeat frequency and task complexity. A twin with a 30-minute heartbeat running 2-3 tasks per cycle uses roughly the same tokens as a few manual conversations per day. Longer heartbeat intervals (2-4 hours) are more economical for roles that don't need real-time monitoring.

**Can I use local LLMs for twins?**
Yes. CoWork OS supports 30+ LLM providers including Ollama for local models. Assign any model to a twin via the `modelKey` and `providerType` fields during activation.

**What data do twins have access to?**
Twins access the same data as any CoWork OS agent: the workspace's task history, git history, files, conversations, and knowledge graph. They don't have access to data outside what you've configured in your workspace.

**Can twins operate without heartbeat (purely reactive)?**
Yes. Disable the heartbeat during activation or set it to a very long interval. The twin becomes a reactive agent that only works when you assign tasks to it.
