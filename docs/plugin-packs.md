# Plugin Packs & Customize

Plugin packs are composable, role-specific bundles that group skills, agent roles, connectors, and slash commands into a single installable unit. Each pack targets a job function — engineering, sales, product management — and can optionally link to a [Digital Twin Persona](digital-twins.md) for proactive background work.

Access from **Settings** > **Customize**.

---

## Concepts

### Plugin Pack

A JSON manifest (`cowork.plugin.json`) that bundles related capabilities:

| Field | Purpose |
|-------|---------|
| **Skills** | Prompt templates with parameter substitution for specific workflows |
| **Agent Roles** | Pre-configured agent identities with system prompts and capabilities |
| **Slash Commands** | Shortcut mappings that trigger skills via `/command` syntax |
| **Connectors** | Declarative tool definitions (HTTP, shell, script) for external services |
| **Try Asking** | Natural language prompt suggestions for discoverability |
| **Digital Twin Link** | Optional `personaTemplateId` connecting the pack to a proactive persona |

### Pack Scopes

| Scope | Source | Managed By |
|-------|--------|------------|
| **Bundled** | Ships with CoWork OS in `resources/plugin-packs/` | CoWork OS team |
| **Personal** | User-created in `~/.cowork/extensions/` | Individual user |
| **Organization** | Distributed by org admins | Organization admin |

### How Packs Differ from Individual Skills

Individual skills are standalone prompt templates. A pack is a **curated collection** that provides:

- Multiple related skills that work together
- A dedicated agent role with a tailored system prompt
- Recommended external connectors (MCP servers)
- Discoverable prompt suggestions via "Try asking"
- Optional digital twin integration for proactive automation

---

## The Customize Panel

