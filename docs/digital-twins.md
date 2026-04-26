# Digital Twin Personas

Digital Twin Personas are pre-built AI agent templates that create role-specific digital twins for team members. Each twin absorbs cognitively draining work — status reporting, PR triage, meeting prep, dependency tracking — so the human can stay in deep focus.

A persona template now bundles prompt/personality defaults, recommended skills, display metadata, and cognitive offload categories. Activating a template creates a fully configured role preset in one click, but it does not automatically enroll that role into the always-on core runtime.

Access from **Settings** > **Digital Twins** or **Mission Control** > **Add Digital Twin**. For company-ops workflows, you can also open Digital Twins from **Settings** > **Companies** to create operators in company context. Digital twins can also be activated through [Plugin Packs](plugin-packs.md) — 7 of the 10 bundled packs link directly to a persona template.

Digital Twins are intentionally separate from the core automation runtime. See [Workflow Intelligence](workflow-intelligence.md), [Core Automation](core-automation.md), and [Heartbeat v3](heartbeat-v3.md) for the architecture source of truth.

---

## Concepts

### Persona Template

A JSON blueprint defining a digital twin. Each template specifies:

| Field | Purpose |
|-------|---------|
| **Role config** | Capabilities, autonomy level, personality, system prompt |
| **Cognitive offload** | Which categories of mental work the twin absorbs |
| **Skills** | Recommended skill references with reasons |
| **Metadata** | Category, tags, seniority range, industry-agnostic flag |

### Relation To Core Automation

Digital Twins are not direct heartbeat or Workflow Intelligence owners.

That means:

- Twin activation does not automatically create an automation profile
- Twin templates do not own heartbeat cadence, cooldown, budget, or workflow-intelligence target state
- Mission Control can still show the role, but core automation is attached separately through automation profiles

If you want a twin-backed operator to become always-on, activate the template first, then attach a separate automation profile to that role.

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

### Optional Automation Pairing

When a team wants a twin to act as an always-on operator, the intended flow is:

1. activate the twin template
2. review the resulting role prompt, skills, and company linkage
3. attach an automation profile separately
4. monitor the role from Mission Control and the core harness

This keeps persona choice separate from cognition ownership.

---

## Available Templates

### Engineering

| Template | Autonomy | Key Offload Areas |
|----------|----------|-------------------|
| **Software Engineer** | Specialist | Review prep, dependency tracking, context switching, documentation |
| **Hardware Engineer** | Specialist | Documentation, compliance, dependency tracking, decision prep |
| **System QA** | Specialist | Review prep, compliance, automation, status reporting |
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
| **Founder Office Operator** | Lead | Cross-functional routing, operational triage, founder proxy work |
| **Company Planner** | Lead | Goal-to-issue translation, planning loops, stalled-work review |
| **Growth Operator** | Specialist | Funnel review, growth experiments, outbound and acquisition ops |
| **Customer Ops Lead** | Lead | Service quality, unresolved commitments, support and retention follow-up |

---

## Setup

### Activating a Template

1. Open **Settings** > **Digital Twins** or open **Mission Control** and click **Add Digital Twin**
3. Browse templates — filter by category or search by name/tags
4. Click a template card to open the activation dialog
5. Customize:
   - **Twin Name** — e.g., "Sarah's SW Twin" or "Backend Team Twin"
   - **Role prompt and identity**
   - **Recommended skills**
   - **Company context**, when relevant
6. Click **Create Digital Twin**

The twin appears as a new agent in Mission Control, ready to work as a role/persona preset. If you want it to participate in the core runtime, attach automation separately.

### Company-Aware Activation

When Digital Twins is opened from **Settings** > **Companies**, or when a company context is already selected:

- the panel shows a company context strip
- the template gallery defaults to venture/operator recommendations
- recommended templates such as `Company Planner` and `Founder Office Operator` are promoted first
- created twins get a persisted company assignment
- the resulting twin name can be prefixed with the company name for clarity

This turns Digital Twins into the company-operator activation surface instead of a generic template browser.

### Activating Venture Operators

For founder-directed autonomous company setups, the recommended starter set is:

- `Company Planner`
- `Founder Office Operator`

Expanded operating team:

- `Growth Operator`
- `Customer Ops Lead`

These templates are intended to pair with the `Venture operator kit` workspace preset and the Mission Control strategic planner.

### What Activation Creates

