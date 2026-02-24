# Digital Twin Personas

Digital Twin Personas are pre-built AI agent templates that create role-specific digital twins for team members. Each twin absorbs cognitively draining work — status reporting, PR triage, meeting prep, dependency tracking — so the human can stay in deep focus.

A persona template bundles everything needed: agent role configuration, proactive heartbeat-driven tasks, recommended skills, a deep system prompt, and cognitive offload categories. Activating a template creates a fully configured agent in one click.

Access from **Mission Control** > **Add Digital Twin**. Digital twins can also be activated through [Plugin Packs](plugin-packs.md) — 7 of the 10 bundled packs link directly to a persona template.

---

## Concepts

### Persona Template

A JSON blueprint defining a digital twin. Each template specifies:

| Field | Purpose |
|-------|---------|
| **Role config** | Capabilities, autonomy level, personality, system prompt |
| **Heartbeat config** | Wake interval, stagger offset |
| **Cognitive offload** | Which categories of mental work the twin absorbs |
| **Proactive tasks** | Heartbeat-driven tasks with prompt templates, frequency, and priority |
| **Skills** | Recommended skill references with reasons |
| **Metadata** | Category, tags, seniority range, industry-agnostic flag |

### Cognitive Offload Categories

Each template targets specific categories of work that fragment attention:

| Category | What It Absorbs |
|----------|----------------|
| `context-switching` | Gathering context when moving between projects or discussions |
| `status-reporting` | Compiling progress updates, standup summaries, executive briefs |
| `information-triage` | Filtering, prioritizing, and routing incoming information |
| `decision-preparation` | Assembling data, options, and trade-offs for pending decisions |
| `documentation` | Keeping docs current, writing change summaries, audit trails |
| `review-preparation` | Building review queues, risk assessments, review checklists |
| `dependency-tracking` | Monitoring external dependencies, vulnerabilities, blockers |
| `compliance-checks` | Checking against standards, SLAs, regulatory requirements |
| `knowledge-curation` | Organizing, tagging, and surfacing institutional knowledge |
| `routine-automation` | Handling repetitive checks and routine operational tasks |

### Proactive Tasks

Tasks that run automatically on the twin's heartbeat interval. Each proactive task has:

- **Prompt template**: Injected into the heartbeat prompt
- **Frequency**: How often it runs (in minutes)
- **Priority**: Execution order when multiple tasks are due
- **Enabled flag**: Toggled during activation or at runtime via the agent's soul config

---

## Available Templates

### Engineering

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Software Engineer** | Specialist | Review prep, dependency tracking, context switching, documentation |
| **Hardware Engineer** | Specialist | Documentation, compliance, dependency tracking, decision prep |
| **QA / System Test Engineer** | Specialist | Review prep, compliance, automation, status reporting |
| **DevOps / SRE Engineer** | Specialist | Automation, compliance, dependency tracking, context switching |

### Management

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Engineering Manager** | Lead | Status reporting, context switching, decision prep, info triage |
| **Technical Director** | Lead | Decision prep, status reporting, context switching, knowledge curation |
| **VP of Engineering** | Lead | Status reporting, decision prep, info triage, context switching |

### Product

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Product Manager** | Lead | Info triage, decision prep, documentation, context switching |

### Data & Analytics

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Data Scientist / Analyst** | Specialist | Decision prep, context switching, documentation, knowledge curation |

### Operations

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Technical Writer** | Specialist | Documentation, knowledge curation, review prep |

---

## Setup

### Activating a Template

1. Open **Mission Control** from Settings
2. Click **Add Digital Twin** in the agents panel (next to Add Agent)
3. Browse templates — filter by category or search by name/tags
4. Click a template card to open the activation dialog
5. Customize:
   - **Twin Name** — e.g., "Sarah's SW Twin" or "Backend Team Twin"
   - **Heartbeat Interval** — how often the twin wakes up (5 min to 4 hours)
   - **Proactive Tasks** — toggle individual tasks on/off
6. Click **Create Digital Twin**

The twin appears as a new agent in Mission Control, ready to work.

### What Activation Creates

- A new **AgentRole** record with the template's capabilities, personality, and system prompt
- **Heartbeat** configured at your chosen interval
- **Cognitive offload config** embedded in the agent's soul JSON, including enabled proactive tasks
- Warnings if any recommended skills are not installed (non-blocking — the twin works without them)

---

## Daily Operation

Once activated, a twin operates in two modes.

### Proactive Mode (Heartbeat-Driven)