The Customize panel is the unified entry point for browsing, enabling, and configuring plugin packs.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Customize                                                     │
├──────────────────┬───────────────────────────────────────────┤
│ [🔍 Search...]   │                                           │
│                  │  Pack Name              [Toggle ON/OFF]  │
│  ⚡ Connectors   │  Description text                        │
│  ⚡ Skills       │  🧬 Includes Digital Twin                 │
│                  │  🔗 Recommended: hubspot-mcp              │
│  ──────────────  │  🟠 Update available: v1.1.0              │
│  PACKS           │                                           │
│                  │  [Commands] [Skills] [Agents]             │
│  📊 Data Analy.. │                                           │
│  ⚙️ DevOps Pack  │  ┌──────────────┐ ┌──────────────┐       │
│  👨‍💻 Engineering  │  │ /skill-name  │ │ /skill-name  │       │
│  👥 Engineering..│  │ Description  │ │ Description  │       │
│  🎯 Product Ma.. │  └──────────────┘ └──────────────┘       │
│  🧪 QA & Testing │                                           │
│  💼 Sales CRM 🟠 │  Try asking ..                            │
│  ✍️ Technical W.. │  ┌──────────────────────────────── → ┐   │
│                  │  │ Natural language prompt example  │   │
│                  │  └──────────────────────────────────┘   │
└──────────────────┴───────────────────────────────────────────┘
```

### Search & Filter

The search bar at the top of the sidebar filters packs in real time. It matches against pack name, display name, description, category, and skill names — so typing "deploy" surfaces the DevOps pack even if the word only appears in a skill description. Clear the search field to show all packs again.

### Sidebar

The left sidebar contains:

1. **Search bar** — Real-time filtering across all pack metadata
2. **Connectors** — Quick link to MCP connector settings
3. **Skills** — Quick link to the Skill Hub
4. **Packs** — All discovered plugin packs, grouped by scope (Personal, Organization, Bundled)

Packs with available updates show an orange dot indicator next to their name.

Click any pack to view its details in the right panel.

### Detail Panel

When a pack is selected, the right panel shows:

**Header**
- Pack name and description
- Toggle switch to enable/disable the pack (state persists across restarts)
- Digital Twin badge (if the pack links to a persona template)
- Recommended connectors chips (clickable — navigates to connector settings)
- Update available badge (shown when a newer version exists in the registry)

**Tabs**

| Tab | Content |
|-----|---------|
| **Commands** | Card grid of slash commands derived from skills. Each card shows the `/command-name` and description. |
| **Skills** | List of all skills in the pack with icon, name, description, and **per-skill toggle switch**. Individual skills can be enabled or disabled independently without toggling the entire pack. |
| **Agents** | Agent roles defined by the pack, plus a Digital Twin entry if `personaTemplateId` is set. |

**Try Asking**

A list of clickable natural language prompts. Clicking a prompt sends it to the chat as a new task — no need to figure out the exact command.

### "Try Asking" in Chat Empty State

When the chat input is empty (no active task), the main screen displays a selection of "Try asking" prompts drawn from all enabled plugin packs. Up to 5 prompts are randomly sampled from across your active packs, giving you one-click access to common workflows. Each chip shows which pack it came from on hover.

Clicking a prompt pre-fills the chat input and starts the task immediately.

### Context Panel

The Context Panel is a collapsible sidebar that shows what capabilities are currently active in your session:

- **Connectors** — Connected MCP servers with status indicators
- **Skills** — Enabled skills from active packs

It auto-refreshes every 30 seconds and provides at-a-glance awareness of your active tooling.

---

## Bundled Plugin Packs

CoWork OS ships with 17 plugin packs covering common job functions.

### Engineering

| | |
|---|---|
| **Icon** | 👨‍💻 |
| **Category** | Engineering |
| **Digital Twin** | Software Engineer |
| **Agent Role** | Engineering Assistant |

**Skills:**
- **Code Review Prep** — Structured review summaries with risk assessment, missing tests, and approval recommendations
- **Dependency Audit** — Scan for CVEs, outdated versions, deprecated packages, and license issues
- **Test Gap Analysis** — Identify functions without coverage, untested edge cases, and missing integration tests
- **Standup Update** — Generate Done/In Progress/Blocked/Next from recent git activity

**Try Asking:**
- "Triage open PRs and build a prioritized review queue"
- "Check for outdated or vulnerable dependencies"
- "Which files changed this week but have no test coverage?"
- "Summarize the auth module changes for my review"
- "Scan for TODO/FIXME comments added this sprint"

---

### Engineering Management

| | |
|---|---|
| **Icon** | 👥 |
| **Category** | Management |
| **Digital Twin** | Engineering Manager |
| **Agent Role** | EM Assistant |

**Skills:**
- **Sprint Health Review** — Progress percentage, at-risk items (stalled 3+ days, blocked, failing CI), workload balance, predicted outcome
- **1-on-1 Prep** — Recent accomplishments, current work, potential concerns, suggested discussion topics, career development points
- **Team Status Report** — Executive summary, achievements, in-progress timelines, blockers, team health, next priorities

**Try Asking:**
- "Prepare 1-on-1 notes for each of my direct reports"
- "How's our sprint looking — are we on track?"
- "What cross-team dependencies are blocking us?"
- "Generate a sprint retrospective summary"
- "Which team members might need support this week?"

---

### Product Management

| | |
|---|---|
| **Icon** | 🎯 |
| **Category** | Product |
| **Digital Twin** | Product Manager |
| **Agent Role** | PM Assistant |

**Skills:**
- **Feature Request Triage** — Categorize by product area, score user impact and effort, detect duplicates, group by theme, flag conflicts with roadmap
- **User Story Generator** — As a [user] I want [goal] so that [benefit] format, Given/When/Then acceptance criteria, edge cases, dependencies, story points
- **Roadmap Update** — What shipped, what's in progress, what changed, key risks, decisions needed from stakeholders

**Try Asking:**
- "Triage these feature requests and group by theme"
- "Are we on track for our sprint goals?"
- "Prepare a decision package: should we build X or Y first?"
- "Synthesize this week's customer feedback into themes"
- "Draft user stories for the new onboarding flow"

---

### DevOps

| | |
|---|---|
| **Icon** | ⚙️ |
| **Category** | Engineering |
| **Digital Twin** | DevOps/SRE Engineer |
| **Agent Role** | DevOps Engineer |

**Skills:**
- **Incident Response** — Classification, triage steps, internal/external communication templates, escalation path, root cause checklist, mitigation options, post-mortem outline
- **Deployment Checklist** — Pre-deployment (code review, tests, migrations, configs), deployment steps, post-deployment (health checks, smoke tests, monitoring), rollback procedure
- **Monitoring Setup** — Key metrics (latency, throughput, errors, saturation), alert thresholds, dashboard layout, log aggregation, health checks, SLO/SLA targets
- **Post-mortem Report** — Blameless format: timeline, impact, 5 Whys root cause, contributing factors, what went well, action items with owners
- **Terraform Plan Review** — Review `terraform plan` output, flag resource changes, detect drift, assess blast radius, and recommend approval or rejection
- **Kubernetes Manifest Generation** — Generate and review Kubernetes manifests (Deployments, Services, Ingress, ConfigMaps, Secrets, HPA) with best practices
- **Cloud Migration Assessment** — Assess workloads using the 6 Rs framework (Rehost, Replatform, Refactor, Repurchase, Retain, Retire) with cost estimation
- **Docker Compose File Generation** — Generate and review Docker Compose files with service definitions, networking, volumes, health checks, and multi-stage builds

**Try Asking:**
- "Create an incident response plan for this production issue"
- "Generate a deployment checklist for the release"
- "Design monitoring and alerting for the payment service"
- "Write a blameless post-mortem for yesterday's outage"
- "What's our SLA compliance looking like this month?"
- "Review this Terraform plan and flag any risky changes"
- "Generate Kubernetes manifests for a Node.js API with Redis"
- "Assess these workloads for cloud migration readiness"
- "Create a Docker Compose setup for a full-stack app"

---

### Mobile Development

| | |
|---|---|
| **Icon** | 📱 |
| **Category** | Engineering |
| **Agent Role** | Mobile Developer |

**Skills:**
- **React Native Setup** — Project scaffolding, navigation (React Navigation), state management, native module integration, Expo vs bare workflow guidance
- **iOS Development** — SwiftUI and UIKit patterns, @Observable, SwiftData/Core Data, async/await, push notifications (APNs), `xcodebuild` commands, `xcrun simctl` simulator management, code signing, App Store submission
- **Android Development** — Jetpack Compose, ViewModel, Room, Retrofit, Hilt/Dagger, Coroutines/Flow, Gradle builds, ADB/emulator commands, ProGuard/R8, Play Store submission
- **Build Pipeline** — Fastlane setup, code signing automation, CI/CD for mobile, TestFlight/Play Store deployment, beta distribution

**Try Asking:**
- "Set up a new React Native project with navigation and state management"
- "Build and deploy this iOS app to TestFlight"
- "Create a Jetpack Compose screen with a ViewModel and Room database"
- "Set up Fastlane for automated iOS and Android builds"
- "Debug why my app crashes on launch with this stack trace"

---

### Game Development

| | |
|---|---|
| **Icon** | 🎮 |
| **Category** | Engineering |
| **Agent Role** | Game Developer |

**Skills:**
- **Unity Development** — C# scripting, MonoBehaviour lifecycle, ScriptableObjects, Addressables, URP/HDRP Shader Graph, physics, UI Toolkit, editor scripting, Unity CLI batch builds and testing
- **Unreal Engine Development** — C++/Blueprints, Gameplay Framework, Enhanced Input, UCLASS/UPROPERTY/UFUNCTION macros, Niagara particles, Lumen/Nanite, multiplayer replication, UnrealBuildTool packaging
- **Godot Development** — GDScript patterns, node tree architecture, signals, Godot 4 rendering, export presets, physics, UI controls, and GDNative/C++ extensions
- **Cross-Engine Performance** — Draw call batching, LOD configuration, occlusion culling, texture optimization, object pooling, memory budgets, GPU profiling, and platform-specific tuning (mobile/PC/console)

**Try Asking:**
- "Create a Unity player controller with camera follow and input handling"
- "Set up an Unreal Engine character with Enhanced Input and C++"
- "Optimize this scene — draw calls are too high and FPS is dropping"
- "Write a GDScript state machine for enemy AI"
- "Profile GPU performance and reduce frame time on mobile"

---

### Data Analysis

| | |
|---|---|
| **Icon** | 📊 |
| **Category** | Data |
| **Digital Twin** | Data Scientist |
| **Agent Role** | Data Analyst |

**Skills:**
- **CSV Analysis** — Summary statistics, missing data, correlations, outlier detection, patterns, visualization recommendations
- **Report Generator** — Executive summaries with key metrics, insights, trend analysis, recommendations, suggested charts
- **SQL Query Builder** — Natural language to SQL, with table references, joins, aggregations, and optimization notes

**Try Asking:**
- "Analyze this CSV and give me the key insights"
- "Build a SQL query to find our top customers by revenue"
- "What patterns do you see in this dataset?"
- "Generate a monthly metrics report from this data"
- "Help me design a dashboard for tracking KPIs"

---

### QA & Testing

| | |
|---|---|
| **Icon** | 🧪 |
| **Category** | Engineering |
| **Digital Twin** | QA/Test Engineer |
| **Agent Role** | QA Assistant |

**Skills:**
- **Test Plan Generator** — Scope, test types, entry/exit criteria, environment requirements, risk areas, coverage mapping
- **Bug Report** — Reproduction steps, expected vs. actual, severity assessment, environment details, logs, suggested root cause
- **Release Readiness Checklist** — Test execution summary, open defects, regression results, performance benchmarks, Go/No-Go recommendation

**Try Asking:**
- "Create a test plan for the new checkout flow"
- "What's our current test coverage and where are the gaps?"
- "Write a bug report for this issue I found"
- "Are we ready to release — generate a readiness assessment"
- "What regression risks exist for this feature change?"

---

### Sales CRM

| | |
|---|---|
| **Icon** | 💼 |
| **Category** | Sales |
| **Recommended Connector** | HubSpot MCP |
| **Agent Role** | Sales Specialist |

**Skills:**
- **Prospect Research** — Company overview, key decision makers, pain points, talking points, recent news
- **Follow-up Email** — Personalized follow-ups referencing meeting context, with multiple tone options
- **Pipeline Review** — Deal stage analysis, at-risk flags, win probability, recommended actions
- **Objection Handler** — Counter-arguments for common pricing, timing, and competitor objections

**Try Asking:**
- "Research this prospect and compile a briefing for outreach"
- "Draft a follow-up email after yesterday's demo call"
- "Review my pipeline and flag deals at risk this quarter"
- "Prepare responses to common pricing objections"
- "Summarize this week's closed-won and closed-lost deals"

---

### Customer Support

| | |
|---|---|
| **Icon** | 🎧 |
| **Category** | Operations |
| **Recommended Connector** | Zendesk MCP |
| **Agent Role** | Support Specialist |

**Skills:**
- **Ticket Triage** — Categorize by type, assess urgency, route to appropriate team, extract key details
- **Response Draft** — Empathetic, clear customer responses with solution steps and next actions
- **Escalation Summary** — Structured escalation with timeline, attempts made, customer sentiment, and impact
- **KB Article Draft** — Create knowledge base articles from resolved support cases

**Try Asking:**
- "Triage this support ticket and suggest a response"
- "Draft a response to this frustrated customer"
- "Create an escalation summary for the engineering team"
- "Turn this resolved ticket into a help center article"
- "What are the top recurring issues this week?"

---

### Content & Marketing

| | |
|---|---|
| **Icon** | 📣 |
| **Category** | Marketing |
| **Agent Role** | Marketing Specialist |

**Skills:**
- **Blog Post Draft** — SEO-optimized posts with headline options, meta description, structured sections, internal links, CTA
- **Social Media Posts** — Multi-platform content (Twitter, LinkedIn, Instagram) with hashtags and engagement hooks
- **Campaign Plan** — Campaign strategy with goals, channels, timeline, budget allocation, KPIs, A/B test ideas

**Try Asking:**
- "Draft a blog post about our new product launch"
- "Create social media posts for this announcement"
- "Build a campaign plan for Q3 product awareness"
- "Write email copy for our upcoming webinar"
- "Suggest content topics based on our product updates"

---

### Technical Writing

| | |
|---|---|
| **Icon** | ✍️ |
| **Category** | Operations |
| **Digital Twin** | Technical Writer |
| **Agent Role** | Technical Writer Assistant |

**Skills:**
- **Documentation Audit** — Scan for stale docs, broken links, accuracy vs. current code, missing sections, style consistency
- **Changelog Generator** — Categorize changes (added, changed, fixed, deprecated, removed), write user-friendly summaries from commit history
- **API Reference Writer** — Generate endpoint docs from code: method, path, parameters, request/response examples, error codes, authentication

**Try Asking:**
- "Which docs are stale after this week's code changes?"
- "Draft a changelog from this sprint's PRs"
- "Generate API reference documentation for the user service"
- "Review our docs for consistency and completeness"
- "Write a getting started guide for new developers"

---

### Equity Research

| | |
|---|---|
| **Icon** | 📈 |
| **Category** | Finance |
| **Agent Role** | Equity Research Analyst |

**Skills:**
- **Earnings Analysis** — Parse earnings results, analyze beat/miss vs consensus, assess forward guidance quality
- **Sector Analysis** — In-depth research on market dynamics, competitive landscape, regulatory environment, technology trends
- **Coverage Initiation** — Draft initiation of coverage notes with investment thesis, financial analysis, and rating
- **Price Target** — Build price targets using DCF, multiples, and scenario analysis with sensitivity testing
- **Catalyst Tracking** — Identify and analyze upcoming catalysts (earnings, product launches, M&A, regulatory events)

**Try Asking:**
- "Analyze Tesla's latest earnings vs consensus expectations"
- "Write a semiconductor industry deep dive focusing on AI chip demand"
- "Draft CrowdStrike coverage initiation with buy thesis"
- "Build blended price target for Shopify using DCF and EV/EBITDA"
- "Identify 12-month catalysts for Nvidia"

---

### Financial Analysis

| | |
|---|---|
| **Icon** | 📊 |
| **Category** | Finance |
| **Agent Role** | Financial Analyst |

**Skills:**
- **DCF Modeling** — Build discounted cash flow models with WACC calculation, terminal value, sensitivity analysis
- **Ratio Analysis** — Comprehensive liquidity, profitability, leverage, and efficiency metrics with industry benchmarking
- **Financial Statement Analysis** — Deep income statement, balance sheet, and cash flow analysis with trend identification
- **Peer Benchmarking** — Compare company vs peers and industry on key financial and operational metrics
- **Valuation Summary** — Multi-method valuation combining DCF, comparables, and precedent transactions

**Try Asking:**
- "Build DCF model for Apple with 10-year projection and sensitivity analysis"
- "Analyze Tesla's liquidity and profitability ratios"
- "Compare Microsoft's financials over 5 years and flag trends"
- "Benchmark Nvidia against AMD and Intel"
- "Provide blended valuation for Alphabet using DCF, comparables, and precedent transactions"

---

### Investment Banking

| | |
|---|---|
| **Icon** | 🏦 |
| **Category** | Finance |
| **Agent Role** | Investment Banker |

**Skills:**
- **Deal Screening** — Screen and identify M&A targets, IPO candidates based on strategic and financial criteria
- **Pitch Book** — Prepare structured pitch book content with situation overview, strategic alternatives, valuation, process
- **M&A Analysis** — Synergy analysis, accretion/dilution modeling, deal structure evaluation
- **Due Diligence** — Comprehensive due diligence checklist and findings analysis (Financial, Legal, Commercial, Technical)
- **Comps Analysis** — Trading comparable companies and precedent transaction analysis for valuation

**Try Asking:**
- "Screen potential M&A targets in healthcare SaaS under $500M EV"
- "Prepare pitch book for mid-market tech company sale process"
- "Analyze accretion/dilution of Company A acquiring Company B at 30% premium"
- "Build due diligence checklist for fintech acquisition"
- "Run trading comps and precedent transactions for cybersecurity company"

---

### Private Equity

| | |
|---|---|
| **Icon** | 🏢 |
| **Category** | Finance |
| **Agent Role** | PE Associate |

**Skills:**
- **Deal Sourcing** — Source and screen PE investment targets based on financial, strategic, operational criteria
- **LBO Modeling** — Build leveraged buyout models with debt structuring, sources/uses, returns analysis, sensitivity
- **Portfolio Monitoring** — Track portfolio company performance against business plan with KPI dashboards
- **Exit Analysis** — Analyze exit options (IPO, strategic sale, secondary buyout, dividend recap) and compare returns
- **Fund Reporting** — Prepare fund-level LP reports with performance metrics, capital accounts, portfolio summaries

**Try Asking:**
- "Screen mid-market healthcare services companies suitable for platform acquisition"
- "Build LBO model for $200M acquisition with 5x leverage and 20% equity"
- "Generate quarterly performance dashboard for logistics portfolio company"
- "Analyze exit options for SaaS company held 4 years with 3x revenue growth"
- "Prepare quarterly LP update with IRR and MOIC calculations"

---

### Wealth Management

| | |
|---|---|
| **Icon** | 💎 |
| **Category** | Finance |
| **Agent Role** | Wealth Advisor |

**Skills:**
- **Portfolio Construction** — Build diversified portfolios using modern portfolio theory, factor analysis, constraint optimization
- **Asset Allocation** — Strategic and tactical asset allocation recommendations based on macro outlook and client profile
- **Client Reporting** — Generate client-facing performance reports with attribution, commentary, and forward outlook
- **Risk Assessment** — Comprehensive portfolio risk analysis (VaR, drawdown, stress testing, factor decomposition)
- **Tax Optimization** — Tax-loss harvesting identification, asset location optimization, tax-aware strategies

**Try Asking:**
- "Construct balanced portfolio for moderate-risk client with $2M investable assets"
- "Recommend tactical asset allocation shift given current macro environment"
- "Prepare quarterly performance review for Henderson family account"
- "Run comprehensive risk analysis including VaR and drawdown metrics"
- "Identify tax-loss harvesting opportunities across equity positions"

---

## Digital Twin Integration

Seven of the seventeen bundled packs link to [Digital Twin Personas](digital-twins.md):

| Pack | Persona Template | Proactive Tasks |
|------|-----------------|-----------------|
| Engineering | Software Engineer | PR triage, dependency checks, test coverage scans |
| Engineering Management | Engineering Manager | Sprint health reports, standup summaries, blocker detection |
| Product Management | Product Manager | Feature request triage, roadmap updates, stakeholder briefs |
| DevOps | DevOps/SRE Engineer | Uptime monitoring, deployment verifications, incident summaries |
| Data Analysis | Data Scientist | Pipeline health checks, data quality scans, anomaly detection |
| QA & Testing | QA/Test Engineer | Test coverage reports, regression risk assessments, flaky test detection |
| Technical Writing | Technical Writer | Doc freshness scans, style consistency checks, link verification |

When a pack with a digital twin is active, the twin runs heartbeat-driven background tasks on a schedule — surfacing insights, flagging issues, and preparing reports without being asked.

### Activation Flow

1. Enable the pack in the Customize panel
2. The Digital Twin badge appears in the pack detail header
3. Go to **Mission Control** > **Add Digital Twin**
4. Select the linked persona template
5. The twin starts running proactive tasks on the configured schedule

---

## Architecture

### Pack Discovery & Loading

```
App Startup
    │
    ▼
