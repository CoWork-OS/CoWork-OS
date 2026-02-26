# CoWork OS — Use Case Showcase

A comprehensive guide to what you can build, automate, and manage with CoWork OS. Each section includes the capabilities involved, example prompts, and which skills/connectors/packs power the workflow.

---

## Software Engineering

### Code Generation & Scaffolding

Build entire features, modules, or applications from a natural language description. The agent reads your existing codebase, follows your project's conventions, and produces files that compile and pass lint on the first try.

**What it handles:**
- Full-stack feature scaffolding (API endpoints, database models, UI components, tests)
- Language-specific idioms — TypeScript, Python, Rust, Go, Swift, Kotlin, C#, C++, GDScript
- Framework scaffolding — React, Next.js, Express, FastAPI, Django, Rails, SwiftUI, Jetpack Compose
- Boilerplate reduction — generates repetitive code (CRUD operations, form validation, serializers) while you focus on business logic

**Example prompt:**
```
Create a REST API for a blog platform with posts, comments, and tags.
Use Express + TypeScript + Prisma + PostgreSQL.
Include input validation, pagination, and error handling.
Generate tests for each endpoint.
```

**Powered by:** Built-in coding agent, `run_command` tool, file tools, `write-tests` skill

---

### Code Review & Refactoring

Review pull requests, identify code smells, and refactor with confidence. The agent understands your codebase context — not just the diff.

**What it handles:**
- Structured PR review with risk assessment, missing test coverage, and approval recommendations
- TypeScript/JavaScript migration (e.g., JS → TS with full type annotations)
- Large-scale refactoring — rename symbols across files, extract shared modules, decompose monoliths
- SOLID principle enforcement, dead code removal, import cleanup

**Example prompt:**
```
Review the changes in PR #42. For each file, assess risk level (low/medium/high),
flag potential bugs, note missing tests, and give an overall approve/request-changes recommendation.
```

**Powered by:** `code-review` skill, `refactor-code` skill, `clean-imports` skill, Engineering plugin pack

---

### Debugging & Root Cause Analysis

Paste an error, a stack trace, or describe unexpected behavior — the agent traces through your code to find the root cause and suggests a fix.

