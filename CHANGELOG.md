# Changelog

All notable changes to CoWork OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **DuckDuckGo free search fallback**: built-in web search provider that requires no API key. Works out of the box by scraping DuckDuckGo's HTML endpoint. Automatically used as a last-resort fallback when paid providers fail or are not configured. The `web_search` tool is now always available — users no longer need to configure a search provider to use web search. Supports web search with region and date range filters. Configured providers still take priority; DuckDuckGo is appended at the end of the fallback chain.
- **Discord MCP Connector**: full REST API connector for Discord Bot management with 19 tools — guild listing, channel CRUD, message sending with rich embed support, thread creation, role CRUD, reactions, webhooks, and member listing. Includes 429 rate-limit retry (2 attempts, 10s cap), 2000-char message validation, embed schema enforcement (10 embeds max, typed fields), and privileged intent error hints for `list_members` and `get_messages`. Configurable in Settings > Connectors with bot token, application ID, and optional default guild ID.
- **Mobile Development plugin pack**: new bundled pack with 4 skills (React Native setup, iOS development, Android development, build pipeline) and a mobile-developer agent role. Covers SwiftUI, Jetpack Compose, Fastlane, code signing, and simulator/emulator management.
- **Game Development plugin pack**: new bundled pack with 4 skills (Unity, Unreal Engine, Godot, cross-engine performance) and a game-developer agent role. Covers C#/MonoBehaviour, C++/Blueprints, GDScript, draw call optimization, LOD, and GPU profiling.
- **iOS Development skill**: deep standalone skill covering SwiftUI, UIKit, @Observable, SwiftData/Core Data, async/await, push notifications, `xcodebuild`, `xcrun simctl`, code signing, and App Store submission.
- **Android Development skill**: deep standalone skill covering Jetpack Compose, ViewModel, Room, Retrofit, Hilt, Coroutines/Flow, Gradle builds, ADB, ProGuard/R8, and Play Store submission.
- **Unity Development skill**: standalone skill for Unity/C# — MonoBehaviour lifecycle, ScriptableObjects, Addressables, object pooling, Shader Graph, UI Toolkit, editor scripting, and Unity CLI batch builds.
- **Unreal Engine Development skill**: standalone skill for UE5/C++ — Gameplay Framework, Enhanced Input, UCLASS/UPROPERTY/UFUNCTION macros, Niagara, Lumen/Nanite, multiplayer replication, and UnrealBuildTool packaging.
- **Game Performance Optimization skill**: cross-engine standalone skill covering draw call batching, LOD configuration, occlusion culling, texture optimization, object pooling, memory budgets, and platform-specific tuning (mobile/PC/console).
- **Terraform Operations skill**: comprehensive IaC skill for `terraform init/plan/apply/destroy`, state management, module development, workspace management, backend configuration, drift detection, and provider patterns.
- **Kubernetes Operations skill**: comprehensive skill for `kubectl` operations, manifest generation (Deployment, Service, Ingress, ConfigMap, Secret, HPA), Helm charts, RBAC, NetworkPolicy, kustomize overlays, and debugging workflows.
- **Cloud Migration skill**: migration playbook covering the 6 Rs assessment framework, database migration strategies, network migration, cost estimation, cutover planning, rollback procedures, and multi-cloud patterns.
- **Docker Compose Operations skill**: skill for Docker Compose v2 commands, Compose file authoring, multi-stage builds, health checks, override patterns, environment management, and production vs dev configurations.
- **Enhanced DevOps plugin pack (v1.1.0)**: added 4 new inline IaC skills (Terraform plan review, Kubernetes manifest generation, cloud migration assessment, Docker Compose file generation) and expanded keywords for infrastructure-as-code discovery.
- **Proactive session compaction with structured summaries**: context compaction now triggers proactively at 90% utilization (aligned with Codex CLI) instead of waiting for overflow. Generates comprehensive, Claude-Code-style structured summaries (up to 4096 tokens) covering user messages, work completed, errors/fixes, decisions, pending tasks, and recommended next steps. Uses role-aware transcript formatting (user messages get 3x more room than tool results), Codex-style "handoff to another LLM" framing, model-aware budget scaling (safe for small-context models), and an overflow guard to prevent the summary from re-inflating context. Timeline UI renders summaries as collapsible sections with token-freed stats.
- **Polymarket prediction market skill**: query odds, trending markets, price momentum, orderbook depth, open interest, trade history, and resolution timelines across Gamma, CLOB, and Data APIs — no authentication required. Includes formatted output with percentages, volume breakdowns, and multi-outcome event support.
- **Humanizer writing skill**: rewrite AI-generated text to sound natural and human-written. Detects and removes 50+ LLM tells across 7 layers — vocabulary, sentence mechanics, paragraph structure, emotional register, content depth, document architecture, and tone. Includes flagged word lists, 6 tone presets (casual, professional, academic, journalistic, technical, warm), and a systematic 7-step rewriting process.
- **YouTube video intelligence skill**: fetch transcripts, metadata, chapters, and captions from YouTube videos via yt-dlp or youtube-transcript-api. Supports auto-generated and manual captions, multi-language, translation, audio extraction, playlists, and timestamp deep links. Includes 6 workflow recipes (summarize, search, compare, extract resources, blog conversion, key quotes).
- **Stock analysis skill**: comprehensive market intelligence across 3 data sources (Yahoo Finance API, yfinance, Alpha Vantage). Covers real-time quotes, 60+ fundamental metrics, 50+ technical indicators, financial statements, earnings, options chains, analyst ratings, institutional holders, dividends, stock screening, and an 8-dimensional scoring framework. Supports stocks, ETFs, indices, crypto, and forex.
- **Calendly scheduling skill**: manage Calendly via the v2 API with Personal Access Token auth. Covers event types, scheduled events (upcoming/past/cancelled), invitees with custom Q&A and UTM tracking, availability schedules and busy times, cancellation with reasons, no-show management, one-off booking links, webhooks, and organization members. Includes 8 workflow recipes and timezone-aware agenda formatting.
- **Moltbook agent social network skill**: interact with Moltbook — the social network for AI agents. Post content, reply to discussions, browse feeds (hot/new/top/rising), upvote/downvote, join submolt communities, follow agents, search semantically, and track engagement via the home dashboard. Includes agent registration, verification challenge solving, rate limit awareness, and formatted feed output.
- **Marketing Strategist skill**: comprehensive marketing strategy across 25 disciplines — positioning, messaging frameworks (StoryBrand, JTBD, Category Design), buyer psychology (Cialdini's 7 principles, 10 cognitive biases), 5 copywriting frameworks (PAS, AIDA, BAB, 4Ps, FAB), SEO (on-page checklist, technical audit, keyword research, link building), landing page CRO (above-the-fold formula, 10-item checklist, A/B testing methodology), paid ads (Google, Meta, LinkedIn with platform-specific guidance), funnel architecture with lead magnet ranking and nurture sequences, analytics and attribution models, pricing psychology, product launch playbook, growth loops and referral design, competitive intelligence templates, and marketing operations. Includes 8 workflow recipes and integrates with existing channel-specific skills.
- **OpenAI-Compatible as built-in LLM provider**: promoted from custom provider to first-class built-in provider with dedicated settings panel, SSRF-safe base URL validation (blocks private/metadata IPs, DNS rebinding), model list fetching, and automatic migration from legacy custom provider config. Configurable in Settings > AI Model.
- **Task continuation after turn-limit exhaustion**: failed tasks stopped by the global turn limit now show a "Continue" button in the timeline. Clicking it reconstructs the executor from persisted events, resets budgets, and resumes execution from the last plan checkpoint. Respects concurrency limits — overflow continuations are queued and resume automatically when a slot opens.
- **Step-level user feedback**: users can now interact with in-progress plan steps via retry, skip, stop, or redirect ("drift") actions. Feedback controls appear in both the timeline view and the bubble view on actively running steps. Skipped steps are marked with a new `skipped` status and the executor advances to the next step.
- **Tool allow-list for child tasks**: parent tasks can now specify an `allowedTools` list in `agentConfig`. When both parent and child define allow-lists, the child receives the intersection — preventing privilege escalation. An empty intersection throws a clear error at child task creation.
- **LoreService (shared workspace history)**: new service that auto-records milestones from completed tasks into `.cowork/LORE.md`. Entries are debounced, deduplicated, capped at 40, and written into the `<!-- cowork:auto:lore:start -->` marked section. Rebuilds from recent task history on startup.
- **VIBES.md workspace kit file**: new `.cowork/VIBES.md` for tracking current workspace energy and mode (e.g., crunch, deep-focus, balanced). Loaded before SOUL.md in agent context so current vibes influence personality interpretation. Auto-updated by agents based on cues.
- **LORE.md workspace kit file**: new `.cowork/LORE.md` for shared history between user and agent. Milestones section is auto-populated by LoreService. Loaded after MISTAKES.md and before daily logs in agent context.
- **Low-progress loop detection**: detects agents stuck repeatedly probing the same target with mixed tools (≥6 of last 8 calls on same base target across ≥2 tool categories). Injects a course-correction nudge, then escalates to a final warning if looping persists.
- **Stop-reason nudge**: detects consecutive `tool_use` stops (≥6) or `max_tokens` stops (≥2) and injects a message telling the agent to wrap up and produce a direct answer.
- **Turn-budget guard for max_tokens recovery**: max_tokens retry is now skipped when insufficient turns remain in the budget, preventing wasted turns on truncated responses that can't be completed.
- **MCP server tools in context panel**: the active context data now includes tool names from connected MCP servers, giving the UI visibility into what tools each connector provides.

### Changed
- **Task queue limits raised**: default concurrent tasks increased from 5 → 8, max configurable ceiling raised from 10 → 20, default timeout increased from 30 → 60 minutes. Existing users who never changed their settings are automatically upgraded to the new defaults.
- **Sub-agent safety cap**: sub-agents that bypass the normal concurrency limit are now capped at 40 total running tasks (2× max configurable) to prevent runaway resource consumption.
- **Resumed tasks respect concurrency**: tasks resuming after app restart now respect the concurrency limit instead of all starting simultaneously. Overflow tasks are re-queued at the front and start as slots open.
- **Memory kit skill updated**: VIBES.md and LORE.md templates added to the memory-kit skill. Bootstrap guide updated with steps for reviewing vibes and lore files.
- **HeartbeatService singleton**: HeartbeatService now exposes `getHeartbeatService()` / `setHeartbeatService()` for global access without passing references through the dependency chain.
- **PlanStep status**: plan steps now support a `skipped` status in addition to pending, in_progress, completed, and failed.
- **Codebase formatting**: applied oxfmt across ~40 renderer components, IPC handlers, extensions, tray modules, and utility files for consistent line wrapping and indentation.

### Fixed
- **Focused mode tabs**: Mission Control now correctly included in focused mode tab list.

## [0.3.91] - 2026-02-24

### Added
- **Agent-initiated memory (`memory_save` tool)**: agents can now explicitly save observations, decisions, insights, and errors to the workspace memory database during task execution. Memories are persisted across sessions and recalled via hybrid search in future tasks. Respects workspace memory settings, privacy modes, and sensitive data filtering.
- **Enhanced `search_memories`**: now searches both the memory database AND `.cowork/` workspace markdown files (MEMORY.md, daily logs, project contexts, etc.). Results are merged, deduplicated, and ranked by relevance. Response includes `source` ("db" or "markdown") and file `path` for markdown hits.
- **Web Scraping (Scrapling integration)**: new scraping subsystem powered by [Scrapling](https://github.com/D4Vinci/Scrapling) with anti-bot bypass, stealth browsing, and structured data extraction. Five new agent tools: `scrape_page` (single URL with TLS fingerprinting, Cloudflare bypass, stealth mode), `scrape_multiple` (batch scrape up to 20 URLs), `scrape_extract` (structured data — tables, lists, headings, metadata), `scrape_session` (multi-step persistent sessions for login→navigate→extract workflows), and `scraping_status` (installation check). Python bridge architecture via stdin/stdout JSON. Configurable fetcher modes (default/stealth/playwright), proxy support, rate limiting, and headless toggle. Settings UI at Settings > Web Scraping. Five new skills: `web-scraper`, `price-tracker`, `site-mapper`, `lead-scraper`, `content-monitor`.
- **"Think With Me" Socratic mode**: new `think` conversation mode for brainstorming and decision-making without tool execution. Activated via "Think with me" toggle or detected automatically from brainstorm/trade-off/pros-and-cons patterns. Uses Socratic system prompt with read-only tools.
- **Problem framing pre-flight**: complex execution tasks now show a structured restatement of the problem, assumptions, risks, and proposed approach before diving into tool execution. Triggered by intent complexity scoring (prompt length, action verb count, multi-step signals).
- **Task complexity scoring**: `IntentRoute` now includes a `complexity` field (`low | medium | high`) used to gate pre-flight and other adaptive behaviors.
- **Graceful uncertainty messaging**: system prompt now instructs the agent to express uncertainty honestly, rate confidence on recommendations, and never fabricate tool outputs. Assistant messages with `[Low confidence]` markers render with an amber indicator.
- **AI Playbook (personal patterns)**: auto-captures "what worked" patterns from completed tasks (approach, outcome, tools used) and lessons from failures. Relevant playbook entries are injected into system prompts. Viewable in Settings > AI Playbook.
- **Proactive daily briefing**: morning briefing combining task stats (completed, in-progress, scheduled), recent memory highlights, and goal-based suggested priorities. Auto-creates a disabled cron job on first workspace load; configurable in Settings > Scheduled Tasks.
- **Build Mode with enhanced canvas**: dedicated "idea → working prototype" workflow powered by Canvas with four phases (Concept → Plan → Scaffold → Iterate). Includes named phase checkpoints, phase timeline, revert-to-phase, and diff-between-phases support.
- **Canvas named checkpoints**: `findCheckpointByLabel()` and `diffCheckpoints()` methods on CanvasManager for labeled checkpoint lookup and file-level comparison between any two checkpoints.
- **Persistent multi-agent teams**: teams can now be marked as `persistent` with a `defaultWorkspaceId`, surviving across sessions. Includes `listPersistent()` repository method, DB migration, and UI toggle with badge in Agent Teams panel.
- **Weekly Usage Insights dashboard**: new Settings > Usage Insights panel showing task metrics, cost/token tracking by model, activity heatmap by day-of-week and hour, and top skills usage. Supports 7/14/30-day period selection.
- **Starter mission templates**: expanded from 3 onboarding suggestions to 10 one-click missions with categories. Displayed in onboarding and on the empty-state welcome screen.
- **Competitive research skills**: new `competitive-research.json` and `idea-validation.json` skill files for market analysis, competitor scanning, and MVP scoping.
- **Plain-language settings labels**: renamed jargon in Settings sidebar (MCP Servers → Connected Tools, Guardrails → Safety Limits, LLM Provider → AI Model, Control Plane → Remote Access, SkillHub → Skill Store). Technical names preserved in tooltips.
- **Native Infrastructure tools**: built-in cloud sandbox (E2B), domain registration (Namecheap), crypto wallet (USDC on Base), and x402 payment protocol support — all registered as native agent tools with no external MCP subprocess. Configurable in Settings > Infrastructure.
- **Dispatched Agents Progress Panel**: when a task mentions agents (e.g. `@Security Analyst`), the parent task's main window now shows a Collab-mode-style progress panel with agent chips, phase indicator (Dispatched → Working → Complete), and a real-time event stream from all child agent tasks. Click any agent chip to navigate to its full task view.
- **`userPrompt` field on Task**: child tasks dispatched to agents now store the original user prompt separately, so the UI displays the user's actual request instead of the internal agent-dispatch formatting.
- **Digital Twin (Persona Templates)**: create role-specific AI digital twins from 10 pre-built templates across 5 categories (Engineering, Management, Product, Data & Analytics, Operations). Each template includes a tailored system prompt, capabilities, proactive heartbeat tasks, cognitive offload categories, and recommended skills. Templates: Software Engineer, Hardware Engineer, QA/Test Engineer, DevOps/SRE, Technical Writer, Engineering Manager, Technical Director, VP Engineering, Product Manager, and Data Scientist. Activation flow: browse gallery → customize name/heartbeat/tasks → create twin as a new AgentRole with background proactive tasks. Accessible via "Add Digital Twin" button in Mission Control agents panel.
- **Knowledge graph system**: FTS5 search and graph traversal for structured knowledge representation.
- **Twitter/X content writer skill**.
- **Proactive suggestions service** with edge case handling.

### Changed
- **Execution strategy orchestration** in daemon lifecycle: strategy derivation at task creation, runtime strategy re-application for queued/legacy tasks, relationship-memory outcome recording on top-level task completion.
- **Friendlier error messages, mode hints, and settings grouping** across the UI.

### Fixed
- **Task cancellation now cascades to child tasks**: stopping a parent task also cancels all dispatched agent sub-tasks instead of leaving them running.
- **TypeScript errors in scraping tools** resolved.
- **Wrap-up skips synthesis phase** due to premature phase transition.
- **Task cancellation spinner** stays active after cancel (fixed).
- **Collapsed sidebar header padding** adjusted for new session button.

## [0.3.90] - 2026-02-23

### Added
- **Collaborative mode**: multi-agent collaborative thoughts and capability matching.
- **Multi-LLM orchestration**: config validation and comparison service for running multiple LLM providers.
- **Git worktree manager**: worktree isolation for parallel agent branches with comparison service.
- **Git tools**: new agent tools for git operations.
- **Task pinning**: pin important tasks for quick access.
- **Anthropic streaming**: streaming support with progress callbacks for Anthropic provider.
- **Bedrock as vision provider** for `analyze_image` tool.
- **Crypto trading and email marketing skill definitions**.

### Changed
- **Action-first planning**: executor enhanced with resourcefulness and companion identity.
- **Context summarization events** surfaced in task timeline.
- **Image attachment support** for task creation and follow-ups.
- **Bedrock display names**: improved formatting, model ID parsing, and AP region regex fix.

## [0.3.89] - 2026-02-20

### Added
- **Declarative plugin system**: connectors, skills, and agent roles defined via JSON manifests.
- **Built-in plugin packs**: pre-configured plugin bundles for common workflows.
- **Slash command autocomplete** in input areas.
- **`create_spreadsheet` and `create_presentation` tool support** for agents.
- **Inline spreadsheet preview** in task view.

### Changed
- **Sonnet 4.6 model**: added as new model option and updated as Bedrock default.
- **Oxfmt formatter** and promoted Oxlint rules to errors.
- **Conway Terminal**: auto-provision API key and inject into MCP server env.
- **Model selector redesign** and defensive electronAPI guards.

### Fixed
- **Bedrock transcript mismatches**: repaired and preserved tool-call pairs during compaction.
- **Follow-up error handling**: prevent pinned message insertion between tool pairs.
- **Electron sandbox**: disabled for preload and hardened attachment validation.

## [0.3.88] - 2026-02-19

### Added
- **Vision/image support** across all LLM providers.
- **LOOM email protocol** support alongside IMAP/SMTP.
- **Conway Terminal integration** with payment safety caps.
- **Adaptive complexity (power user toggle)**: three-tier UI density (`focused | standard | power`) controlling which settings tabs and features are visible. Focused mode hides advanced settings; power mode shows everything.
- **Validation schemas and config sanitization** for security hardening.

### Changed
- **Executor enhanced** with image attachments and tool approval flow.
- **Email settings, toast positioning, XLSX viewer, and styling** improvements.
- **Contextual welcome cards** in the UI.

### Fixed
- **Electron env variable handling** and strict dev port configuration.

## [0.3.87] - 2026-02-17

### Added
- **Intent-routed task strategy runtime**: tasks are now classified into `chat`, `advice`, `planning`, `execution`, or `mixed` and receive derived strategy defaults (conversation mode, turns, quality passes, answer-first flags).
- **Relationship memory lifecycle APIs**: added relationship memory and commitment IPC/preload surfaces:
  - `memory:relationshipList`
  - `memory:relationshipUpdate`
  - `memory:relationshipDelete`
  - `memory:commitmentsGet`
  - `memory:commitmentsDueSoon`
- **Relationship memory UI controls** in Memory Settings for edit/forget and commitment status management.
- **Dedicated relationship-agent architecture + UAT docs**:
  - `docs/relationship-agent-architecture.md`
  - `docs/relationship-agent-uat.md`
- **XLSX file extraction** and auto-generate missing hooks token.
- **Attachment chips** in chat bubbles and collapsible toggle fix.
- **Use-case skill templates** and Pi finder/librarian skills.
- **Resend email connector** and expanded gateway router commands.

### Changed
- **Execution strategy orchestration** in daemon lifecycle: strategy derivation at task creation, runtime strategy re-application for queued/legacy tasks, relationship-memory outcome recording on top-level task completion.
- **Memory context composition** now combines `UserProfileService` facts with layered relationship memory context for prompt injection.
- **Soft-deadline behavior** in executor now switches from deep step execution to best-effort finalization before hard timeout.
- **Approval modal replaced** with centered notification toasts and session approve-all.
- **MCP connectors** kept disabled until configured.

### Fixed
- **Timeout-abort completion gap**: timeout-triggered cancellation paths now attempt best-effort finalization instead of exiting without a user-facing answer.
- **Cancellation observability**: executor cancellation logs now include cancellation reason (`user`, `timeout`, `shutdown`, etc.) for clearer diagnosis.
- **Stuck 'executing' status**: prevented with varied failure loop detection and improved artifact handling.
- **Slack socket stability** and WhatsApp connection flap detection.
- **Max iterations** increased for complex agent operations.
- **User name rules** strengthened to prevent OS username leakage.

## [0.3.86] - 2026-02-14

### Added
- **ACP and Canvas control-plane endpoints**: introduced ACP task-delegation handlers and new canvas APIs (`canvas.list/get/snapshot/content/push/eval/checkpoint.*`) with corresponding protocol constants and IPC wiring.
- **Canvas checkpoint tooling**: added `canvas_checkpoint`, `canvas_restore`, and `canvas_checkpoints` tools, plus in-memory checkpoint history and restore flows in `CanvasManager`.
- **Renderer i18n support**: added language resources and UI selection for English, Japanese, and Simplified Chinese, with persisted language preference.
- **Talk Mode UX**: introduced continuous voice talk-mode hook and UI controls for conversational voice interaction in main task view.

### Changed
- **Agent execution flow hardening**: executor now emits long-running tool heartbeats, tracks recovered failures more precisely, and preflights shell-permission requirements when command execution is required.
- **Shell approvals and safety**: `run_command` now supports single-approval bundle mode for safe command sequences and normalizes signatures more robustly for duplicate detection.
- **Gateway routing extensibility**: router now supports channel-level `defaultAgentRoleId`, `defaultWorkspaceId`, and `allowedAgentRoleIds`, plus new `set_agent` router-rule action.
- **Skill registry backend**: default registry now points to GitHub static catalog mode with client-side cached search and static skill fetch/install paths.
- **Plugin discovery behavior**: plugin registry initializes at startup and supports incremental discovery of newly-added plugins without full re-init.

### Fixed
- **Sensitive shell output leakage**: command output now redacts seed phrases and private-key material before logging/model context.
- **Isolated macOS install keychain prompt safety**: added `COWORK_DISABLE_OS_KEYCHAIN=1` path to bypass OS keychain integration in disposable test environments.
- **Task activity signaling in UI**: task “working” indicators now consider tool calls/results and tool-execution progress heartbeats, reducing false idle states.
- **Install reliability carry-forward**: retains prior setup retry behavior and low-memory setup defaults while validating clean first-install flow.

## [0.3.85] - 2026-02-14

### Fixed
- **Hoisted Electron detection in setup**: `npm run setup` now treats `../electron` as valid in npm-hoisted installs, so first-time setup no longer triggers unnecessary full dependency bootstrap.
- **Native setup install scope**: missing `better-sqlite3` recovery and rebuild now run from the actual install root (not inside `node_modules/cowork-os`), reducing first-run reify pressure that caused frequent macOS `SIGKILL`.
- **Release publish gating**: npm/GitHub package publish jobs now depend on the release validation job, and smoke tests fail if setup unexpectedly falls back to dependency bootstrap.
- **Install docs hardening**: README now includes a direct native retry-wrapper fallback when `npm run --prefix node_modules/cowork-os setup` is terminated by `zsh: killed`, and recommends local bin launch over `npx` for first run.

## [0.3.84] - 2026-02-14

### Fixed
- **Release smoke-test module resolution**: installability validation now runs Electron with `cwd` set to the installed `cowork-os` package directory so `require('better-sqlite3')` resolves correctly after setup.
- **Release continuity**: keeps the 0.3.82 npm SIGKILL regression fix while restoring end-to-end GitHub release packaging path after CI validation.

## [0.3.83] - 2026-02-14

### Fixed
- **Release workflow syntax fix**: corrected the installability smoke-test shell step so the release pipeline no longer exits with `syntax error: unexpected end of file` before desktop packaging.
- **Release continuity**: preserves the 0.3.82 npm SIGKILL fix while restoring full GitHub release asset publishing (DMG/ZIP).

## [0.3.82] - 2026-02-14

### Fixed
- **SIGKILL regression fix for npm installs**: `setup_native` no longer uses `npm install --ignore-scripts=false` when recovering missing `better-sqlite3`, preventing `electron-winstaller` lifecycle scripts from being executed during first-time setup.
- **Recovery install hardening**: missing runtime dependency repair now uses `--omit=dev` and `--package-lock=false` to avoid reifying packaging/dev dependency trees in user runtime installs.

## [0.3.81] - 2026-02-14

### Fixed
- **README install path hardening**: `npm run setup` now skips a full dependency reinstall when the Electron dependency is already present, so fresh `/tmp` installs avoid avoidable reinstall-driven SIGKILL pressure.
- **Native setup reliability**: restores the 0.3.71-style flow with retryable native setup and keeps `better-sqlite3` installation script-safe, then rebuilds it explicitly against Electron ABI.

## [0.3.80] - 2026-02-14

### Fixed
- **macOS install reliability hardening**: setup now skips optional dependency reinstall during `npm run setup`, avoids propagating child SIGKILL events from native setup back to the shell, and documents a first-install flow that avoids macOS-terminating paths.
- **Release validation hardening**: CI now resolves release metadata before install validation and validates installability from either published npm tarball (if already published) or local `npm pack` fallback, preventing release regressions for first-release tags.

## [0.3.79] - 2026-02-14

### Fixed
- **macOS install reliability carry-forward**: retained the 0.3.71 SIGKILL workaround for first-time users by documenting and reinforcing the `npm install --ignore-scripts` + `npm run --prefix node_modules/cowork-os setup` flow.
- **Release workflow hardening**: ensured the macOS release job always creates or reopens the GitHub release as a draft before packaging so `electron-builder` can attach DMG/zip assets without immutable-release failures.
- **Version alignment**: published metadata now identifies this release as `0.3.79` with the same installability and packaging reliability changes.

## [0.3.78] - 2026-02-14

### Fixed
- **Release build hardening**: restored the missing `src/electron/agent/executor-helpers.ts` source file so builds can resolve `executor.ts` imports after packaging from a fresh clone.
- **TypeScript strictness fixes**: fixed implicit `any` errors in `executor.ts` that could break release builds on CI.
- **TLS fingerprint callback typing fix**: aligned `remote-client.ts` callback signature/type usage with current `ws` client typings to satisfy strict build checks.

## [0.3.77] - 2026-02-14

### Fixed
- **Setup script safety**: `npm run setup` in a fresh install now runs dependency reinstall with `--ignore-scripts` so optional postinstall hooks like `electron-winstaller` cannot SIGKILL the process during first-run recovery on macOS.
- **Install reliability carry-forward**: this patch keeps the documented `/tmp` first-install sequence intact while ensuring setup stays stable across npm install layouts.
- **Version alignment**: published metadata is now aligned on `0.3.77` so the installability fix is included in both npm and GitHub release tracks.

## [0.3.76] - 2026-02-14

### Fixed
- **Installability restoration**: pinned `electron` to `40.2.1` so first-time installs from `npm` pull the known-good Electron patch and avoid `SIGKILL` during `node_modules/electron/install.js` on affected macOS environments.
- **README alignment**: clarified the first-time CLI install path to reflect the exact commands users should run from a fresh temporary folder.

## [0.3.75] - 2026-02-14

### Fixed
- **Installability fix from 0.3.71**: restored Electron lockfile behavior by keeping `electron` at `40.2.1` during publish-time installs, matching the working `0.3.71` state and avoiding default `SIGKILL` during `node_modules/electron/install.js` on affected installs.

## [0.3.74] - 2026-02-14

### Fixed
- **Release pipeline reliability**: updated the GitHub release publish step to find and publish the tag created by `electron-builder` instead of assuming the trigger ref matches exactly.
- **Release docs/notes alignment**: updated release notes and README "What’s new" section for `0.3.74` to reflect install and CI reliability fixes.
- **Release artifact consistency**: ensured workflow publishes desktop artifacts and release notes from the same release tag path used by electron packaging.

## [0.3.73] - 2026-02-14

### Fixed
- **Release pipeline fix**: included daemon TypeScript sources in shared ESLint targets so `npm run lint` runs instead of failing with parse errors before build/publish steps.
- **Workspace/task validation fix**: enforced `PersonalityId` validation for task agent configs to prevent runtime/inference mismatches during task creation.
- **CLI and release install tests alignment**: updated control-plane and skill validation tests to match current runtime behaviors and skill metadata output.
- **Workspace preflight reliability**: stabilized ambiguous temp-task auto-switch behavior when project-signals are present and tests now validate that behavior.

## [0.3.72] - 2026-02-14

### Added
- **Session workspace isolation and cleanup**: temp tasks now get session-scoped workspace IDs, dedicated temp directories, and automatic pruning by age + usage caps.
- **Autonomous task mode** in execution flow and control-plane/web-UI paths, with optional bypass of interactive approval prompts where explicitly enabled.
- **Companion-mode handling for short conversational prompts** to return concise check-in responses without running task pipeline when appropriate.
- **Search execution ordering** now prefers Brave when available and can safely fallback through configured providers automatically.
- **PDF parsing compatibility wrapper** with runtime-safe handling for both legacy and v2 parser module shapes.

### Changed
- **Task completion validation tightened** with final-response contracts (required direct answers, artifact checks, verification evidence).
- **Stricter tool failure handling** for hard/unavailable/disallowed outcomes to prevent false completion without real progress.
- **Temporary workspace handling** now uses explicit session-aware IDs and filters temp workspaces from user-visible lists consistently.
- **Search and file tools** now enforce more bounded scanning behavior and clearer fallback behavior under high-load conditions.

### Fixed
- **Watch/skip recommendation tasks** now block artifact tools and require direct recommendation output.
- **Intermittent approval/partial-task updates** reduced by normalizing auto-approved events in UI and task-stream handling.
- **Temp workspace lifecycle reliability** improved through scheduled pruning and safer restore/create paths.

## [0.3.69] - 2026-02-11

### Fixed
- `npm install -g cowork-os` could fail on macOS with `fsevents` (`binding.gyp not found`) due an npm 11 rebuild edge case triggered by `playwright`.
- Switched runtime browser dependency to `playwright-core` via npm alias (`playwright` package name preserved in code) to avoid the failing `fsevents` install path.
- Added launcher self-heal: on first run, `cowork-os` now verifies direct runtime dependencies and repairs missing packages with a script-free npm install pass before boot.
- Moved `@types/jszip` to `devDependencies` and excluded `@types/*` from runtime dependency checks to avoid unnecessary first-run repair installs.
- Moved `@electron/rebuild` to runtime dependencies so native fallback rebuild works in npm-installed environments.
- Fixed native setup fallback to locate `@electron/rebuild` via package exports (instead of resolving blocked subpaths), so fallback rebuild actually runs when needed.
- `cowork-os` first run now uses the shell retry wrapper for native setup, reducing one-shot startup failures when macOS kills a setup attempt under memory pressure.

## [0.3.68] - 2026-02-11

### Fixed
- `cowork-os` CLI startup could still fail with `better-sqlite3` ABI mismatch on first launch.
- Launcher now validates `better-sqlite3` by opening an in-memory database (not just requiring the module) and runs native setup when needed.
- Native setup script now resolves hoisted dependencies correctly (Electron and `better-sqlite3`) so it works in npm-installed layouts.

## [0.3.67] - 2026-02-11

### Added
- Added npm CLI command support: `cowork-os`, `coworkctl`, `coworkd`, and `coworkd-node`.

### Fixed
- Fixed launcher script to resolve the Electron binary correctly (`require('electron')` instead of `require.resolve`).
- Included `dist/` in published npm files so the `cowork-os` command can start without requiring a local build step.
- Moved `electron` to runtime dependencies so CLI launch works after normal npm install.

## [0.3.66] - 2026-02-11

### Fixed
- `npm ci` could hang indefinitely in CI due an `overrides.undici` resolution loop on npm 11.
- Removed the `undici` override so release and publish jobs can complete.

## [0.3.65] - 2026-02-11

### Fixed
- npm publishing no longer waits for the macOS packaging job in `release.yml`.
- This prevents npm release delays when GitHub macOS runners are stalled while still allowing desktop packaging to run independently.

## [0.3.64] - 2026-02-11

### Fixed
- Release workflow could stall for a long time at `Install dependencies` when git-based dependencies attempted SSH transport on GitHub runners.
- CI now forces GitHub git dependencies to HTTPS before `npm ci` in all release/publish jobs.
- Added explicit workflow timeouts and `npm ci --no-audit --no-fund` to reduce long-running hangs during release.

## [0.3.63] - 2026-02-11

### Fixed
- npm installs could still fail with `SIGKILL` in transitive `protobufjs` postinstall hooks under macOS memory pressure.
- Bundled `@mariozechner/pi-ai` and `@whiskeysockets/baileys` in the published npm tarball so their transitive install scripts are not executed on end-user `npm install`.
- Restricted published package contents via `files` in `package.json` to remove large non-runtime artifacts and reduce install-time memory pressure.

## [0.3.62] - 2026-02-11

### Fixed
- npm installs could still fail when the package `postinstall` script itself was SIGKILL'd by macOS memory pressure.
- Removed `postinstall` from the published npm package so `npm install cowork-os@latest` no longer depends on any CoWork lifecycle hook.

## [0.3.61] - 2026-02-11

### Fixed
- npm installs could fail with `sh: electron-rebuild: command not found` because `postinstall` depended on a tool not available in all install contexts.
- `postinstall` now uses a best-effort native setup driver and never fails the overall npm install.
- `better-sqlite3` is now an optional dependency so transient native build failures no longer abort `npm install`; `npm run setup` now ensures it is installed before rebuild.

## [0.3.60] - 2026-02-11

### Fixed
- npm installs could fail on macOS with `Killed: 9` during dependency lifecycle scripts due to floating dependency upgrades.
- Pinned `@whiskeysockets/baileys` to `6.7.16` and `better-sqlite3` to `12.6.2` to avoid pulling newer variants that increased install-time instability.

## [0.3.59] - 2026-02-10

### Fixed
- Increased default native setup outer retry attempts on macOS so `npm run setup` is more resilient to repeated transient `Killed: 9` SIGKILLs on the first run after install.

## [0.3.58] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if the native setup retry wrapper itself was SIGKILL’d immediately after install; setup now performs outer retries (with backoff) around native setup so a transient SIGKILL doesn’t require manual re-runs.

## [0.3.57] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if the nested `npm run setup:native` process was SIGKILL’d; setup now runs the native setup retry wrapper directly (no nested npm process) and propagates SIGKILL as exit code 137 so retries reliably trigger.

## [0.3.56] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` if macOS SIGKILL’d Node before in-process retries could run; native setup now uses a POSIX shell retry wrapper with exponential backoff so users don’t need to re-run commands manually.

## [0.3.55] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` before the retry driver could start; setup now retries native setup at the shell level (multiple attempts) so users don’t need to re-run commands manually.

## [0.3.54] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9` on the first run under memory pressure; native setup now runs via a retrying driver and `setup` disables npm audit/fund to reduce peak memory usage.

## [0.3.53] - 2026-02-10

### Fixed
- macOS `npm run setup` could still fail with `Killed: 9`; native setup now prefers an Electron-targeted `better-sqlite3` rebuild via `npm rebuild` (often uses prebuilds) and only falls back to `electron-rebuild` when necessary.

## [0.3.52] - 2026-02-10

### Fixed
- macOS `npm run setup` could fail with `Killed: 9` during native module rebuild; native setup now defaults to low parallelism for reliability.

## [0.3.29] - 2025-02-08

### Added
- **Vision Tool** - Analyze workspace images (screenshots, photos, diagrams) via `analyze_image`
  - Supports OpenAI, Anthropic, and Google Gemini vision providers
  - Workspace-safe file resolution with MIME type detection
  - Handles images up to 20 MB
- **Email IMAP Tool** - Direct IMAP mailbox access via `email_imap_unread`
  - Check unread emails without requiring Google Workspace integration
  - Uses existing Email channel IMAP/SMTP configuration
- **Chat Commands** - New slash commands available across all gateway channels
  - `/schedule <prompt>` - Schedule recurring agent tasks with results delivered back to the chat
  - `/digest [lookback]` - Generate on-demand digest of recent chat messages
  - `/followups [lookback]` - Extract follow-ups and commitments from recent chat messages
  - `/brief [today|tomorrow|week]` - Generate brief summaries (DM only)
  - `/brief schedule|list|unschedule` - Manage recurring brief schedules
- **Inbound Attachment Persistence** - Channel messages with attachments are saved to workspace
  - Files persisted under `.cowork/inbox/attachments/<date>/<channel>/<chat>/<message>/`
  - Attachment extraction added to Discord, Slack, Teams, Telegram, Google Chat, and iMessage adapters
  - Saved paths appended to task prompts so agents can inspect files (and images via `analyze_image`)
- **Cron Template Variables** - Dynamic variables in scheduled task prompts
  - Date variables: `{{today}}`, `{{tomorrow}}`, `{{week_end}}`, `{{now}}`
  - Chat context variables: `{{chat_messages}}`, `{{chat_since}}`, `{{chat_until}}`, `{{chat_message_count}}`, `{{chat_truncated}}`
  - Conditional delivery: `deliverOnlyIfResult` skips posting when the task produces no output
- **Chat Transcript Formatter** - New `formatChatTranscriptForPrompt()` utility for injecting chat history into agent prompts
- **Tool Restrictions Tests** - New test suite for agent tool restriction enforcement
- **Image Generation (Multi-Provider)** - Generate images via `generate_image` tool with provider auto-selection
  - Supports **Gemini** (gemini-image-fast, gemini-image-pro), **OpenAI** (gpt-image-1, gpt-image-1.5, DALL-E 3/2), and **Azure OpenAI** (deployment-based)
  - Model alias resolution (e.g. "gpt-1.5" → gpt-image-1.5, "dalle-3" → dall-e-3)
  - Provider auto-selection picks the best configured provider when not specified
  - Azure deployment detection for image-capable deployments
  - 180-second tool timeout for remote image generation
- **Visual Annotation Tools** - Agentic generate → annotate → refine → repeat workflow
  - `visual_open_annotator` - Open Live Canvas with an image for visual annotation
  - `visual_update_annotator` - Update the annotator with a new iteration image
  - Structured feedback via canvas interactions (visual_feedback, visual_regenerate, visual_approve)
- **Agentic Image Loop Skill** - New built-in skill for iterative image refinement
  - Generate an image, open the Visual Annotator, collect user markup, refine prompt, regenerate
  - Loops until user approves the result
- **Inline Image Preview** - Generated images display directly in the task event timeline
  - Auto-expands for `file_created`/`file_modified` events with image files
  - Click to open in the full image viewer
- **Local Embeddings for Memory** - Lightweight local vector embeddings without external API calls
  - Token-based hashing for 256-dimensional vectors
  - `MemoryEmbeddingRepository` for persisting embeddings in `memory_embeddings` table
- **Global Imported Memory Search** - Cross-workspace search for ChatGPT imported memories
  - `searchImportedGlobal` enables sessions in any workspace to retrieve imported history
  - FTS with relaxed fallback and LIKE-based backup query

### Changed
- **Task Export** - Moved from `telemetry/` to `reports/` to better reflect purpose (structured task summaries, not telemetry)
- **Skill Metadata** - Added `requires.bins` and `invocation.disableModelInvocation` to gog and himalaya skills
- **Local Websearch Skill** - Updated branding (moltbot → cowork) and paths to `Application Support/cowork-os`
- **Agent Executor** - Improved email fallback logic: prefers `email_imap_unread` when Google Workspace tools are unavailable
- **Agent Executor** - Fixed missing `tool_result` entries on pause/cancel to keep API message history valid
- **Channel Tools** - Added channel status and warning metadata to `channel_list_chats` and `channel_history` results
- **Cron Delivery** - When a task has a non-empty result, delivery messages now include the result text directly instead of a generic status line
- **Email Client TLS** - Load macOS system keychain CAs for IMAP/SMTP connections (fixes corporate proxy/antivirus TLS inspection)
- **Email Client IMAP** - Improved response buffering and greeting handling reliability
- **Image Generation** - Replaced single-provider "nano-banana" model system with multi-provider architecture; removed deprecated model aliases from pricing
- **Gemini Provider** - Removed `banana` filter from model discovery exclusion list
- **Verification Steps** - Verification steps are now internal; agent responds with "OK" on success instead of verbose summaries
- **Task Timeline UI** - Verification step events (step_started, step_completed, verification_started/passed) are filtered from the timeline
- **Plan Display** - Verification steps hidden from displayed plan step lists (still shown on failure)

### Added (UI)
- **step_failed Event** - New event type rendered with error styling in task timeline, right panel, and task timeline views

### Fixed
- **Gateway Message Logging** - Outgoing message persistence is now best-effort (never fails delivery)
- **Security Docs** - Corrected `userData` paths, documented platform-specific locations
- **Architecture Docs** - Added vision tool, chat commands, attachment handling, and cron template variable documentation

## [0.3.25] - 2025-02-05

### Added
- **Google Workspace Integration** - Unified access to Gmail, Google Calendar, and Google Drive
  - **Shared OAuth Authentication**: Single sign-in for all Google services
  - **Gmail Tools**: `gmail_action` for sending emails, reading messages, creating drafts, searching
  - **Calendar Tools**: `google_calendar_action` for creating, updating, and managing events
  - **Drive Tools**: Enhanced `google_drive_action` with improved error handling
  - **Settings UI**: New "Google Workspace" tab replaces separate Google Drive settings
- **Gateway Channel Enhancements** - Improved channel implementations
  - **Gateway Cleanup**: Proper cleanup on disconnect for all channels
  - **Matrix Direct Rooms**: Support for direct message rooms in Matrix
  - **Slack Group Handling**: Proper `is_group` detection for Slack channels
  - **WhatsApp Config**: Enhanced configuration options for WhatsApp
  - **Security Pending State**: Better handling of pending security approvals
- **Agent Transient Error Retry** - Automatic retry for transient failures
  - **Daemon Retry**: Transient errors in daemon scheduling trigger automatic retry with exponential backoff
  - **Executor Retry**: Step processing failures are retried before failing the task
  - **Graceful Degradation**: Non-critical errors don't abort entire task execution
- **Document Tool Parameter Inference** - Smart parameter handling for document creation
  - **Filename Inference**: Automatically infer filename from path or name parameters
  - **Format Detection**: Detect document format (docx/pdf) from file extension
  - **Content Fallback**: Use assistant output as content when not explicitly provided
  - **Validation Errors**: Return helpful error messages for missing required fields
- **Channel User Repository** - Track user-channel mappings in database
- **Encrypted Settings Storage (SecureSettingsRepository)** - All settings now stored encrypted in database
  - **OS Keychain Integration**: Settings encrypted using native OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret)
  - **Fallback Encryption**: App-level AES-256 encryption when OS keychain unavailable
  - **Stable Machine ID**: Persistent machine identifier survives hostname changes and system updates
  - **Data Integrity**: SHA-256 checksums detect corruption or tampering
  - **Backup & Recovery**: Create encrypted backups of all settings, restore with optional overwrite
  - **Health Checks**: `loadWithStatus()` and `checkHealth()` APIs for debugging encryption issues
  - **Settings Categories**: voice, llm, search, appearance, personality, guardrails, hooks, mcp, controlplane, channels, builtintools, tailscale, claude-auth, queue, tray
  - **Safe Migration**: Legacy JSON settings automatically migrated with backups preserved on failure
- **Mobile Companions** - Connect iOS/Android devices as mobile nodes for device-specific actions
  - **Node Architecture**: Mobile devices connect as "nodes" via WebSocket with role-based authentication
  - **Device Capabilities**: Camera capture, location access, screen recording, SMS (Android only)
  - **Standard Commands**:
    - `camera.snap` - Take a photo with front/back camera
    - `camera.clip` - Record video clip
    - `location.get` - Get current GPS location (coarse or precise)
    - `screen.record` - Record device screen
    - `sms.send` - Send SMS message (Android only)
  - **AI Agent Tools**: 6 new tools for agent interaction with mobile devices
    - `node_list` - List connected mobile companions
    - `node_describe` - Get detailed info about a specific node
    - `node_camera_snap` - Take a photo using a mobile node's camera
    - `node_location` - Get current location from a mobile node
    - `node_screen_record` - Record screen on a mobile node
    - `node_sms_send` - Send SMS via an Android node
  - **Settings UI**: New "Mobile Companions" tab in Settings
    - View connected devices with status and capabilities
    - Test commands directly from the UI
    - Connection instructions and troubleshooting
  - **Foreground Detection**: Commands like camera/screen require the app to be in foreground
  - **Permission Tracking**: Monitor granted permissions per capability
  - **Event Broadcasting**: Operators receive real-time node connect/disconnect events
- **Live Canvas Interactive Mode** - Full browser-like interaction directly in the preview
  - **Interactive mode** (default): Embedded webview for clicking, scrolling, and interacting with canvas content
  - **Snapshot mode**: Static screenshot with auto-refresh for monitoring
  - Toggle between modes with **I** key or pointer button
  - Resizable preview by dragging the bottom edge
  - Export options: Download HTML, open in browser, show in Finder
  - Snapshot history panel to browse previous states
  - Console viewer for canvas logs
- **Scheduled Tasks (Cron Jobs)** - Automate recurring tasks with cron expressions
  - Schedule tasks using standard cron syntax (minute, hour, day, month, weekday)
  - Visual schedule builder for users unfamiliar with cron syntax
  - Workspace binding - each scheduled task runs in a specific workspace
  - Channel delivery - optionally send task results to Telegram, Discord, Slack, WhatsApp, or iMessage
  - Run history - view execution history with status, duration, and error details
  - Enable/disable jobs without deleting them
  - Manual trigger to run any scheduled task on-demand
  - Configurable concurrent run limits (default: 3)
  - Desktop notifications when scheduled tasks complete or fail
- **In-App Notification Center** - Centralized notification management
  - Bell icon in the top-right corner with unread badge count
  - Dropdown notification panel accessible from the title bar
  - Click-to-navigate - click any notification to jump to the related task
  - Mark as read - individual or bulk "mark all as read" actions
  - Delete notifications - remove individual or clear all
  - Real-time updates - new notifications appear instantly without refresh
  - macOS native desktop notifications for scheduled task completions
  - Notification types: task_completed, task_failed, scheduled_task, info, warning, error
  - Persistent storage - notifications survive app restarts
- **WhatsApp Bot Integration** - Run tasks via WhatsApp with the Baileys library
  - QR code pairing for WhatsApp Web connection
  - Self-Chat Mode for users using their personal WhatsApp number
    - Bot only responds in "Message Yourself" chat when enabled
    - Configurable response prefix (e.g., "🤖") to distinguish bot messages
  - Standard security modes: Pairing, Allowlist, Open
  - Full command support: `/start`, `/help`, `/workspaces`, `/workspace`, `/newtask`, `/status`, `/cancel`, `/pair`
  - Markdown to WhatsApp formatting conversion (`**bold**` → `*bold*`, headers, strikethrough, links)
  - Automatic cleanup of expired pairing codes
  - Logout and re-pairing support
- **AppleScript Execution** - New `run_applescript` system tool for macOS automation
  - Execute AppleScript code to control applications and automate system tasks
  - Control apps like Safari, Finder, Mail, and more
  - Manage windows, click UI elements, send keystrokes
  - Get/set system preferences and interact with files
  - 30-second timeout with 1MB output buffer
  - macOS only (graceful error on other platforms)
- **Configurable Guardrails** - User-configurable safety limits in Settings > Guardrails
  - **Token Budget**: Limit total tokens per task (default: 100,000, range: 1K-10M)
  - **Cost Budget**: Limit estimated cost per task (default: $1.00, disabled by default)
  - **Iteration Limit**: Limit LLM calls per task to prevent infinite loops (default: 50)
  - **Dangerous Command Blocking**: Block shell commands matching dangerous patterns (enabled by default)
    - Built-in patterns: `sudo`, `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `curl|bash`, etc.
    - Support for custom regex patterns
  - **File Size Limit**: Limit file write size (default: 50MB)
  - **Domain Allowlist**: Restrict browser automation to approved domains (disabled by default)
- Model pricing table for cost estimation (Anthropic, Bedrock, Gemini, OpenRouter models)
- New IPC handlers and preload APIs for guardrail settings

### Changed
- Task executor now tracks token usage, cost, and iterations across LLM calls
- Shell commands are blocked by guardrails before reaching approval dialog
- File writes check size limits before writing
- Browser navigation checks domain allowlist when enabled

## [0.1.7] - 2025-01-26

### Added
- **Shell Command Execution** - AI can now execute shell commands with user approval
  - `run_command` tool for running terminal commands (npm, git, brew, etc.)
  - Each command requires explicit user approval before execution
  - Configurable timeout (default 60s, max 5 minutes)
  - Output truncation for large command outputs (100KB max)
  - New `shell` permission in workspace settings (disabled by default)
- `/shell` command for Discord/Telegram to enable/disable shell execution
  - `/shell` - Show current status
  - `/shell on` - Enable shell commands for workspace
  - `/shell off` - Disable shell commands
- **Safety & Data Loss Warning** in README
  - Prominent warning section at top of documentation
  - Guidelines for safe usage (separate environment, non-critical folders, backups)
  - Clear disclaimer of maintainer responsibility

### Changed
- Workspace permissions now include `shell: boolean` field
- Updated help text in Discord/Telegram bots to include shell command info
- Permission model documentation updated in README

## [0.1.6] - 2025-01-25

### Added
- **Discord Bot Integration** - Full Discord support with slash commands and DMs
  - `/start` - Start the bot and get help
  - `/help` - Show available commands
  - `/workspaces` - List available workspaces
  - `/workspace` - Select or show current workspace
  - `/addworkspace` - Add a new workspace by path
  - `/newtask` - Start a fresh task/conversation
  - `/provider` - Change or show current LLM provider
  - `/models` - List available AI models
  - `/model` - Change or show current model
  - `/status` - Check bot status
  - `/cancel` - Cancel current task
  - `/task` - Run a task directly
- Direct message support for conversational interactions
- Mention-based task creation in server channels
- Automatic message chunking for Discord's 2000 character limit
- Guild-specific or global slash command registration

### Changed
- Channel gateway now supports both Telegram and Discord adapters
- Added `discord.js` dependency for Discord API integration

## [0.1.5] - 2025-01-25

### Added
- **Browser Automation** - Full browser control using Playwright
  - `browser_navigate` - Navigate to any URL
  - `browser_screenshot` - Capture page or full-page screenshots
  - `browser_get_content` - Extract text, links, and forms from pages
  - `browser_click` - Click on elements using CSS selectors
  - `browser_fill` - Fill form fields
  - `browser_type` - Type text character by character (for autocomplete)
  - `browser_press` - Press keyboard keys (Enter, Tab, etc.)
  - `browser_wait` - Wait for elements to appear
  - `browser_scroll` - Scroll pages up/down/top/bottom
  - `browser_select` - Select dropdown options
  - `browser_get_text` - Get element text content
  - `browser_evaluate` - Execute JavaScript in browser context
  - `browser_back/forward` - Navigate browser history
  - `browser_reload` - Reload current page
  - `browser_save_pdf` - Save pages as PDF
  - `browser_close` - Close the browser
- Automatic browser cleanup when tasks complete or fail
- Headless Chrome browser (Chromium) via Playwright

### Changed
- Tool registry now includes 17 browser automation tools
- Executor now handles resource cleanup in finally block

## [0.1.4] - 2025-01-25

### Added
- **Real Office Format Support** - Documents now create actual Office files instead of text placeholders
  - Excel (.xlsx) files with `exceljs` - multiple sheets, auto-fit columns, header formatting, filters, frozen rows
  - Word (.docx) files with `docx` - headings, paragraphs, lists, tables, code blocks with proper styling
  - PDF files with `pdfkit` - professional document generation with custom fonts and margins
  - PowerPoint (.pptx) files with `pptxgenjs` - multiple slide layouts (title, content, two-column, image), speaker notes, themes
- Spreadsheet read capability for existing Excel files
- Fallback to CSV/Markdown when those extensions are explicitly requested

### Changed
- SpreadsheetBuilder now creates real Excel workbooks with formatting
- DocumentBuilder supports Word, PDF, and Markdown output formats
- PresentationBuilder creates professional PowerPoint presentations with layouts

## [0.1.3] - 2025-01-25

### Added
- CLI/ASCII terminal-style UI throughout the application
- Model selection dropdown (Opus 4.5, Sonnet 4.5, Haiku 4.5)
- AWS Bedrock support as alternative to Anthropic API
- Telegram bot integration with full command support
- Web search integration (Tavily, Brave, SerpAPI, Google)
- Ollama support for local LLM inference

### Changed
- Updated branding to CoWork OS
- Improved workspace selector with terminal aesthetic

## [0.1.0] - 2025-01-24

### Added

#### Core Features
- Task-based workflow with multi-step execution
- Plan-execute-observe loop for agent orchestration
- Real-time task timeline with live activity feed
- Workspace management with folder selection

#### Agent Capabilities
- File operation tools (read, write, list, rename, delete)
- Built-in skills:
  - Spreadsheet creation (Excel format)
  - Document creation (Word/PDF)
  - Presentation creation (PowerPoint)
  - Folder organization

#### Security & Permissions
- Sandboxed file operations within selected workspace
- Permission system for destructive operations
- Approval dialogs for file deletion and bulk operations
- Path traversal protection

#### LLM Integration
- Anthropic Claude API support
- AWS Bedrock support
- Multiple model selection (Opus, Sonnet, Haiku)
- Settings UI for API configuration

#### User Interface
- Electron desktop application for macOS
- React-based UI with dark theme
- CLI/ASCII terminal aesthetic
- Task list with status indicators
- System monitor panel (progress, files, context)

#### Data Management
- SQLite local database
- Task and event persistence
- Workspace history
- Artifact tracking

### Technical
- Electron 40 with React 19
- TypeScript throughout
- Vite for fast development
- electron-builder for packaging

## [0.0.1] - 2025-01-20

### Added
- Initial project setup
- Basic Electron app shell
- Database schema design
- IPC communication layer

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|------------|
| 0.3.91 | 2026-02-24 | Digital twins, web scraping, AI playbook, build mode, knowledge graph, usage insights, infrastructure tools |
| 0.3.90 | 2026-02-23 | Collaborative mode, multi-LLM orchestration, git worktree isolation, Anthropic streaming |
| 0.3.89 | 2026-02-20 | Declarative plugin system, built-in packs, Sonnet 4.6, slash command autocomplete |
| 0.3.88 | 2026-02-19 | Vision support across all LLM providers, LOOM email, Conway Terminal, density mode |
| 0.3.87 | 2026-02-17 | Intent-routed strategy, relationship memory, timeout recovery, Resend connector |
| 0.3.86 | 2026-02-14 | ACP canvas endpoints, i18n, talk mode, skill registry |
| 0.3.84 | 2026-02-14 | Fixes CI installability check module resolution so release validation passes and desktop packaging can continue |
| 0.3.83 | 2026-02-14 | Fixes release workflow shell parsing so installability validation and desktop asset publishing complete successfully |
| 0.3.82 | 2026-02-14 | Removes script-enabled recovery installs that triggered electron-winstaller SIGKILL and hardens runtime repair install flags |
| 0.3.81 | 2026-02-14 | Restored reliable /tmp install flow with retry-safe native setup and CI validation for both registry and npm-pack install paths |
| 0.3.80 | 2026-02-14 | Fixed macOS first-install runtime setup reliability and hardened release validation so new tags can still run installation checks |
| 0.3.79 | 2026-02-14 | Retained the 0.3.71 SIGKILL workaround and hardened draft release preparation so desktop assets upload reliably |
| 0.3.78 | 2026-02-14 | Fixes missing release-time `executor-helpers` source and remaining strict-mode TypeScript blockers |
| 0.3.77 | 2026-02-14 | Skips lifecycle scripts during setup reinstall and prevents setup-time SIGKILL in user-first installs |
| 0.3.76 | 2026-02-14 | Pinned Electron to 40.2.1 for first-run installability and aligned README CLI flow |
| 0.3.75 | 2026-02-14 | Restored 0.3.71-compatible Electron lockfile for installability and release confidence |
| 0.3.73 | 2026-02-14 | Release automation hardening and task/workspace validation fixes |
| 0.3.72 | 2026-02-14 | Session-based temp workspaces, autonomous execution mode, safer completion validation |
| 0.3.29 | 2025-02-08 | Multi-provider image generation, visual annotation, local embeddings, verification UX |
| 0.3.25 | 2025-02-05 | Google Workspace integration, gateway enhancements, agent retry logic |
| 0.1.6 | 2025-01-25 | Discord bot integration with slash commands |
| 0.1.5 | 2025-01-25 | Browser automation with Playwright |
| 0.1.4 | 2025-01-25 | Real Office format support (Excel, Word, PDF, PowerPoint) |
| 0.1.3 | 2025-01-25 | Telegram bot, web search, Ollama support |
| 0.1.0 | 2025-01-24 | First public release with core features |
| 0.0.1 | 2025-01-20 | Initial development setup |

[Unreleased]: https://github.com/CoWork-OS/CoWork-OS/compare/v0.3.91...HEAD
[0.3.91]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.91
[0.3.90]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.90
[0.3.89]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.89
[0.3.88]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.88
[0.3.87]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.87
[0.3.86]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.86
[0.3.84]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.84
[0.3.83]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.83
[0.3.82]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.82
[0.3.81]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.81
[0.3.80]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.80
[0.3.79]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.79
[0.3.78]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.78
[0.3.77]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.77
[0.3.76]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.76
[0.3.75]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.75
[0.3.73]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.73
[0.3.72]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.72
[0.3.71]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.71
[0.3.29]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.29
[0.3.25]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.25
[0.1.6]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.6
[0.1.5]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.5
[0.1.4]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.4
[0.1.3]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.3
[0.1.0]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.0
[0.0.1]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.0.1