PluginRegistry.initialize()
    │
    ├── Scan: resources/plugin-packs/     (bundled packs)
    ├── Scan: ~/.cowork/extensions/        (personal packs)
    └── Scan: {org-dir}/                   (organization packs)
    │
    ▼
For each cowork.plugin.json found:
    │
    ├── Validate manifest (required fields, semver, platform)
    ├── Register skills → Custom Skill Loader
    ├── Register agent roles → Agent Role Repository
    ├── Register connectors → Tools Map
    └── Set plugin.state = "registered"
```

### Data Flow

```
┌──────────────┐     IPC invoke      ┌──────────────────┐
│  Renderer     │ ──────────────────► │  Main Process     │
│  (Customize   │                     │  (plugin-pack-    │
│   Panel)      │ ◄────────────────── │   handlers.ts)    │
└──────────────┘     IPC response     └──────────────────┘
                                              │
                                              ▼
                                      ┌──────────────────┐
                                      │  PluginRegistry   │
                                      │  (singleton)      │
                                      │                   │
                                      │  plugins: Map     │
                                      │  tools: Map       │
                                      │  configs: Map     │
                                      └──────────────────┘
```

### State Persistence

Pack and skill toggle states are persisted in `pack-states.json` in the user data directory (`~/Library/Application Support/cowork-os/`). The file uses the following format:

```json
{
  "packs": {
    "engineering": true,
    "sales-crm": false,
    "devops": true
  },
  "skills": {
    "engineering": {
      "code-review-prep": true,
      "dependency-audit": false
    }
  }
}
```

- **Pack states**: `true` = enabled, `false` = disabled. Packs not listed default to enabled.
- **Skill states**: Nested by pack name, then skill ID. Skills not listed default to the pack's `enabled` value.
- States are loaded on app startup and applied during plugin registration.
- Deleting `pack-states.json` resets all toggles to their manifest defaults.

### Skill Conflict Detection

When multiple packs register a skill with the same ID, the registry logs a warning:

```
[PluginRegistry] Skill ID "code-review" already registered by plugin "engineering",
now being registered by "qa-testing". The later registration will take precedence.
```

This helps pack authors avoid accidental ID collisions. The later-registered skill wins, but both packs continue to load normally.

### Update Detection

The Customize panel checks for pack updates in the background on mount. It compares installed pack versions against the remote registry catalog using semver comparison. Packs with newer versions available show:
- An **orange dot** on the sidebar item
- An **"Update available: vX.Y.Z"** badge in the detail panel header

Update checks are non-blocking and fail silently if the registry is unavailable.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `pluginPack:list` | Renderer → Main | List all plugin packs with metadata |
| `pluginPack:get` | Renderer → Main | Get single pack details |
| `pluginPack:toggle` | Renderer → Main | Enable or disable a pack (persisted) |
| `pluginPack:toggleSkill` | Renderer → Main | Enable or disable a specific skill within a pack (persisted) |
| `pluginPack:getContext` | Renderer → Main | Get active connectors and skills |
| `pluginPack:checkUpdates` | Renderer → Main | Check for pack updates against remote registry |
| `pluginPack:scaffold` | Renderer → Main | Create a new pack from a template |
| `pluginPack:installGit` | Renderer → Main | Install a pack from a Git repository |
| `pluginPack:installUrl` | Renderer → Main | Install a pack from a manifest URL |
| `pluginPack:uninstall` | Renderer → Main | Uninstall a user-installed pack |
| `pluginPack:registrySearch` | Renderer → Main | Search the remote pack registry |
| `pluginPack:registryDetails` | Renderer → Main | Get pack details from remote registry |
| `pluginPack:registryCategories` | Renderer → Main | Get available categories from registry |
| `admin:policiesGet` | Renderer → Main | Get current admin policies |
| `admin:policiesUpdate` | Renderer → Main | Update admin policies |
| `admin:checkPack` | Renderer → Main | Check if a pack is allowed/required |

### Preload API

```typescript
// Core pack operations
window.electronAPI.listPluginPacks()
// Returns: PluginPackData[] — all packs with skills, agents, commands, policy flags