**What it handles:**
- Stack trace analysis with file/line pinpointing
- Race condition and concurrency debugging
- Memory leak investigation
- Performance regression diagnosis
- Environment-specific issues (works on my machine / doesn't work in CI)

**Example prompt:**
```
This test passes locally but fails in CI with "ECONNREFUSED 127.0.0.1:5432".
Here's the CI config and docker-compose.yml. Find the issue and fix it.
```

**Powered by:** `debug-error` skill, `run_command` tool, file analysis tools

---

### Test Generation & Coverage

Generate unit, integration, and end-to-end tests that cover edge cases you didn't think of. The agent reads your implementation and infers the test surface.

**What it handles:**
- Unit test generation (Jest, pytest, NUnit, XCTest, JUnit)
- Integration test scaffolding with mock setup
- Edge case discovery — boundary values, null inputs, concurrent access, error paths
- Coverage gap analysis — identifies untested functions and branches
- Test data factories and fixture generation

**Example prompt:**
```
Write comprehensive tests for the PaymentService class.
Cover happy paths, insufficient funds, expired cards, network timeouts,
idempotency, and concurrent payment attempts.
Use Jest with TypeScript.
```

**Powered by:** `write-tests` skill, QA & Testing plugin pack, `run_command` tool

---

### Documentation from Code

Generate API references, READMEs, architecture docs, and changelogs directly from your source code and git history.

**What it handles:**
- API reference docs from endpoint definitions (method, path, params, request/response examples, error codes)
- README generation with project structure, setup instructions, and usage examples
- Changelog generation from git commits and PR descriptions
- Architecture decision records (ADRs)
- Inline documentation and JSDoc/docstring generation

**Example prompt:**
```
Generate API reference documentation for all endpoints in src/routes/.
Include method, path, query/body parameters, example request, example response,
possible error codes, and authentication requirements.
```

**Powered by:** `generate-readme` skill, `create-changelog` skill, `add-documentation` skill, Technical Writing plugin pack

---

### Dependency Management & Security Auditing

Scan your dependency tree for vulnerabilities, outdated packages, license conflicts, and supply chain risks.

**What it handles:**
- CVE scanning across npm, pip, Maven, NuGet, CocoaPods, Gradle
- Outdated version detection with upgrade impact assessment
- License compliance checking (GPL contamination, MIT/Apache compatibility)
- Supply chain risk scoring
- Automated upgrade PRs with test validation

**Example prompt:**
```
Audit all dependencies in this project. Flag any with known CVEs,
check for outdated major versions, and identify any GPL-licensed
packages that conflict with our MIT license.
```

**Powered by:** `dependency-check` skill, `security-audit` skill, Engineering plugin pack

---

## DevOps & Infrastructure

### Kubernetes Cluster Operations

Manage Kubernetes clusters, generate manifests, debug pods, and configure networking — all from natural language.

**What it handles:**
- Manifest generation — Deployments, Services, Ingress, ConfigMaps, Secrets, HPA, NetworkPolicies
- Helm chart operations — install, upgrade, rollback, template rendering
- Debugging — pod logs, describe, exec into containers, event inspection
- RBAC configuration and namespace management
- Kustomize overlays for environment-specific configs

**Example prompt:**
```
Generate Kubernetes manifests for a Node.js API with:
- 3 replicas with rolling update strategy
- Redis sidecar for session caching
- HPA scaling 2-10 pods based on CPU
- Ingress with TLS termination
- ConfigMap for environment variables
- Resource limits appropriate for a 2-core node
```

**Powered by:** `kubernetes-ops` skill, DevOps plugin pack (`devops-k8s-manifest` skill), `run_command` tool

---

### Terraform & Infrastructure as Code

Plan, review, and apply Terraform configurations. The agent understands state management, module composition, and blast radius assessment.

**What it handles:**
- `terraform init/plan/apply/destroy` workflows with dry-run analysis
- State management — inspect, move, import, remove resources
- Module development and composition
- Backend configuration (S3, GCS, Azure Blob, Terraform Cloud)
- Drift detection and remediation
- Multi-environment workspace management

**Example prompt:**
```
Review this terraform plan output. Flag any resource deletions,
assess the blast radius, check for configuration drift,
and recommend whether to approve or reject.
```

**Powered by:** `terraform-ops` skill, DevOps plugin pack (`devops-terraform-plan` skill), `run_command` tool

---

### Docker & Container Workflows

Build Docker images, compose multi-service stacks, and optimize container configurations.

**What it handles:**
- Docker Compose file generation with services, networking, volumes, secrets
- Multi-stage Dockerfile optimization (smaller images, faster builds)
- Health checks and dependency ordering
- Dev vs production configuration patterns
- Container debugging and log analysis

**Example prompt:**
```
Create a Docker Compose setup for a full-stack app:
- Next.js frontend on port 3000
- Express API on port 4000
- PostgreSQL with persistent volume
- Redis for caching
- Nginx reverse proxy with SSL
Include health checks and a .env.example file.
```

**Powered by:** `docker-compose-ops` skill, DevOps plugin pack (`devops-docker-compose` skill)

---

### Cloud Migration

Assess workloads for migration readiness, plan cutover strategies, and estimate costs across cloud providers.

**What it handles:**
- 6 Rs assessment (Rehost, Replatform, Refactor, Repurchase, Retain, Retire)
- Database migration strategies (homogeneous, heterogeneous, CDC-based)
- Network migration planning (VPN, Direct Connect, peering)
- Cost estimation and TCO analysis
- Cutover planning with rollback procedures
- Multi-cloud and hybrid patterns

**Example prompt:**
```
Assess these 5 workloads for cloud migration readiness:
1. Legacy Java monolith on bare metal
2. .NET API on Windows Server VMs
3. PostgreSQL database (2TB)
4. Static marketing site
5. Batch processing jobs (Hadoop)

For each, recommend the right R strategy, estimate effort, and flag risks.
```

**Powered by:** `cloud-migration` skill, DevOps plugin pack (`devops-migration-assessment` skill)

---

### CI/CD Pipeline & Deployment

Generate deployment checklists, configure CI pipelines, and manage releases with automated verification.

**What it handles:**
- Deployment checklists — pre-deploy checks, migration scripts, rollback procedures
- CI configuration (GitHub Actions, GitLab CI, CircleCI, Jenkins)
- Zero-downtime deployment strategies (blue-green, canary, rolling)
- Post-deploy health checks and smoke tests
- Incident response playbooks and post-mortems

**Example prompt:**
```
Create an incident response plan for this production database outage.
Include: severity classification, immediate triage steps,
stakeholder communication templates, escalation path,
root cause investigation checklist, and post-mortem outline.
```

**Powered by:** DevOps plugin pack (Incident Response, Deployment Checklist, Monitoring Setup, Post-mortem Report skills)

---

## Mobile Development

### iOS App Development

Build iOS apps with SwiftUI or UIKit, manage data with SwiftData/Core Data, and deploy to the App Store.

**What it handles:**
- SwiftUI views, @Observable state management, navigation patterns
- Core Data / SwiftData models and migrations
- Push notifications (APNs), deep linking, Universal Links
- Xcode build commands (`xcodebuild`), simulator management (`xcrun simctl`)
- Code signing, provisioning profiles, TestFlight distribution
- App Store submission and review guidelines

**Example prompt:**
```
Create a SwiftUI view for a settings screen with:
- User profile section (avatar, name, email)
- Toggle switches for notifications and dark mode
- Navigation links to account, privacy, and about pages
- @Observable SettingsViewModel with UserDefaults persistence
```

**Powered by:** `ios-development` skill, Mobile Development plugin pack

---

### Android App Development

Build Android apps with Jetpack Compose, manage data with Room, and deploy to the Play Store.

**What it handles:**
- Jetpack Compose UI with Material 3 theming
- ViewModel, Room database, Retrofit networking
- Dependency injection with Hilt/Dagger
- Kotlin Coroutines and Flow for async operations
- Gradle builds, ProGuard/R8 configuration
- ADB/emulator commands, Play Store submission

**Example prompt:**
```
Create a Jetpack Compose screen that displays a list of items from a Room database.
Include a ViewModel with StateFlow, a Repository layer with Retrofit for remote sync,
and Hilt dependency injection. Use Material 3 components.
```

**Powered by:** `android-development` skill, Mobile Development plugin pack

---

### Cross-Platform Mobile

Build with React Native, manage native modules, and configure build pipelines for both platforms.

**What it handles:**
- React Native project scaffolding with navigation and state management
- Native module integration and platform-specific code
- Expo vs bare workflow decision guidance
- Fastlane setup for automated builds and deployment
- Code signing automation for iOS and Android
- Beta distribution via TestFlight and Play Store internal tracks

**Example prompt:**
```
Set up a React Native project with:
- React Navigation (tab + stack navigators)
- Zustand for state management
- React Query for API calls
- Fastlane for iOS and Android builds
- GitHub Actions CI pipeline
```

**Powered by:** Mobile Development plugin pack (React Native Setup, Build Pipeline skills)

---

## Game Development

### Unity Development

Build games with Unity and C#. Covers gameplay programming, asset management, rendering pipelines, and CLI builds.

**What it handles:**
- MonoBehaviour lifecycle, component patterns, SerializeField best practices
- ScriptableObjects for data-driven design (weapons, items, level configs)
- Object pooling, Addressables, async asset loading
- URP/HDRP rendering, Shader Graph, custom shaders
- UI Toolkit and legacy Canvas UI
- Editor scripting with custom inspectors
- Unity CLI batch builds and automated testing

**Example prompt:**
```
Create a Unity player controller with:
- Third-person camera using Cinemachine
- Character movement with Rigidbody physics
- Jump with ground check (SphereCast)
- Sprint toggle with stamina system
- Input handling via the new Input System
```

**Powered by:** `unity-development` skill, Game Development plugin pack

---

### Unreal Engine Development

Build with Unreal Engine 5 using C++ and Blueprints. Covers the Gameplay Framework, rendering, multiplayer, and packaging.

**What it handles:**
- Actor lifecycle, Gameplay Framework class hierarchy
- Enhanced Input system for player controls
- UCLASS/UPROPERTY/UFUNCTION macros for Blueprint exposure
- Niagara particle systems, Lumen global illumination, Nanite virtualized geometry
- Multiplayer replication with RPCs and replicated properties
- UnrealBuildTool and RunUAT packaging commands

**Example prompt:**
```
Set up an Unreal Engine character with:
- Enhanced Input for WASD movement and mouse look
- Third-person camera with spring arm
- C++ base class with Blueprint-callable combat functions
- Replicated health property with OnRep callback for multiplayer
```

**Powered by:** `unreal-development` skill, Game Development plugin pack

---

### Game Performance Optimization

Profile and optimize games across Unity, Unreal, and Godot. Identify whether you're CPU-bound, GPU-bound, or memory-bound and fix it.

**What it handles:**
- Draw call reduction — static/dynamic batching, GPU instancing, SRP Batcher
- LOD configuration with automatic transition distances
- Occlusion culling setup (frustum, occlusion, distance)
- Texture optimization — compression formats per platform, atlas packing, mipmap streaming
- Object pooling for projectiles, particles, enemies, UI elements
- Memory budgeting per platform (mobile, PC, console)
- Shader optimization — half precision, reduced texture samples, shader LOD
- Physics optimization — simple colliders, collision layers, reduced tick rates
- Profiling tool guidance for each engine

**Example prompt:**
```
My Unity mobile game runs at 22fps on a Galaxy S21. The profiler shows
1200 draw calls and 45MB of texture memory. Give me a prioritized
optimization plan to hit 30fps stable.
```

**Powered by:** `game-performance` skill, Game Development plugin pack

---

## Enterprise Integrations

### CRM & Sales Automation

Connect to Salesforce and HubSpot to automate pipeline management, prospect research, and follow-up sequences.

**What it handles:**
- Salesforce record CRUD via SOQL — accounts, contacts, opportunities, leads
- HubSpot contact, company, and deal management
- Pipeline review with at-risk deal flagging and win probability analysis
- Prospect research — company overview, decision makers, pain points, talking points
- Follow-up email drafting personalized to meeting context
- Objection handling with counter-arguments for pricing, timing, and competitor concerns

**Example prompt:**
```
Review my Salesforce pipeline for Q1. Flag deals that haven't moved stages
in 2+ weeks, identify the top 5 at-risk opportunities by revenue,
and draft re-engagement emails for each.
```

**Powered by:** Salesforce MCP connector, HubSpot MCP connector, Sales CRM plugin pack

---

### Project & Issue Tracking

Connect to Jira, Linear, and Asana to manage sprints, triage issues, and generate reports.

**What it handles:**
- Jira issue CRUD, JQL search, sprint management
- Linear issue tracking and project management
- Asana task and project operations
- Sprint health reviews — progress, at-risk items, workload balance
- Issue triage and priority classification
- Automated standup generation from recent activity

**Example prompt:**
```
Search Jira for all open bugs in the PAYMENTS project assigned to the backend team.
Group by severity, flag any older than 2 weeks, and create a summary
for the next sprint planning meeting.
```

**Powered by:** Jira MCP connector, Linear MCP connector, Asana MCP connector, Engineering Management plugin pack

---

### Discord Community Management

Manage Discord guilds, channels, roles, messages, threads, webhooks, and members through the REST API connector.

**What it handles:**
- Guild and channel management — list, create, edit, delete channels across text, voice, forum, and category types
- Rich message sending with typed embed cards (title, description, color, fields, images, author)
- Thread creation from messages or standalone for organized discussions
- Role management — create, edit, delete roles with color, hoist, and mentionable settings
- Webhook management — create and list webhooks for automated notifications
- Reaction management — add emoji reactions to messages
- Member listing with pagination
- Automatic rate limit handling with 429 retry

**Example prompt:**
```
Set up a Discord server structure for our open-source project:
- Create categories: General, Development, Community, Support
- Under Development: #announcements, #pull-requests, #ci-status
- Under Community: #introductions, #showcase, #off-topic
- Create roles: Maintainer (blue, hoisted), Contributor (green), Triage (orange)
- Create a webhook in #ci-status for GitHub notifications
```

**Powered by:** Discord MCP connector (19 tools), Discord gateway adapter (real-time messaging)

---

### Customer Support Workflows

Connect to Zendesk and ServiceNow to automate ticket triage, response drafting, and escalation management.

**What it handles:**
- Ticket triage — categorize by type, assess urgency, route to team
- Response drafting with empathetic tone, solution steps, and next actions
- Escalation summaries with timeline, attempts made, and customer sentiment
- Knowledge base article generation from resolved cases
- Recurring issue pattern detection

**Example prompt:**
```
Triage the 15 unassigned Zendesk tickets from the last 24 hours.
Classify each by urgency (critical/high/medium/low), suggest routing,
and draft responses for the critical and high-priority ones.
```

**Powered by:** Zendesk MCP connector, ServiceNow MCP connector, Customer Support plugin pack

---

### Communication & Messaging

Manage conversations across Slack, email (Gmail/IMAP), and other channels with unified AI-powered workflows.

**What it handles:**
- Slack channel management, message posting, and history search
- Email triage, draft responses, and cleanup suggestions
- Cross-channel message monitoring and digest generation
- Notification webhook management
- Identity and access management via Okta

**Example prompt:**
```
Search Slack for all messages mentioning "deployment" in the last 48 hours.
Summarize the key discussions, flag any unresolved issues,
and draft a status update for the #engineering channel.
```

**Powered by:** Slack MCP connector, Gmail MCP connector, Okta MCP connector, Resend MCP connector

---

## Data & Analytics

### CSV & Dataset Analysis

Analyze datasets, generate insights, and create visualizations from structured data.

**What it handles:**
- Summary statistics, distribution analysis, and correlation matrices
- Missing data detection and imputation recommendations
- Outlier identification and anomaly detection
- Trend analysis and pattern recognition
- SQL query generation from natural language
- Chart and dashboard recommendations

**Example prompt:**
```
Analyze this CSV of 50,000 e-commerce transactions. Give me:
- Revenue by month with growth rate
- Top 10 products by total revenue
- Customer cohort analysis (first purchase month)
- Anomalies in refund rates
- Recommended visualizations for an executive dashboard
```

**Powered by:** `analyze-csv` skill, Data Analysis plugin pack, `run_command` tool (Python/pandas)

---

### Financial Analysis & Modeling

Build financial models, analyze earnings, screen markets, and assess portfolio risk.

**What it handles:**
- DCF valuation models with sensitivity analysis
- Earnings analysis and peer comparison
- Market screening by fundamentals and technicals
- Portfolio optimization with risk/return metrics
- ESG scoring and analysis
- Tax optimization strategies

**Example prompt:**
```
Build a DCF model for Apple (AAPL) using the last 4 quarters of financial data.
Include revenue growth assumptions (base/bull/bear), WACC calculation,
terminal value with exit multiple, and a sensitivity table.
```

**Powered by:** `dcf-valuation` skill, `earnings-analyzer` skill, `market-screener` skill, `portfolio-optimizer` skill, `stock-analysis` skill, Financial Analysis plugin pack

---

## Content & Marketing

### Technical Writing & Documentation

Audit existing docs, generate new content, and maintain consistency across your documentation.

**What it handles:**
- Documentation audit — stale docs, broken links, accuracy vs current code
- API reference generation from code
- Changelog generation from git history
- Style consistency checking and tone normalization
- Getting started guides and tutorials

**Example prompt:**
```
Audit our docs/ folder. Find any files that reference APIs or features
that have changed since their last update. Produce a table of stale docs
with the specific sections that need updating and suggested corrections.
```

**Powered by:** Technical Writing plugin pack, `create-changelog` skill, `generate-readme` skill

---

### Marketing Content & Campaigns

Create blog posts, social media content, email campaigns, and landing page copy with SEO optimization.

**What it handles:**
- SEO-optimized blog posts with headline variants and meta descriptions
- Multi-platform social media (Twitter/X, LinkedIn, Instagram) with hashtags
- Email marketing campaigns with A/B test variants
- Landing page copy with CRO best practices
- Campaign strategy with goals, channels, timeline, and KPIs
- Copywriting frameworks — PAS, AIDA, BAB, 4Ps, FAB

**Example prompt:**
```
Create a launch campaign for our new API product:
- 3 blog post outlines targeting different audiences (developers, CTOs, DevOps)
- Social media posts for Twitter and LinkedIn (5 each)
- Landing page copy with hero, features, social proof, and CTA sections
- Email drip sequence (welcome, feature highlight, case study, trial expiry)
```

**Powered by:** Content & Marketing plugin pack, `marketing-strategist` skill, `email-marketing-bible` skill, `twitter` skill

---

## Personal Productivity

### Morning Briefing & Chief of Staff

Start your day with an AI-generated executive brief covering calendar, inbox, tasks, and priorities.

**What it handles:**
- Calendar event summary with prep notes for meetings
- Inbox triage with priority classification
- Task and reminder overview
- Weather and commute signals
- Recommended action sequence by urgency
- Schedulable as a daily recurring task

**Example prompt:**
```
/brief morning
```

**Powered by:** Chief of Staff briefing skill, scheduled tasks, multi-channel gateway

---

### Inbox Management

Triage email, draft responses, identify cleanup opportunities, and manage follow-ups automatically.

**What it handles:**
- Email classification by urgency (critical, today, this week, no action)
- Response drafting for priority messages
- Newsletter and promotional email cleanup suggestions
- Follow-up reminder creation
- Unsubscribe recommendations for low-value subscriptions

**Example prompt:**
```
/inbox autopilot 180
```

**Powered by:** `usecase-inbox-manager` skill, Gmail integration, Email channel

---

### Multi-Channel Messaging

Manage conversations across 14 messaging channels — reply to messages, monitor discussions, and send updates from anywhere.

**What it handles:**
- WhatsApp, Telegram, Discord, Slack, Teams, iMessage, Signal, and more
- Message drafting with tone matching
- Reply confirmation gates (drafts before sending)
- Cross-channel monitoring and notification aggregation
- Scheduled messages and recurring digests
- File sharing and media handling

**Example prompt:**
```
Check my Telegram messages from the last 12 hours.
Summarize any messages that need a response, draft replies,
and let me review before sending.
```

**Powered by:** 14-channel gateway, channel tools, scheduling service

---

### Task Capture & Organization

Capture tasks from conversations, notes, or free-form text and organize them across Notion, Apple Reminders, Things, Trello, and other tools.

**What it handles:**
- Natural language task extraction with due date inference
- Notion database integration — create pages, update properties
- Apple Reminders and Calendar integration (macOS native)
- Trello board and card management
- Priority assignment and dependency detection

**Example prompt:**
```
Turn this meeting transcript into action items. For each item:
- Create a Notion task with assignee and due date
- Create an Apple Reminder for anything due this week
- Flag any items that are blocked by other tasks
```

**Powered by:** `notion` skill, `apple-reminders` skill, `trello` skill, `things-mac` skill

---

### Web Scraping & Monitoring

Scrape websites, monitor prices, map site structures, and extract structured data with anti-bot bypass.

**What it handles:**
- Single and batch URL scraping with TLS fingerprinting
- Stealth mode with Cloudflare bypass
- Structured data extraction (tables, lists, metadata)
- Persistent sessions for login→navigate→extract workflows
- Price tracking and change detection
- Site mapping and content monitoring

**Example prompt:**
```
Scrape the pricing page of these 5 competitor websites.
Extract plan names, prices, and feature lists into a comparison table.
Set up weekly monitoring to alert me of any pricing changes.
```

**Powered by:** Scrapling integration, `web-scraper` skill, `price-tracker` skill, `site-mapper` skill, `content-monitor` skill

---

## Team & Management

### Sprint Management

Track sprint progress, identify at-risk items, balance workloads, and generate status reports.

**What it handles:**
- Sprint health dashboards — completion percentage, at-risk items, predicted outcome
- Blocker detection and escalation recommendations
- Workload balance analysis across team members
- Sprint retrospective summaries
- Cross-team dependency tracking

**Example prompt:**
```
How's our sprint looking? Pull data from Jira and give me:
- Overall completion percentage
- Items at risk (stalled 3+ days or blocked)
- Workload distribution across the team
- Predicted sprint outcome (will we hit the goal?)
```

**Powered by:** Engineering Management plugin pack, Jira MCP connector

---

### 1-on-1 & Meeting Prep

Prepare for meetings with context on each participant's recent work, accomplishments, and potential concerns.

**What it handles:**
- Recent accomplishments and contributions per team member
- Current work items and their status
- Potential concerns (overdue items, declining velocity, blocked work)
- Suggested discussion topics and career development points
- Meeting agenda generation

**Example prompt:**
```
Prepare 1-on-1 notes for my meeting with Sarah.
Pull her recent PRs, Jira activity, and any blockers.
Suggest 3-4 discussion topics including career growth.
```

**Powered by:** Engineering Management plugin pack (1-on-1 Prep skill)

---

### Digital Twin Automation

Activate role-specific AI twins that proactively handle cognitive overhead in the background — PR triage, sprint health reports, dependency scans, and more.

**What it handles:**
- 10 pre-built persona templates across engineering, management, product, data, and operations
- Heartbeat-driven background tasks on configurable schedules
- Proactive insights — flagging issues, preparing reports, surfacing patterns
- Cognitive offload categories per role
- Persistent across sessions

**Available twins:**
- Software Engineer — PR triage, dependency checks, test coverage monitoring
- Engineering Manager — Sprint health, standup summaries, blocker detection
- Product Manager — Feature request triage, roadmap risk flagging
- DevOps/SRE — Deployment health, uptime monitoring, incident summaries
- QA/Test Engineer — Coverage reports, regression risk, flaky test detection
- Data Scientist — Pipeline health, data quality scans, anomaly detection
- Technical Writer — Doc freshness scans, style consistency checks

**Powered by:** Digital Twin system, Mission Control, plugin pack integration

---

## Security & Compliance

### Security Auditing

Scan codebases for vulnerabilities including SQL injection, XSS, CSRF, authentication flaws, and OWASP Top 10 issues.

**What it handles:**
- Static analysis for common vulnerability patterns
- Authentication and authorization flow review
- Input validation and sanitization checks
- Secrets detection (API keys, tokens, credentials in code)
- Dependency vulnerability scanning
- Compliance checklist generation (HIPAA, PCI-DSS, SOC2, GDPR)

**Example prompt:**
```
Run a security audit on the src/auth/ and src/api/ directories.
Check for: SQL injection, XSS, CSRF, improper auth checks,
hardcoded secrets, and missing rate limiting.
Output findings by severity with remediation steps.
```

**Powered by:** `security-audit` skill, `dependency-check` skill

---

## Remote & Multi-Surface Operations

### Chat-Driven Deployment

Deploy code, manage servers, and run operations from any messaging channel — WhatsApp, Telegram, Slack, Discord, or even SMS.

**What it handles:**
- Deployment triggers via chat commands
- Server health checks and status monitoring
- Log tailing and error investigation
- Scheduled task management from mobile
- Approval workflows with confirmation gates

**Example prompt (via Telegram):**
```
Deploy the staging branch to production.
Run the pre-deploy checklist first, then proceed if all green.
Send me a summary when done.
```

**Powered by:** 14-channel multichannel gateway, DevOps plugin pack, approval workflows

---

### Headless & Server Deployment

Run CoWork OS as a headless daemon on Linux servers with remote access via Tailscale, SSH, or WebSocket.

**What it handles:**
- Headless mode on Ubuntu/Debian/CentOS via systemd
- Docker containerized deployment
- Remote WebSocket API for programmatic access
- Tailscale mesh networking for secure remote access
- SSH tunnel configuration

**Powered by:** Headless daemon, WebSocket API, remote access layer

---

## Learning & Career

### Codebase Understanding

Onboard to new codebases faster. The agent reads project structure, identifies patterns, and explains architecture.

**What it handles:**
- Project structure mapping and architecture explanation
- Framework and pattern identification
- Dependency graph visualization
- Entry point and data flow tracing
- Convention and style guide inference

**Example prompt:**
```
I just joined this project. Walk me through:
- The overall architecture and key directories
- How a request flows from API to database
- The testing strategy and how to run tests
- Any notable patterns or conventions
```

**Powered by:** `project-structure` skill, `explain-code` skill, file analysis tools

---

### Skill Development

Learn new languages, frameworks, and concepts with contextual guidance tailored to your existing codebase.

**What it handles:**
- Language-specific idiom guidance (e.g., converting Python patterns to Rust)
- Framework tutorial generation with working examples
- Best practice explanations with before/after code comparisons
- Code kata and challenge suggestions
- Career transition support (e.g., PM → developer, frontend → backend)

**Example prompt:**
```
I know JavaScript well and want to learn Rust.
Convert this Node.js HTTP server to Rust using Axum.
Explain each Rust concept (ownership, borrowing, lifetimes) as it appears.
```

**Powered by:** `learn` skill, `convert-code` skill, coding agent

---

## Voice & Audio

### Voice Calls & Conferencing

Initiate, manage, and transcribe voice calls directly from the agent. Make outbound calls, handle inbound routing, and generate real-time transcripts — all hands-free.

**What it handles:**
- Outbound voice calls via ElevenLabs Conversational AI or Twilio
- Call recording and automatic transcription
- Voice-driven task execution — speak a command and the agent acts on it
- Conference call summaries with action item extraction
- Voicemail management and priority routing

**Example prompt:**
```
Call the restaurant at +1-555-0123 and ask if they have availability
for 4 people this Saturday at 7pm. Record the answer and summarize it.
```

**Powered by:** ElevenLabs MCP connector, voice tools, transcription pipeline

---

### Text-to-Speech & Audio Generation

Convert any text output to natural-sounding speech with multiple voice providers. Generate audio briefings, narrated reports, or podcast-style summaries.

**What it handles:**
- Multi-provider TTS — ElevenLabs (premium voices), OpenAI TTS, macOS `say` command (offline)
- Voice cloning and custom voice profiles
- Audio briefing generation — morning brief read aloud as a podcast
- Multilingual speech synthesis
- Audio file export (MP3, WAV) for sharing

**Example prompt:**
```
Take my morning briefing and convert it to an audio file using a professional
news-anchor voice. Save it as morning-brief.mp3 so I can listen on my commute.
```

**Powered by:** ElevenLabs MCP, OpenAI TTS, macOS `say`, audio export tools

---

### Speech-to-Text & Dictation

Transcribe audio files or live dictation into structured text. Use local Whisper models for privacy-sensitive transcription or cloud providers for speed.

**What it handles:**
- Local transcription with OpenAI Whisper (no data leaves your machine)
- Cloud transcription via Deepgram, AssemblyAI, or OpenAI
- Meeting recording transcription with speaker diarization
- Voice note capture — dictate tasks, notes, or emails and the agent formats them
- Multi-language transcription and auto-translation

**Example prompt:**
```
Transcribe this meeting recording (meeting-2026-02-25.m4a) using Whisper locally.
Identify speakers, extract action items, and create Notion tasks for each one.
```

**Powered by:** Whisper MCP, Deepgram integration, transcription tools

---

### Music & Speaker Control

Control music playback and multi-room audio systems through natural language. Queue songs, adjust volume, and orchestrate multi-room setups.

**What it handles:**
- Spotify playback control — play, pause, skip, queue, playlists, search
- Sonos multi-room speaker management — group rooms, set volume per zone
- BluOS/NAD speaker control for audiophile setups
- Playlist curation based on mood, activity, or time of day
- Cross-platform audio routing

**Example prompt:**
```
Play my "Focus" playlist on Spotify, route it to the office Sonos speaker
at 40% volume. When it's 5pm, switch to "Evening Jazz" in the living room.
```

**Powered by:** Spotify MCP, Sonos MCP, BluOS MCP, scheduling engine

---

## Smart Home & IoT

### Lighting & Ambiance

Control smart lighting systems with scene management, schedules, and adaptive automation. Set the mood without opening an app.

**What it handles:**
- Philips Hue control via OpenHue MCP — individual lights, rooms, zones, scenes
- Color temperature scheduling (energizing blue in morning, warm amber at night)
- Motion-triggered automation rules
- Scene creation and activation ("Movie Night", "Focus Mode", "Wake Up")
- Multi-room coordination and transition effects

**Example prompt:**
```
Set up an evening routine: at sunset, dim the living room to 30% warm white,
turn off the office lights, and set the bedroom to a soft amber glow.
Create this as a reusable scene called "Wind Down".
```

**Powered by:** OpenHue MCP connector, scheduling engine, smart home orchestrator

---

### Sleep & Wellness Devices

Monitor and control connected wellness hardware — sleep trackers, smart mattresses, and environmental sensors.

**What it handles:**
- Eight Sleep pod control — bed temperature per side, schedules, vibration alarms
- Sleep data analysis — sleep stages, HRV, respiratory rate trends
- Environmental monitoring — room temperature, humidity, air quality
- Wellness routine automation — combine lighting, temperature, and alarms
- Weekly sleep quality reports with recommendations

**Example prompt:**
```
Set my Eight Sleep to cool the bed to -2 on my side starting at 10pm,
then gradually warm to +1 by 6am. Show me last week's sleep data and
flag any nights where deep sleep was below 15%.
```

**Powered by:** Eight Sleep MCP, wellness data tools, scheduling engine

---

### Camera & Surveillance Feeds

Access and analyze security camera feeds, motion detection logs, and visual monitoring — all from the agent.

**What it handles:**
- RTSP/ONVIF camera stream access and snapshot capture
- Motion event log retrieval and timeline review
- Visual analysis of camera snapshots (person/vehicle/animal detection)
- Multi-camera dashboard summaries
- Alert configuration for specific zones or times

**Example prompt:**
```
Pull the latest snapshot from the front door camera and the driveway camera.
Check if there are any packages visible on the porch. Summarize any motion
events from the last 4 hours.
```

**Powered by:** Camera MCP tools, vision analysis, Peekaboo macOS automation

---

## Financial Intelligence

### Risk Analysis & Portfolio Monitoring

Run quantitative risk assessments on investment portfolios with Monte Carlo simulation, Value-at-Risk calculations, and stress testing.

**What it handles:**
- Value-at-Risk (VaR) calculations at multiple confidence levels
- Monte Carlo portfolio simulation (1000+ scenarios)
- Stress testing against historical events (2008 crisis, COVID crash, rate hikes)
- Correlation matrix analysis across asset classes
- Drawdown analysis and recovery projections

**Example prompt:**
```
Run a Monte Carlo simulation on my portfolio (60% SPY, 25% BND, 15% GLD)
with 10,000 scenarios over a 5-year horizon. Calculate the 95% VaR,
maximum drawdown, and Sharpe ratio. Compare against a 100% SPY benchmark.
```

**Powered by:** `risk-analyzer` skill, `portfolio-optimizer` skill, financial modeling tools

---

### Tax Optimization & Planning

Analyze tax positions, identify optimization opportunities, and model different filing scenarios. Supports individual and business tax planning.

**What it handles:**
- Tax-loss harvesting opportunity identification
- Capital gains optimization (short-term vs long-term holding analysis)
- Retirement contribution strategy (401k, IRA, Roth conversion ladders)
- Business entity comparison (LLC vs S-Corp vs C-Corp tax implications)
- Estimated quarterly tax calculations

**Example prompt:**
```
Review my 2025 trading activity and identify tax-loss harvesting opportunities.
Calculate my estimated capital gains tax liability under current brackets.
Model the impact of converting $50K from traditional IRA to Roth this year.
```

**Powered by:** `tax-optimizer` skill, financial modeling, Wealth Management pack

---

### Cryptocurrency Operations

Execute crypto market analysis, portfolio tracking, and trading operations across multiple exchanges via unified APIs.

**What it handles:**
- Multi-exchange portfolio aggregation (Binance, Coinbase, Kraken, etc. via ccxt)
- Real-time price monitoring and alert configuration
- DeFi yield farming analysis and comparison
- On-chain transaction tracking and whale watching
- Technical analysis with crypto-specific indicators (funding rates, liquidation levels)

**Example prompt:**
```
Show my total crypto portfolio value across Binance and Coinbase.
Flag any position that's down more than 20% from entry.
Check current ETH staking yields across Lido, Rocket Pool, and Coinbase
and recommend the best risk-adjusted option.
```

**Powered by:** ccxt MCP connector, crypto analysis tools, `market-screener` skill

---

### Startup CFO & Financial Modeling

Act as a fractional CFO for startups — build financial models, track burn rate, model fundraising scenarios, and generate investor-ready reports.

**What it handles:**
- Three-statement financial model generation (P&L, balance sheet, cash flow)
- Burn rate tracking with runway projections
- Fundraising scenario modeling (dilution tables, valuation waterfalls)
- Unit economics analysis (CAC, LTV, payback period, magic number)
- Board deck financial slide generation

**Example prompt:**
```
Build a 3-year financial model for my SaaS startup.
Current MRR: $45K, growing 12% MoM, gross margin 82%, burn: $120K/month.
Model a Series A at $15M pre-money with $4M raise.
Show runway extension and dilution impact.
```

**Powered by:** `financial-modeling` skill, `dcf-valuation` skill, Private Equity pack

---

### Prediction Markets & Forecasting

Monitor prediction market odds, analyze sentiment shifts, and build probabilistic forecasts from market data.

**What it handles:**
- Polymarket position tracking and odds monitoring
- Event probability analysis with historical calibration
- Sentiment aggregation across prediction platforms
- Arbitrage opportunity detection between markets
- Custom forecast model building

**Example prompt:**
```
Pull current Polymarket odds for the top 10 most-traded political and
economic events. Compare with Metaculus forecasts where available.
Flag any events where the markets disagree by more than 15 percentage points.
```

**Powered by:** Polymarket integration, web research tools, analytical agent

---

### ESG & Impact Scoring

Evaluate companies and portfolios against Environmental, Social, and Governance criteria with quantitative scoring.

**What it handles:**
- Company-level ESG score computation across E, S, G pillars
- Portfolio-wide ESG exposure analysis
- Controversy screening and news monitoring
- Carbon footprint estimation for equity portfolios
- Peer comparison and sector benchmarking

**Example prompt:**
```
Score these 5 companies on ESG metrics: AAPL, MSFT, XOM, TSLA, JPM.
Break down by Environmental, Social, and Governance pillars.
Flag any recent controversies that should affect the scores.
```

**Powered by:** `esg-scorer` skill, web research, `earnings-analyzer` skill

---

## Knowledge & Note-Taking

### Apple Notes & Native Ecosystem

Create, search, and organize notes in Apple Notes directly from the agent. Perfect for macOS users who want their AI assistant to work with their existing note system.

**What it handles:**
- Create and append to Apple Notes with rich formatting
- Search across all notes by keyword or date range
- Organize notes into folders automatically
- Cross-reference notes with calendar events and reminders
- Export note collections to markdown or PDF

**Example prompt:**
```
Search my Apple Notes for anything related to "project alpha".
Summarize the key decisions across all matching notes and create
a new consolidated note called "Project Alpha — Decision Log".
```

**Powered by:** Apple Notes integration, macOS automation, note management tools

---

### Knowledge Graph & Memory

Build a persistent, searchable knowledge graph that connects information across conversations, documents, and research. The agent remembers what matters.

**What it handles:**
- Automatic knowledge extraction from conversations and documents
- Full-text search with SQLite FTS5 indexing
- Entity relationship mapping (people → projects → decisions → outcomes)
- Memory recall in future conversations ("What did we decide about X?")
- Knowledge export and visualization
- ChatGPT conversation history import and indexing

**Example prompt:**
```
Build a knowledge graph from my last 50 conversations.
Extract key decisions, people mentioned, and project references.
Show me the connections between them and flag any conflicting decisions.
```

**Powered by:** Memory service, knowledge graph with FTS5, `scratchpad` tools

---

### Research & Deep Dives

Conduct multi-source research with structured output — the agent reads documents, fetches web sources, cross-references data, and produces cited reports.

**What it handles:**
- Multi-URL web research with automatic summarization
- Academic paper analysis and literature review
- Competitive landscape research with comparison matrices
- Fact-checking with source attribution
- Research report generation with citations and confidence scores

**Example prompt:**
```
Research the current state of WebAssembly for server-side applications.
Cover: major runtimes (Wasmtime, Wasmer, WasmEdge), production deployments,
performance benchmarks vs native, and ecosystem maturity.
Cite all sources and rate confidence for each claim.
```

**Powered by:** Web research tools, document analysis, `deep-research` skill

---

## AI Agent Ecosystem

### Agent Teams & Parallel Execution

Spin up coordinated agent teams that work on multiple tasks simultaneously with shared context and progress tracking.

**What it handles:**
- Parallel task execution with up to 8 concurrent agents
- Shared checklist coordination — agents check off items as they complete
- Inter-agent context sharing for dependent workflows
- Progress dashboard with real-time status per agent
- Automatic conflict resolution when agents touch overlapping areas

**Example prompt:**
```
Create an agent team to prepare for our product launch:
- Agent 1: Draft the press release and blog post
- Agent 2: Generate social media posts for Twitter, LinkedIn, and Product Hunt
- Agent 3: Prepare the email campaign sequence
- Agent 4: Create the changelog and documentation updates
Run all 4 in parallel and show me progress.
```

**Powered by:** Agent team orchestration, parallel execution engine, shared checklists

---

### Build Mode & Canvas Workflow

Enter a visual canvas workflow where the agent helps you design, iterate, and refine complex artifacts — documents, architectures, slide decks, or product specs.

**What it handles:**
- Interactive document building with iterative refinement
- Architecture diagram generation and review
- Product spec drafting with stakeholder-specific views
- Presentation outline creation and slide content generation
- Version tracking and diff-based iteration

**Example prompt:**
```
Enter build mode. Let's create a technical design document for our
new authentication system. Start with the requirements, then walk me
through the architecture options. I'll give feedback at each step.
```

**Powered by:** Build mode canvas, document generation tools, iterative workflow engine

---

### AI Playbook & Pattern Capture

Capture successful workflows as reusable playbooks that can be shared, versioned, and triggered by the agent automatically.

**What it handles:**
- Workflow recording — the agent captures steps as you work and saves them as playbooks
- Playbook execution — replay a saved workflow with different inputs
- Template library — share playbooks across team members
- Conditional logic — playbooks can branch based on conditions
- Scheduling — trigger playbooks on a cron schedule or event-driven

**Example prompt:**
```
Record a playbook for our weekly metrics review:
1. Pull this week's analytics from our dashboard
2. Compare with last week and last month
3. Flag any metrics that moved more than 10%
4. Draft a summary for the team Slack channel
Save this as "weekly-metrics-review" and schedule it for Mondays at 9am.
```

**Powered by:** Playbook engine, scheduling, `schedule_task` tool, memory system

---

### Multi-LLM Comparison & Routing

Route tasks to the best model for the job — compare outputs across providers, run A/B tests, and optimize for cost, speed, or quality.

**What it handles:**
- Multi-provider support — Claude, GPT-4, Gemini, Llama, Mistral, DeepSeek, Grok
- Side-by-side output comparison for the same prompt
- Automatic model selection based on task type (coding → Claude, creative → GPT-4)
- Cost tracking and budget management per model
- Latency monitoring and provider failover

**Example prompt:**
```
Compare Claude Sonnet and GPT-4o on this code review task.
Show me both outputs side by side, highlight where they agree and
disagree, and recommend which review I should trust for this PR.
```

**Powered by:** Provider factory, multi-LLM routing, model comparison tools

---

## Cloud Infrastructure as a Service

### Sandboxed Code Execution

Run untrusted code, experiments, or one-off scripts in isolated cloud sandboxes without touching your local machine.

**What it handles:**
- E2B cloud sandbox provisioning — spin up a fresh Linux environment in seconds
- Multi-language execution (Python, Node.js, Rust, Go, etc.)
- File system persistence within sandbox sessions
- Package installation and environment customization
- Output capture with stdout, stderr, and file artifacts

**Example prompt:**
```
Spin up a sandbox and run this Python data pipeline that processes
a 2GB CSV file. Install pandas and duckdb, run the script, and
return the output summary. Don't run this on my local machine.
```

**Powered by:** E2B sandbox MCP, cloud execution tools, file transfer

---

### Domain Registration & DNS

Register domains, manage DNS records, and handle domain transfers — all from natural language commands.

**What it handles:**
- Domain availability search and registration via Namecheap
- DNS record management (A, AAAA, CNAME, MX, TXT, NS)
- SSL certificate status checking
- Domain renewal and expiration monitoring
- Bulk domain operations

**Example prompt:**
```
Check if "myproject.dev" is available. If so, register it and set up
DNS records: A record pointing to 203.0.113.50, MX records for Google
Workspace, and a TXT record for domain verification.
```

**Powered by:** Namecheap MCP connector, DNS management tools

---

### Machine-to-Machine Payments

Enable autonomous agent-to-agent payments using crypto wallets and the x402 protocol — the agent can pay for API calls, services, and resources on your behalf.

**What it handles:**
- USDC wallet management (Coinbase-backed)
- x402 protocol for HTTP-native machine payments
- Automatic micro-payments for API services
- Budget limits and spend tracking per task
- Transaction history and receipt generation

**Example prompt:**
```
Set a $5 budget for this research task. The agent can use x402 payments
to access premium APIs if needed. Show me a receipt when done with
a breakdown of what was spent and where.
```

**Powered by:** Crypto wallet tools, x402 payment protocol, budget management

---

## Everyday Automation

### Food Ordering & Delivery

Browse restaurant menus, place orders, and track deliveries through natural language — no app switching required.

**What it handles:**
- Restaurant search and menu browsing via delivery platforms
- Order placement with customization (dietary preferences, allergies)
- Delivery tracking and ETA monitoring
- Reorder from previous orders
- Group order coordination

**Example prompt:**
```
Order dinner from Foodora: find a Thai restaurant near me that delivers
in under 30 minutes. I want pad thai (medium spice, no peanuts) and
a green curry. Add a drink. Show me the total before confirming.
```

**Powered by:** Foodora MCP, web automation tools, browser agent

---

### Scheduling & Calendar Orchestration

Manage complex scheduling across multiple calendars, find optimal meeting times, and handle timezone coordination automatically.

**What it handles:**
- Multi-calendar conflict detection (Google Calendar, Apple Calendar, Outlook)
- Calendly-style availability sharing
- Timezone-aware meeting coordination for distributed teams
- Recurring event management and optimization
- Travel time buffer calculation between in-person meetings

**Example prompt:**
```
Find a 90-minute slot this week for a team meeting across these 4 people's
calendars. Everyone is in a different timezone (PST, EST, CET, IST).
Propose the top 3 options that fall within each person's working hours.
```

**Powered by:** Google Calendar, Apple Calendar integration, Calendly MCP, scheduling engine

---

### Document Generation & PDF Editing

Generate professional documents, edit existing PDFs, and convert between formats — contracts, invoices, reports, and more.

**What it handles:**
- PDF creation from templates or scratch
- Existing PDF editing — add text, signatures, annotations
- Document format conversion (Markdown → PDF, HTML → DOCX, etc.)
- Invoice and receipt generation with calculated totals
- Batch document processing and merge operations

**Example prompt:**
```
Create a professional invoice PDF for client "Acme Corp":
- 40 hours consulting at $200/hr
- 2 months SaaS license at $500/mo
Apply 10% discount, calculate tax at 19%, and add my company logo.
Save as invoice-2026-02.pdf.
```

**Powered by:** `nano-pdf` tools, document generation, `document-tools`

---

### macOS Desktop Automation

Control your Mac's UI programmatically — click buttons, fill forms, extract screen content, and automate repetitive desktop workflows.

**What it handles:**
- Screen capture and OCR-based UI element detection
- Automated clicking, typing, and form filling in any macOS app
- Application launching and window management
- Accessibility tree inspection for precise element targeting
- Multi-step desktop workflow recording and replay

**Example prompt:**
```
Open System Settings, navigate to Wi-Fi, and tell me the name of the
currently connected network and its signal strength. Then take a
screenshot of the Wi-Fi settings page.
```

**Powered by:** Peekaboo macOS automation, vision tools, `run_command` tool

---

### Translation & Localization

Translate content across languages with context-aware quality — not just word-for-word, but culturally appropriate translations.

**What it handles:**
- Real-time text translation across 100+ languages
- Software localization — translate UI strings, preserve placeholders and formatting
- Document translation with layout preservation
- Translation memory for consistent terminology across projects
- Quality scoring with back-translation verification

**Example prompt:**
```
Translate our app's English strings file (en.json) to Spanish, German,
and Japanese. Preserve all {placeholder} variables. For Japanese, use
polite/formal register. Flag any strings that need cultural adaptation.
```

**Powered by:** Multi-language LLM capabilities, localization tools, file processing

---

## Content Intelligence

### YouTube & Video Analysis

Analyze YouTube videos without watching them — extract transcripts, summarize content, identify key moments, and generate derivative content.

**What it handles:**
- YouTube transcript extraction and summarization
- Key moment identification with timestamps
- Video content comparison (e.g., "How does video A's advice differ from B?")
- Blog post or thread generation from video content
- Channel analysis and content trend identification

**Example prompt:**
```
Analyze this YouTube video: [URL]. Extract the transcript, summarize
the key points in 5 bullets, identify the 3 most important moments
with timestamps, and draft a Twitter thread based on the content.
```

**Powered by:** YouTube transcript tools, content analysis, writing agent

---

### Blog & RSS Monitoring

Monitor blogs, RSS feeds, and news sources for specific topics. Get daily digests or real-time alerts when relevant content is published.

**What it handles:**
- RSS/Atom feed aggregation and monitoring
- Topic-based filtering and relevance scoring
- Daily/weekly digest generation with summaries
- Competitive blog monitoring (track what competitors publish)
- Trend detection across multiple sources

**Example prompt:**
```
Monitor these 10 tech blogs for any posts about "AI agents" or "LLM tooling".
Check daily and send me a digest with title, link, and 2-sentence summary
for each new post. Flag anything that mentions our competitors.
```

**Powered by:** Web research tools, RSS parsing, scheduling engine, `web_search` tool

---

### Content Humanization

Review AI-generated content and rewrite it to sound naturally human — remove telltale patterns, vary sentence structure, and match a target voice.

**What it handles:**
- AI-pattern detection (overused transitions, formulaic structure, hedge phrases)
- Voice matching — adapt content to match your existing writing style
- Sentence structure variation and rhythm improvement
- Cliché and filler word removal
- Before/after comparison with change annotations

**Example prompt:**
```
Here's a blog post draft that sounds too AI-generated. Rewrite it to
match the voice in my previous 3 blog posts (attached). Remove AI-isms,
vary the sentence length, and make it sound like I actually wrote it.
Show me what you changed.
```

**Powered by:** Writing analysis tools, style matching, content refinement agent

---

### Competitive Research & Idea Validation

Validate business ideas, analyze competitive landscapes, and generate market intelligence reports from public data.

**What it handles:**
- Competitor feature matrix generation
- Market sizing and TAM/SAM/SOM estimation
- Product-market fit signal analysis
- Pricing strategy comparison
- SWOT analysis with data-backed evidence

**Example prompt:**
```
Research the AI code assistant market. Map the top 10 competitors,
their pricing, key features, funding, and team size.
Build a feature comparison matrix and identify underserved niches.
Rate the attractiveness of entering with a [specific angle].
```

**Powered by:** Web research tools, analytical agent, market analysis skills

---

## Capability Summary

| Category | Capabilities | Key Skills & Connectors |
|----------|-------------|------------------------|
| **Software Engineering** | Code gen, review, debugging, tests, docs, deps | Coding agent, Engineering pack, 20+ skills |
| **DevOps & Infra** | K8s, Terraform, Docker, CI/CD, cloud migration, incidents | DevOps pack (8 skills), `run_command` tool |
| **Mobile Development** | iOS (SwiftUI), Android (Compose), React Native, Fastlane | Mobile Development pack, iOS/Android skills |
| **Game Development** | Unity, Unreal, Godot, cross-engine performance | Game Development pack, 3 engine skills |
| **Enterprise** | Salesforce, Jira, Discord, Slack, Zendesk, HubSpot | 10 MCP connectors |
| **Data & Analytics** | CSV analysis, SQL, financial modeling, market screening | Data Analysis pack, 8+ financial skills |
| **Content & Marketing** | Blog, social, email campaigns, SEO, copywriting | Marketing pack, marketing strategist skill |
| **Personal Productivity** | Briefings, inbox, multi-channel messaging, task capture | 14 channels, scheduling, 10+ productivity skills |
| **Team & Management** | Sprints, 1-on-1 prep, status reports, digital twins | EM pack, PM pack, 10 persona templates |
| **Security** | Vulnerability scanning, compliance, dependency auditing | Security audit skill, dependency check skill |
| **Remote Ops** | Chat-driven deployment, headless mode, WebSocket API | Gateway, headless daemon, remote access |
| **Voice & Audio** | Calls, TTS, STT, dictation, music/speaker control | ElevenLabs MCP, Whisper, Spotify/Sonos/BluOS MCP |
| **Smart Home & IoT** | Lighting, sleep devices, cameras, ambiance scenes | OpenHue MCP, Eight Sleep MCP, RTSP/ONVIF tools |
| **Financial Intelligence** | Risk analysis, tax planning, crypto, CFO modeling, ESG | 8 financial skills, ccxt MCP, Wealth Management pack |
| **Knowledge & Notes** | Apple Notes, knowledge graph, memory, deep research | Memory service, FTS5 index, scratchpad tools |
| **AI Agent Ecosystem** | Agent teams, build mode, playbooks, multi-LLM routing | Orchestration engine, provider factory, playbook engine |
| **Cloud Infrastructure** | Sandboxed execution, domain registration, crypto payments | E2B MCP, Namecheap MCP, x402 protocol |
| **Everyday Automation** | Food ordering, scheduling, PDF editing, desktop control | Foodora MCP, Calendly MCP, nano-pdf, Peekaboo |
| **Content Intelligence** | Video analysis, blog monitoring, humanization, research | YouTube tools, RSS parsing, web research, style matching |

---

## Further Reading

- [Getting Started](getting-started.md) — First-time setup
- [Features](features.md) — Complete feature reference
- [Plugin Packs](plugin-packs.md) — Browse and configure plugin packs
- [Channels](channels.md) — Messaging channel setup
- [Enterprise Connectors](enterprise-connectors.md) — MCP connector development
- [Digital Twins](digital-twins.md) — Role-based AI twin personas
- [Test Prompts](use-cases.md) — Copy-paste prompts for end-to-end validation
