# Digital Twin Personas: Comprehensive Guide

Digital Twin Personas are role presets for CoWork agents. A twin gives you a strong starting point for persona, prompt, skills, and cognitive-offload focus, without automatically enrolling that role into the always-on runtime.

This guide covers what twins are for, how they relate to the new core automation model, the built-in persona families, and how to design custom templates that stay aligned with the hard split between:

- core runtime: `Workflow Intelligence` (`Memory + Heartbeat + Reflection + Suggestions`)
- product surfaces: Mission Control, Triggers, Devices, and Digital Twins

Use [Workflow Intelligence](workflow-intelligence.md), [Core Automation](core-automation.md), and [Heartbeat v3](heartbeat-v3.md) as the runtime source of truth.

---

## What A Twin Is

A Digital Twin is an opt-in role preset. It defines:

- role prompt and behavior boundaries
- personality and tone defaults
- recommended skills
- cognitive-offload categories
- display metadata for gallery/search/filtering

A Digital Twin does not define:

- heartbeat cadence
- dispatch budget
- workflow-intelligence target ownership
- memory distillation policy
- trigger ownership
- device ownership

If you want a twin-backed role to become always-on, activate the twin first, then attach a separate automation profile from Mission Control.

---

## Runtime Boundary

The split is intentional:

- Digital Twins own persona defaults
- Automation Profiles own always-on runtime participation
- Mission Control is the cockpit that connects and monitors the core

That means twin activation creates a role, not a running cognition participant.

### Default Behavior

After activation, a twin is reactive by default. You can:

- assign work directly
- mention it in chat or task flows
- use it as a company-aware operator role
- attach automation later if needed

### Optional Always-On Pairing

If a team wants a twin-backed role to participate in the core runtime, the intended sequence is:

1. Activate the persona template.
2. Review the created role prompt, skills, and company linkage.
3. Attach an automation profile separately.
4. Monitor Heartbeat, Workflow Intelligence, and Memory from Mission Control.

This keeps persona selection separate from cognition ownership.

---

## Cognitive Offload Model

Digital twins target categories of work that fragment attention:

| Category | What It Absorbs |
|----------|----------------|
| `context-switching` | Gathering context when moving between projects or discussions |
| `status-reporting` | Compiling progress updates, standup summaries, executive briefs |
| `information-triage` | Filtering, prioritizing, and routing incoming information |
| `decision-preparation` | Assembling data, options, and trade-offs for pending decisions |
| `documentation` | Keeping docs current, writing summaries, audit trails |
| `review-preparation` | Building review queues, risk assessments, review checklists |
| `dependency-tracking` | Monitoring dependencies, vulnerabilities, blockers |
| `compliance-checks` | Checking against standards, SLAs, and policies |
| `knowledge-curation` | Organizing and surfacing institutional knowledge |
| `routine-automation` | Repetitive checks and operational housekeeping |

Each template declares a small set of primary categories. Those categories shape the twin's persona and suggest the kinds of playbooks that role should handle well.

---

## What A Template Contains

Each persona template is a JSON blueprint with:

| Component | What It Defines |
|-----------|----------------|
| Role configuration | Capabilities, autonomy level, personality, system prompt |
| Cognitive offload categories | The kinds of mental load the role should absorb |
| Suggested playbooks | Example recurring routines for the role; descriptive only |
| Skill references | Recommended skills with reasons and required/optional flags |
| Metadata | Category, tags, seniority range, industry-agnostic flags |

Suggested playbooks are intentionally not runtime policy. They describe good default operating patterns, but they do not schedule automation or create background ownership by themselves.

---

## Built-In Persona Families

### Engineering

- Software Engineer
- Hardware Engineer
- System QA
- DevOps / SRE Engineer

Typical offload focus:

- review preparation
- dependency tracking
- documentation
- routine checks

Example playbooks:

- PR review preparation
- test coverage gap review
- dependency health review
- release-readiness brief

### Management

- Engineering Manager
- Technical Director
- VP of Engineering

Typical offload focus:

- status reporting
- decision preparation
- cross-team dependency visibility
- organizational context synthesis

Example playbooks:

- sprint health brief
- one-on-one preparation
- dependency risk scan
- executive summary draft

### Product

- Product Manager

Typical offload focus:

- information triage
- decision preparation
- documentation
- cross-functional context gathering

Example playbooks:

- feature-request clustering
- stakeholder brief prep
- roadmap tradeoff package
- customer feedback synthesis

### Data & Analytics

- Data Scientist / Analyst

Typical offload focus:

- decision preparation
- knowledge curation
- documentation
- context gathering

Example playbooks:

- dataset quality review
- experiment summary
- anomaly review
- KPI analysis digest

### Operations

- Technical Writer
- Founder Office Operator
- Company Planner
- Growth Operator
- Customer Ops Lead

Typical offload focus:

- status tracking
- operational triage
- routine reviews
- institutional memory

Example playbooks:

- doc freshness review
- founder brief preparation
- company-priority translation
- growth follow-up digest
- customer-commitment review

---

## Day-In-The-Life Examples

### Software Engineer

The twin helps with:

- preparing a review queue before a focused review session
- assembling context before touching an old subsystem
- summarizing test or dependency risk after recent changes

If paired with automation later, the same role can become an always-on operator. The always-on behavior still belongs to the attached automation profile, not the twin template itself.

### Engineering Manager

The twin helps with:

- preparing team status before standup
- pulling together one-on-one context
- highlighting blockers across teams

### Founder Office Operator

The twin helps with:

- cross-functional status preparation
- follow-up routing
- summarizing company priorities and stalled work

In a company setup, this role often gets paired with a separate automation profile, but the pairing is explicit rather than automatic.

---

## Organizational Scaling

At larger scale, the value comes from consistent role framing:

- every engineer twin prepares reviews in a similar structure
- every manager twin produces comparable status summaries
- every operator twin follows the same company-language and boundaries

This makes aggregation easier without forcing every role into background automation.

Twins can still benefit from shared memory and company context, but core memory distillation remains owned by the core runtime when an automation profile exists.

---

## Expanding To Other Job Areas

The persona-template system can extend to any role with recurring cognitive overhead.

Examples:

- Design: review preparation, accessibility checks, research synthesis
- Security: vulnerability triage, control review prep, threat-intel digestion
- Sales: pipeline review, account intelligence, forecast prep
- Customer Success: at-risk account review, knowledge-gap detection, renewal prep
- HR / People Ops: hiring-pipeline status, onboarding review, compliance reminders
- Finance: variance analysis, close preparation, policy review
- Legal: contract review prep, regulatory monitoring, audit evidence organization
- Marketing: campaign digests, content planning, SEO review
- Research: literature review, experiment logs, research progress briefs
- Executive Leadership: executive intelligence summaries, initiative tracking, board prep

In each case, the template should define the role well. Runtime cadence and always-on participation should still live elsewhere.

---

## Creating Custom Templates

To add a persona for any job function:

1. Create a JSON file following the `PersonaTemplate` schema.
2. Place it in `resources/persona-templates/`.
3. Restart CoWork OS.

### Template Shape

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
  "cognitiveOffload": {
    "primaryCategories": ["category-1", "category-2"],
    "examplePlaybooks": [
      {
        "id": "review-prep",
        "name": "Review Prep",
        "description": "Example recurring routine this role should handle well."
      }
    ]
  },
  "skills": [
    { "skillId": "skill-id", "reason": "Why this skill", "required": true }
  ],
  "tags": ["tag1", "tag2"],
  "seniorityRange": ["junior", "mid", "senior", "staff", "principal"],
  "industryAgnostic": true
}
```

### Design Principles

- Define what the role does and what it never does without approval.
- Keep the template focused on persona, not runtime policy.
- Use cognitive-offload categories to make the role legible.
- Keep suggested playbooks descriptive rather than prescriptive.
- Add automation separately if the role should become always-on.

---

## Channel Integration

Twins can still be reached from any supported surface:

| Channel | Example Usage |
|---------|--------------|
| Slack | `/inbox @twin-engineering-manager prepare 1-on-1 notes for tomorrow` |
| Microsoft Teams | `@twin-sw-engineer summarize auth module changes this week` |
| Discord | `!ask @twin-devops check deployment pipeline status` |
| Email | Forward a thread for context extraction and summarization |
| Telegram | Send the twin a task description |
| WhatsApp | Quick voice-to-text task assignment |
| iMessage | Personal device access to the twin |
| Signal | Secure channel for sensitive queries |

If a role is paired with automation, its downstream task results or notifications can also be delivered to these channels.

---

## FAQ

**Can I have multiple twins of the same type?**  
Yes. You might have a backend-focused and frontend-focused Software Engineer twin with different prompts and skills.

**Do twins talk to each other?**  
Not as a special twin-only feature. They share the same broader task, memory, and workspace context that standard roles can access.

**What happens if a recommended skill is missing?**  
Activation still succeeds. The role just cannot use that skill until it is installed.

**Can I change a twin after activation?**  
Yes. An activated twin is a standard `AgentRole`. Edit prompt, skills, personality, and role properties in the role editor. Edit always-on behavior separately through Mission Control automation surfaces.

**How much does a twin cost?**  
Activation alone is cheap because it creates a role preset. Ongoing cost comes from actual task execution and, if attached, from the separate core automation runtime.

**Can I use local models for twins?**  
Yes. A twin is still just a role-backed CoWork agent, so it can use the configured provider/model stack.

**Can twins be purely reactive?**  
Yes. That is now the default. A twin stays reactive unless you explicitly attach an automation profile.