window.electronAPI.getPluginPack(name)
// Returns: PluginPackData | null — single pack detail

window.electronAPI.togglePluginPack(name, enabled)
// Returns: { success, name, enabled } — toggle result (blocked by policy if pack is blocked/required)
// State is persisted in pack-states.json and survives restarts

window.electronAPI.togglePluginPackSkill(packName, skillId, enabled)
// Returns: { success, packName, skillId, enabled } — per-skill toggle result
// State is persisted alongside pack states

window.electronAPI.getActiveContext()
// Returns: { connectors: [], skills: [] } — active capabilities

window.electronAPI.checkPackUpdates()
// Returns: Array<{ name, currentVersion, latestVersion }> — packs with available updates

// Pack distribution
window.electronAPI.scaffoldPluginPack(options)
// Creates a new pack skeleton in ~/.cowork/extensions/

window.electronAPI.installPluginPackFromGit(gitUrl)
// Clones and installs a pack from a Git repository

window.electronAPI.installPluginPackFromUrl(url)
// Downloads and installs a pack manifest from a URL

window.electronAPI.uninstallPluginPack(packName)
// Removes a user-installed pack from ~/.cowork/extensions/

// Remote registry
window.electronAPI.searchPackRegistry(query, options?)
// Searches the remote pack catalog