The twin wakes up on its configured interval and automatically runs enabled proactive tasks. Results appear as completed tasks in Mission Control.

**Software Engineer Twin (30-minute heartbeat):**

| Task | Frequency | What It Does |
|------|-----------|-------------|
| PR Review Queue | Every 60 min | Scans open PRs, builds prioritized review queue with risk ratings, flags stale PRs |
| Test Coverage Scan | Every 4 hours | Checks recent code changes for files lacking test coverage |
| Dependency Health | Every 8 hours | Runs dependency check for vulnerabilities and outdated packages |

**Engineering Manager Twin (30-minute heartbeat):**

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Team Status Digest | Every 2 hours | Aggregates team member activity into a status summary |
| Sprint Health Check | Every 4 hours | Monitors sprint progress, flags at-risk items, surfaces blockers |
| Cross-Team Dependency Scan | Every 8 hours | Tracks dependencies between teams, flags blockers early |

**VP of Engineering Twin (60-minute heartbeat):**

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Executive Brief | Every 8 hours | Compiles org-level metrics: velocity, quality, incidents |
| Strategic Risk Scan | Every 12 hours | Surfaces risks across teams: attrition signals, deadline slippage, tech debt accumulation |

### Reactive Mode (On-Demand)

Assign tasks directly to a twin via Mission Control or @mentions:

- Drag a task onto the twin's column in the Kanban board
- @mention the twin: `@sw-engineer-twin summarize what changed in the auth module this week`
- Use a bundled skill: `@twin prepare meeting brief for tomorrow's architecture review`

### Bundled Skills

Four skills ship with the Digital Twin system:

| Skill | ID | Purpose |
|-------|----|---------|
| **Status Report** | `twin-status-report` | Generate status reports from recent activity, git history, and task data |
| **PR Triage** | `twin-pr-triage` | Scan open PRs, assess risk, build a prioritized review queue |
| **Meeting Prep** | `twin-meeting-prep` | Prepare meeting briefs with context, open items, and talking points |
| **Decision Prep** | `twin-decision-prep` | Assemble data, options, and trade-offs for pending decisions |

---

## Enterprise Scenarios

### Individual Contributor (Software Engineer)

**Morning routine:**
- Twin already has a PR review queue ready from the overnight scan, prioritized by risk and staleness
- Before standup: twin runs `twin-status-report` — produces a summary from git history and completed tasks

**During the day:**
- Before a meeting: twin runs `twin-meeting-prep` — assembles relevant context, open items, and talking points
- When a dependency has a CVE: twin flags it in the next dependency health check

**Result:** Engineer stays in code. Twin handles the information-gathering that would otherwise fragment focus.

### Engineering Manager

**Morning routine:**
- Twin has a team status digest ready — who's working on what, who's blocked, what shipped yesterday
- Before 1-on-1s: twin prepared per-person notes (recent work, accomplishments, open items)

**Weekly:**
- Sprint health check surfaces at-risk items before they become problems
- Cross-team dependency scan flags blockers early

**Result:** Manager focuses on people and unblocking. Twin handles data aggregation and status compilation.

### Product Manager

**Morning routine:**
- Twin triaged overnight feature requests and bug reports by priority and theme
- Competitive landscape changes surfaced from monitored sources

**Before sprint planning:**
- Twin prepared a decision package for the top 3 prioritization trade-offs
- Customer feedback synthesized by feature area

**Result:** PM focuses on stakeholder alignment and strategy. Twin handles the information triage.

### Technical Director / VP

**Weekly:**
- Executive brief with org-level metrics (velocity trends, quality metrics, incident rates)
- Architecture decision records prepared with options, trade-offs, and recommendations

**Quarterly:**
- OKR progress tracking across all teams
- Technology radar updates (what's working, what's struggling, what to watch)

**Result:** Leadership focuses on strategy and decisions. Twin handles the reporting and analysis.

### Scaling Across an Organization

For a team of 50 engineers, 5 managers, 2 directors, and 1 VP:

1. Activate 50 **Software Engineer** twins — each named for the person (e.g., "Sarah's Twin")
2. Activate 5 **Engineering Manager** twins
3. Activate 2 **Technical Director** twins
4. Activate 1 **VP of Engineering** twin

Each twin learns over time through the existing playbook and relationship memory systems. Corrections, preferences, and successful approaches get captured and reinforced. The knowledge graph builds organizational context (who owns what, cross-team dependencies) that all twins can reference.

---

## Channel Integration

Since CoWork OS supports 14 messaging channels, twins can be reached from anywhere:

| Channel | Example |
|---------|---------|
| **Slack** | `/inbox @twin-engineering-manager prepare 1-on-1 notes for tomorrow` |
| **Teams** | `@twin-sw-engineer summarize auth module changes this week` |
| **Email** | Forward a thread to the twin for context extraction and summarization |
| **Discord** | `!ask @twin-devops check deployment pipeline status` |

Heartbeat results can be delivered to channels — e.g., post the daily PR triage to `#engineering-reviews`.

---

## Customization

### At Activation Time

- **Name**: Any display name for the twin
- **Heartbeat interval**: 5 minutes to 4 hours
- **Proactive tasks**: Enable/disable individual tasks
- All other role properties (capabilities, autonomy, personality) come from the template defaults

### After Activation

The twin is a standard AgentRole — all properties can be edited via the Agent Role Editor in Mission Control:

- Change capabilities, autonomy level, or personality
- Adjust heartbeat interval
- Edit the system prompt or soul configuration
- Modify proactive task settings in the soul JSON

### Adding Custom Templates

Templates are JSON files in `resources/persona-templates/`. To add a custom template:

1. Create a JSON file following the `PersonaTemplate` schema
2. Place it in the persona templates directory
3. Restart CoWork OS — the template appears in the gallery

---

## Technical Details

### Architecture

```
PersonaTemplate (JSON)
    ↓ activate()
AgentRole (SQLite)
    ↓ heartbeat
HeartbeatService → extractProactiveTasks() → buildHeartbeatPrompt()
    ↓
Agent Executor → Skills → Results in Mission Control
```

### Where Data Lives

| Data | Location |
|------|----------|
| Template definitions | `resources/persona-templates/*.json` |
| Bundled skills | `resources/skills/twin-*.json` |
| Activated twin config | `agent_roles` table (SQLite) |
| Proactive task config | `soul` JSON field on the AgentRole |
| Task results | Standard task records in SQLite |

### IPC Channels

| Channel | Purpose |
|---------|---------|
| `personaTemplate:list` | List all templates with optional filter |
| `personaTemplate:get` | Get a single template by ID |
| `personaTemplate:activate` | Create an AgentRole from a template |
| `personaTemplate:preview` | Preview what activation will create |
| `personaTemplate:getCategories` | Get category list with counts |

### Service

`PersonaTemplateService` follows the same pattern as `CustomSkillLoader`:
- Loads JSON from `resources/persona-templates/` (dev: `process.cwd()`, prod: `process.resourcesPath`)
- No new database tables — templates instantiate into existing AgentRole records
- Skills are referenced by ID, not embedded — missing skills produce warnings, not errors

---

## Plugin Pack Integration

Digital twins are deeply integrated with the [Plugin Pack](plugin-packs.md) system. Seven of the ten bundled packs link directly to a persona template, and packs can be installed, managed, and distributed through the Plugin Store.

### Plugin Store

The in-app **Plugin Store** (accessible via the "+" button in the Customize panel) provides:
- **Browse & install** packs from the remote registry that include linked digital twins
- **Install from Git** — clone a community pack that bundles a twin configuration
- **Create new packs** — scaffold a custom pack that links to any existing persona template

### Admin Policies

Organization admins can control twin-related packs via [Admin Policies](admin-policies.md):
- **Require** specific packs (e.g., ensure all engineers have the Engineering pack with its Software Engineer twin)
- **Block** packs that aren't approved for the organization
- **Limit agent resources** — cap heartbeat frequency and concurrent agents

See [Plugin Packs](plugin-packs.md) and [Admin Policies](admin-policies.md) for details.

---

## Further Reading

For detailed persona descriptions, day-in-the-life scenarios, and expanded coverage of other job areas (design, security, sales, HR, finance, legal, marketing, R&D, executive leadership, and more), see the [Digital Twin Personas Comprehensive Guide](digital-twin-personas-guide.md).

---

## Quick Reference

| Action | How |
|--------|-----|
| Open Digital Twin gallery | Mission Control > Add Digital Twin |
| Activate a template | Click template card > customize > Create Digital Twin |
| Check twin's proactive results | View completed tasks in Mission Control |
| Assign work to a twin | Drag task to twin's column, or @mention the twin |
| Edit twin after activation | Double-click the twin in Mission Control agents panel |
| Adjust proactive tasks | Edit agent > soul JSON > cognitiveOffload.proactiveTasks |
| Use a twin skill on-demand | @mention twin + skill prompt (e.g., "prepare meeting brief for X") |