- A new **AgentRole** record with the template's capabilities, personality, and system prompt
- Optional persisted **company assignment** when activation happens in company context
- **Cognitive offload config** embedded in the agent's soul JSON
- Warnings if any recommended skills are not installed (non-blocking — the twin works without them)

What activation does **not** create:

- an automation profile
- heartbeat ownership
- workflow-intelligence target ownership
- memory distillation policy

---

## Daily Operation

Once activated, a twin mainly operates as a role/persona surface plus an on-demand execution target. Always-on operator behavior is added only if you attach automation separately.

### Optional Always-On Mode

If a twin-backed role also has an automation profile, it can participate in:

- Heartbeat v3 review
- Workflow Intelligence reflection and suggestions
- core traces and learnings
- Mission Control core-harness monitoring

When a twin is linked to a company, the product can also surface it as part of that company's operator set in:

- `Settings > Companies`
- `Settings > Digital Twins`
- `Mission Control`

Example Software Engineer routines once a separate automation profile is attached:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| PR Review Queue | Every 60 min | Scans open PRs, builds prioritized review queue with risk ratings, flags stale PRs |
| Test Coverage Scan | Every 4 hours | Checks recent code changes for files lacking test coverage |
| Dependency Health | Every 8 hours | Runs dependency check for vulnerabilities and outdated packages |

Example Engineering Manager routines once a separate automation profile is attached:

| Task | Frequency | What It Does |
|------|-----------|-------------|
| Team Status Digest | Every 2 hours | Aggregates team member activity into a status summary |
| Sprint Health Check | Every 4 hours | Monitors sprint progress, flags at-risk items, surfaces blockers |
| Cross-Team Dependency Scan | Every 8 hours | Tracks dependencies between teams, flags blockers early |

Example VP of Engineering routines once a separate automation profile is attached:

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

Since CoWork OS supports 17 messaging channels, twins can be reached from anywhere:

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
- **Role prompt and identity**
- **Recommended skills**
- **Company linkage**, when relevant
- All other role properties (capabilities, autonomy, personality) come from the template defaults

### After Activation

The twin is a standard AgentRole — all properties can be edited via the Agent Role Editor in Mission Control:

- Change capabilities, autonomy level, or personality
- Edit the system prompt or soul configuration
- Modify skills and role-specific soul metadata
- Attach automation separately in Mission Control if the role should become always-on

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
    ↓ optional attach
AutomationProfile (SQLite)
    ↓
Workflow Intelligence
    ↓
Mission Control + Task system + Run records
```

### Where Data Lives

| Data | Location |
|------|----------|
| Template definitions | `resources/persona-templates/*.json` |
| Bundled skills | `resources/skills/twin-*.json` |
| Activated twin config | `agent_roles` table (SQLite) |
| Optional automation linkage | `automation_profiles` and core runtime tables |
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
- No new twin-specific database tables — templates instantiate into existing AgentRole records
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
- **Limit agent resources** — cap automation profile usage and concurrent agents

See [Plugin Packs](plugin-packs.md) and [Admin Policies](admin-policies.md) for details.

---

## Further Reading

For detailed persona descriptions, day-in-the-life scenarios, and expanded coverage of other job areas (design, security, sales, HR, finance, legal, marketing, R&D, executive leadership, and more), see the [Digital Twin Personas Comprehensive Guide](digital-twin-personas-guide.md).

For the full founder-operated autonomous-company workflow, see [Zero-Human Company Operations](zero-human-company.md).

---

## Quick Reference

| Action | How |
|--------|-----|
| Open Digital Twin gallery | Settings > Digital Twins or Mission Control > Add Digital Twin |
| Open company-aware twin creation | Settings > Companies > Open Digital Twins |
| Activate a template | Click template card > customize > Create Digital Twin |
| Create company-linked operator | Open Digital Twins from a company context, then activate a venture/operator template |
| Check twin task output | View completed tasks in Mission Control |
| Assign work to a twin | Drag task to twin's column, or @mention the twin |
| Edit twin after activation | Double-click the twin in Mission Control agents panel |
| Make the twin always-on | Attach a separate automation profile after activation |
| Adjust twin role metadata | Edit agent > soul JSON and role settings |
| Review heartbeat behavior | Open [Heartbeat v3](heartbeat-v3.md) |
| Use a twin skill on-demand | @mention twin + skill prompt (e.g., "prepare meeting brief for X") |