window.electronAPI.getPackRegistryDetails(packId)
// Gets full details for a pack from the registry

window.electronAPI.getPackRegistryCategories()
// Returns available categories from the registry

// Admin policies
window.electronAPI.getAdminPolicies()
// Returns the current admin policy configuration

window.electronAPI.updateAdminPolicies(updates)
// Updates admin policies (partial merge)

window.electronAPI.checkPackPolicy(packId)
// Returns { allowed, required } for a specific pack
```

---

## Plugin Store

The Plugin Store is an in-app modal for discovering, installing, and creating plugin packs.

### Accessing the Store

Click the **"+"** button in the Customize panel sidebar header to open the Plugin Store.

### Features

**Browse Registry**
- Search packs by name or description with debounced filtering
- Filter by category using clickable chips
- Paginated results grid with pack cards showing icon, name, description, and category
- Click "Install" to install from the remote registry (via git URL or manifest download)

**Install from URL/Git**
- Enter any Git URL (`github:owner/repo`, `https://github.com/...`, `git@github.com:...`)
- Or enter a direct URL to a `cowork.plugin.json` manifest
- Progress feedback during installation

**Create New Pack**
- Fill in pack name, display name, category, and icon
- Scaffolds a new pack directory in `~/.cowork/extensions/`
- Includes example skill and agent role to get started
- Opens in the Customize panel immediately after creation

### How Installation Works

**From Git:**
1. Shallow clone the repository to a temp directory
2. Validate the `cowork.plugin.json` manifest
3. Remove the `.git` directory
4. Move to `~/.cowork/extensions/{pack-name}/`
5. Trigger plugin discovery to register the new pack

**From URL:**
1. Fetch the manifest JSON from the URL
2. Validate required fields and structure
3. Write to `~/.cowork/extensions/{pack-name}/cowork.plugin.json`
4. Trigger plugin discovery to register the new pack

**From Scaffold:**
1. Validate pack name (kebab-case, max 64 chars, no path traversal)
2. Create directory in `~/.cowork/extensions/`
3. Generate `cowork.plugin.json` with all fields populated
4. Optionally include example skill and agent role
5. Trigger plugin discovery to register the new pack

### Uninstallation

Only user-installed packs (in `~/.cowork/extensions/`) can be uninstalled. Bundled packs and organization packs cannot be removed.

To uninstall: right-click a personal pack in the sidebar or use the API:
```typescript
window.electronAPI.uninstallPluginPack("my-custom-pack")
```

---

## Remote Pack Registry

The remote pack registry enables discovering and installing community-contributed packs.

### How It Works

The registry follows the same architecture as the Skill Registry:

1. **Static catalog mode**: Fetches a `pack-catalog.json` file from a GitHub-hosted registry
2. **REST API fallback**: For non-GitHub registries, queries standard REST endpoints
3. **5-minute cache TTL**: Catalog responses are cached locally to reduce network requests

### Default Registry URL

```
https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/registry
```

Override with the `PLUGIN_PACK_REGISTRY` environment variable.

### Catalog Format

```json
{
  "version": 1,
  "updatedAt": "2025-01-15T00:00:00Z",
  "packs": [
    {
      "id": "my-pack",
      "name": "my-pack",
      "displayName": "My Pack",
      "description": "A community pack",
      "version": "1.0.0",
      "author": "Author Name",
      "icon": "🔧",
      "category": "Engineering",
      "tags": ["engineering", "devops"],
      "gitUrl": "https://github.com/author/my-pack",
      "downloadUrl": "https://example.com/my-pack.json",
      "skillCount": 3,
      "agentCount": 1
    }
  ]
}
```

---

## Admin Policies & Organization Scope

Enterprise administrators can control plugin pack availability across the organization. See [Admin Policies](admin-policies.md) for the full guide.

### Organization Plugin Packs

Packs placed in the organization directory are loaded with `scope: "organization"` and shown in a separate "Organization" section in the Customize sidebar.

**Default org directory:** `~/.cowork/org-plugins/`
**Custom org directory:** Set via Admin Policies > Organization > Organization Plugin Directory

### Policy Enforcement

| Policy | Effect |
|--------|--------|
| **Blocked packs** | Pack shows as disabled, cannot be toggled on |
| **Required packs** | Pack cannot be toggled off, auto-activated |
| **Allowed packs** | If set, only listed packs are permitted (whitelist) |
| **Blocked connectors** | Specific connectors cannot be used |
| **Installation controls** | Toggle custom pack creation, git install, URL install |

Policies are enforced at the IPC handler level — the UI reflects policy state with visual indicators (lock icons, disabled toggles).

---

## Creating a Custom Pack

There are three ways to create a custom pack:

### 1. Via Plugin Store (Recommended)

1. Open the Customize panel
2. Click the **"+"** button to open the Plugin Store
3. Switch to the "Create New" tab
4. Fill in pack name, display name, category, and icon
5. Click "Create Pack"

### 2. Manual Creation

Create a directory in `~/.cowork/extensions/` with a `cowork.plugin.json` manifest:

```
~/.cowork/extensions/my-custom-pack/
└── cowork.plugin.json
```

### 3. Via CLI API

```typescript
window.electronAPI.scaffoldPluginPack({
  name: "my-custom-pack",
  displayName: "My Custom Pack",
  category: "Engineering",
  icon: "🔧",
  author: "Your Name",
})
```

### Minimal Manifest

```json
{
  "name": "my-custom-pack",
  "displayName": "My Custom Pack",
  "version": "1.0.0",
  "description": "A custom plugin pack for my workflows",
  "type": "pack",
  "author": "Your Name",
  "icon": "🔧",
  "category": "Custom",
  "skills": [
    {
      "id": "my-skill",
      "name": "My Skill",
      "description": "Does something useful",
      "icon": "⚡",
      "prompt": "Perform the following task:\n\nInput: {{input}}\n\nPlease provide:\n1. Analysis\n2. Recommendations\n3. Next steps",
      "parameters": [
        {
          "name": "input",
          "type": "string",
          "description": "The input to process",
          "required": true
        }
      ],
      "enabled": true
    }
  ],
  "agentRoles": [
    {
      "name": "my-assistant",
      "displayName": "My Assistant",
      "description": "A custom assistant for my workflows",
      "icon": "🔧",
      "color": "#6366f1",
      "capabilities": ["analyze", "write", "research"],
      "systemPrompt": "You are a custom assistant. Be helpful and precise."
    }
  ],
  "tryAsking": [
    "Analyze this input and give recommendations",
    "Help me with my custom workflow"
  ]
}
```

### Full Manifest Reference

```json
{
  "name": "pack-name",
  "displayName": "Human-Readable Name",
  "version": "1.0.0",
  "description": "What this pack does",
  "type": "pack",
  "author": "Author Name",
  "keywords": ["tag1", "tag2"],
  "icon": "🔧",
  "category": "Engineering",
  "personaTemplateId": "software-engineer",
  "recommendedConnectors": ["hubspot-mcp"],
  "tryAsking": [
    "Natural language prompt 1",
    "Natural language prompt 2"
  ],
  "skills": [
    {
      "id": "skill-id",
      "name": "Skill Name",
      "description": "What this skill does",
      "icon": "⚡",
      "category": "Engineering",
      "prompt": "Template with {{parameter}} placeholders",
      "parameters": [
        {
          "name": "parameter",
          "type": "string",
          "description": "What this parameter is",
          "required": true
        }
      ],
      "enabled": true
    }
  ],
  "agentRoles": [
    {
      "name": "role-name",
      "displayName": "Display Name",
      "description": "What this agent does",
      "icon": "🤖",
      "color": "#hex-color",
      "capabilities": ["code", "analyze", "write", "research"],
      "systemPrompt": "Full system prompt for the agent."
    }
  ],
  "slashCommands": [
    {
      "name": "command-name",
      "description": "What the command does",
      "skillId": "skill-id"
    }
  ],
  "connectors": [
    {
      "name": "connector-name",
      "description": "External service integration",
      "type": "http",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        }
      },
      "http": {
        "url": "https://api.example.com/{{query}}",
        "method": "GET",
        "headers": {
          "Authorization": "Bearer {{env.API_KEY}}"
        }
      }
    }
  ]
}
```

### Skill Prompt Tips

- Use `{{parameterName}}` for parameter substitution
- Structure prompts with numbered lists for consistent output format
- Include "Please provide:" sections to guide the LLM
- Keep prompts focused on one task per skill
- Add context fields for optional additional information

### Linking a Digital Twin

Set `personaTemplateId` to any existing persona template ID (e.g., `"software-engineer"`, `"product-manager"`). The pack will show a Digital Twin badge in the Customize panel, and users can activate the linked persona from Mission Control.

See [Digital Twin Personas Guide](digital-twin-personas-guide.md) for the full list of available templates and their capabilities.

---

## Use Cases

### Individual Contributor — Software Engineer

1. Enable the **Engineering** pack
2. Use "Triage open PRs and build a prioritized review queue" to manage code reviews
3. Run **Dependency Audit** before each release to catch vulnerabilities
4. Generate **Standup Updates** from your git history each morning
5. Activate the **Software Engineer** digital twin for automatic PR triage and test coverage monitoring

### Team Lead — Engineering Manager

1. Enable **Engineering Management** pack
2. Before each 1-on-1, use **1-on-1 Prep** to gather context on your report's recent work
3. Check **Sprint Health Review** mid-sprint to catch at-risk items early
4. Generate **Team Status Reports** for leadership with one click
5. Activate the **Engineering Manager** twin for daily sprint health summaries

### Product Manager

1. Enable **Product Management** pack
2. Paste a batch of feature requests into **Feature Request Triage** to categorize and prioritize
3. Use **User Story Generator** to create well-structured stories with acceptance criteria
4. Generate **Roadmap Updates** for stakeholder communication
5. The **Product Manager** twin proactively flags roadmap risks and prepares decision briefs

### Sales Team

1. Enable **Sales CRM** pack and connect the **HubSpot MCP** connector
2. Before outreach, run **Prospect Research** on target companies
3. After calls, use **Follow-up Email** to draft personalized follow-ups
4. Weekly, run **Pipeline Review** to flag at-risk deals
5. Use **Objection Handler** to prepare for common pushback

### DevOps / SRE

1. Enable **DevOps** pack
2. During incidents, use **Incident Response** for structured triage and communication templates
3. Before releases, generate a **Deployment Checklist** tailored to your environment
4. After incidents, write **Post-mortem Reports** in blameless format
5. The **DevOps/SRE** twin monitors deployment health and surfaces alerts proactively

### Mobile Developer

1. Enable **Mobile Development** pack
2. Use **React Native Setup** to scaffold a new cross-platform project with navigation and state management
3. Use **iOS Development** skills for SwiftUI patterns, simulator management, and code signing
4. Use **Android Development** skills for Jetpack Compose, Gradle builds, and Play Store submission
5. Set up **Build Pipeline** with Fastlane for automated iOS and Android deployment

### Game Developer

1. Enable **Game Development** pack
2. Use **Unity Development** for C# scripting, ScriptableObjects, and Unity CLI builds
3. Use **Unreal Engine Development** for C++/Blueprint patterns, Niagara, and packaging
4. Use **Godot Development** for GDScript, signals, and export presets
5. Run **Cross-Engine Performance** analysis to optimize draw calls, LOD, and memory usage

### Cross-Functional Team

Enable multiple packs simultaneously. A team of 5 might have:
- 2 engineers with the **Engineering** pack + twin
- 1 PM with **Product Management** pack + twin
- 1 EM with **Engineering Management** pack + twin
- 1 QA with **QA & Testing** pack + twin

Each person gets role-specific skills and proactive digital twins that work in the background — the PM twin triages feature requests while the engineer twins monitor PRs and dependencies, all running concurrently.

---

## Competitive Advantages

CoWork OS plugin packs offer capabilities beyond typical AI assistant plugins:

| Feature | CoWork OS | Typical AI Plugins |
|---------|-----------|-------------------|
| **Digital Twin integration** | Packs link to proactive personas that work in the background | Reactive only — waits for user prompts |
| **Multi-model** | Skills work with 30+ LLM providers (OpenAI, Anthropic, Google, local) | Locked to single provider |
| **Local-first** | All pack data on device, no cloud dependency | Cloud-dependent |
| **MCP standard** | Connectors use open Model Context Protocol | Proprietary integrations |
| **Heartbeat tasks** | Twins proactively surface insights on a schedule | No background processing |
| **Agent Teams** | Packs include team configurations for multi-agent orchestration | Single agent only |
| **Declarative** | Create packs with JSON only — no code required | Often requires code |

---

## Troubleshooting

### Pack not appearing in Customize panel
- Verify `cowork.plugin.json` exists in the pack directory
- Check that `"type": "pack"` is set in the manifest
- Ensure the `name` field is unique across all packs
- Restart the app to trigger pack discovery
- Check if the pack is blocked by admin policy (Settings > Admin Policies)

### Skills not executing
- Check that the pack is toggled ON (enabled)
- Verify skill parameters match the `{{placeholder}}` names in the prompt
- Check the `"enabled": true` flag on each skill

### Digital Twin badge not showing
- Confirm `personaTemplateId` is set in the manifest
- Verify the referenced template ID exists in `resources/persona-templates/`
- The badge appears in the Agents tab and the pack header

### Toggle doesn't persist after restart
- Pack enable/disable states are persisted in `pack-states.json` in the user data directory
- Per-skill toggle states are also persisted (individual skills within a pack can be toggled on/off)
- If states appear to reset, check that the user data directory is writable
- Delete `pack-states.json` to reset all toggles to defaults

### Pack toggle is locked / cannot be disabled
- The pack may be marked as **required** by admin policy
- Check Settings > Admin Policies > Required Packs
- Required packs show a lock indicator and cannot be toggled off

### Pack is blocked by policy
- The pack is in the admin policy blocked list
- Contact your organization admin to unblock it
- Blocked packs appear grayed out with a "Blocked" indicator

### Git install fails
- Verify the Git URL is accessible (try cloning manually)
- Check that the repo contains a valid `cowork.plugin.json` at the root
- Git-based installation may be disabled by admin policy

### Skill ID conflict between packs
- Two packs may define skills with the same ID
- The registry logs a warning at startup: check the console for `[PluginRegistry] Skill ID "..." already registered by`
- The later-loaded pack's skill takes precedence
- Fix by renaming the conflicting skill ID in one of the packs

### Update indicator not showing
- Update checks require the remote pack registry to be reachable
- Checks run in the background on panel mount and fail silently on network errors
- Only packs in the remote registry catalog can have update indicators
- Bundled packs are updated with app releases, not via the registry

### Search not finding a pack
- The search bar matches against: display name, name, description, category, and skill names
- Search is case-insensitive
- Try a broader term or clear the search to show all packs

### Plugin Store shows "Installation disabled"
- Admin policies may restrict custom pack creation or remote installation
- Check Settings > Admin Policies > Installation Permissions

---

## Further Reading

- [Admin Policies](admin-policies.md) — Enterprise admin policy configuration
- [Digital Twin Personas](digital-twins.md) — Proactive AI twin personas
- [Digital Twin Personas Guide](digital-twin-personas-guide.md) — Comprehensive guide with scenarios
- [Features](features.md) — Complete feature reference
