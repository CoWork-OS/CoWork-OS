# Release Notes 0.5.61

Release `0.5.61` makes CoWork easier to start and easier to move to. It adds one-line installs for macOS and Windows, a first task that needs no API key (sign in with OpenRouter and use free models), and an import for Hermes Agent and OpenClaw homes. It also brings the Today, Work and Team views to the Calm theme, gives bots their own computer, memory and model, turns the in-app browser into a real browser, adds remote MCP servers with OAuth, 43 hosted MCP connectors and MCP Events, and updates the Z.AI, GLM and Kimi model routes.

Read [Upgrade notes](#upgrade-notes) before upgrading: channel pairings are reset, the data of retired features is deleted, and shell commands in on-request network profiles ask for approval each time.

## Highlights

- **One-line installs** — `curl -fsSL https://coworkosapp.com/install.sh | bash` on macOS avoids the Gatekeeper "Apple could not verify" dialog, and `irm https://coworkosapp.com/install.ps1 | iex` on Windows verifies the installer's SHA-512, installs silently for the current user without an administrator prompt and opens the app. Both check the published release metadata first. See [macOS Installation](macos-installation.md) and [Windows Installation](windows-installation.md).
- **A first task without an API key** — Onboarding leads with **Continue with OpenRouter**: an OAuth PKCE sign-in that stores a key encrypted on your machine and selects OpenRouter's free-models router. The first task opens filled in, runs as **Do** on **Ask for approval**, and asks you to connect an app only when the task needs it. See [Sign in with OpenRouter](providers.md#sign-in-with-openrouter-no-key) and [First-result onboarding](first-result-onboarding.md).
- **Move from Hermes Agent or OpenClaw** — `cowork import --from hermes|openclaw`, **Settings > Import**, or the onboarding offer carry over your persona, memory notes, skills, channels (switched off), cron jobs (paused) and, only if you ask, provider keys. A local Hermes install can also take work from CoWork as an ACP agent. See [Migrating from Hermes](migrating-from-hermes.md) and [Migrating from OpenClaw](migrating-from-openclaw.md).
- **Today, Work and Team (Calm theme)** — The Calm home becomes Today: one card per decision you owe, answered in place, from one needs-you queue that the bell, the session panel, Bots and Mission Control all count. Work lists every session by project, Team shows agents, bots and schedules as teammates with a **May do alone** access limit, and Google Workspace adds calendar cards and opt-in reply drafts.
- **Bots with their own computer, memory and model** — Choose where a bot works (this computer, the browser, its own Linux desktop in a container here or on your server over SSH, or nowhere), watch it and take over, and teach it a task by doing it once. Each bot keeps its own memory, runs on its own model and shows its cost and cache reuse. See [Bots and conversations](bots-and-conversations.md#where-a-bot-works).
- **A real in-app browser** — Native tabs that stay loaded, popups, downloads, history, site permissions, find in page, an address bar with suggestions, cookie and password import from other browsers, and private login, 2FA and checkout autofill that keeps secrets out of model context. See [Browser Workbench](browser-workbench.md).
- **Apps and devices** — Background control of macOS app windows without taking focus (`native_app`), Android phone control with per-action approvals, and a bundled CLI-Anything skill for headless app backends. See [Working with apps in the background](background-app-work.md) and [Android phone control](android-phone-control.md).
- **MCP and business agents** — Remote MCP servers with OAuth 2.1 sign-in (including Workday with in-app agent setup), 43 vendor-hosted connectors with dynamic client registration, MCP Events that start or continue tasks, and PACT business agents (off by default). See [Remote MCP OAuth](remote-mcp-oauth.md), [MCP Events](mcp-events.md) and [PACT](pact.md).
- **Answers you can act on** — Interactive answers gain themes, icons and better charts, compute numbers from your data files and tool results, and can send a message or open a link after your approval. Generated images show inline, images and videos open in a full-screen viewer, and composer predictions suggest a next message (on by default).
- **Watch the work as it happens** — A live plan above the composer, servers and watchers the agent starts as read-only terminal tabs linked from the answer, **Run** on shell code blocks with the output sent back to the agent, the agent listing and (after your approval) reading your own terminal tabs, a sub-agent roster in the right panel, and a per-turn line listing the files each turn created. See [Terminal Tabs](terminal-tabs.md#the-agents-processes-as-tabs).
- **Documents, canvas and video** — `create_document` writes matching Word and PDF files from one call and can fit a PDF to a page count; Live Canvas pages take images, video and audio and export to a workspace folder; the `pdf-storybook` skill turns a PDF into an illustrated story page; video generation adds a local model provider; and the `motion-film` skill gains a review loop, a sound engine and a simulation mode. See [Live Canvas](live-canvas.md).
- **More reliable results** — When a task's final verification finds a blocking failure, CoWork runs one repair step and checks again. Files you asked to match must match, and research that asks for sources must link them. Many more fixes from live workflow runs cover verification, document outputs, drafts and the task view.
- **Models** — Picking a model in an open conversation changes only that conversation, and a bot runs on its own model. Z.AI defaults to GLM-5.3, the GLM provider becomes the BigModel China route, Kimi moves to K3, reasoning from Ollama and OpenAI-compatible models no longer leaks into replies and titles, and follow-up messages reuse the prompt cache.
- **Builds and sandboxes** — The Build composer has the access picker and can use an explicit checkout, worktree and branch. An opt-in SPACE sandbox pilot runs `run_command` and `execute_code` on an operator-managed server and never falls back to local execution. See [Worktrees](worktrees.md) and [SPACE sandbox](space-sandbox.md).
- **Faster and quieter** — The window appears about a third sooner, first opens of Settings, Agents and Automations no longer pause, and the question card, approvals, Settings and assistant replies use one minimal style. New releases arrive in a native-style update window, and nothing installs until you choose **Install and Relaunch**.
- **A smaller app** — Retired features are removed: Everyday Agent, R&D Council, the Twitch and X integrations, the Infrastructure tools, Supermemory, the chief-of-staff engine, Agent Comparison, Multi-LLM judge mode, the Workflow Pipeline and others. See [Removed features](#removed-features) for what happens to their data.
- **Community** — A Discord server, a Simplified Chinese README (with a call for native-speaker reviewers from @YuuGR1337), and a [What You Own](what-you-own.md) page. An LM Studio setup guide by @yuefdev. Thanks to @umairnaeem0309, @yuefdev, @Doomguy-BFG9000 and @VyxorDev for their fixes.

## Upgrade notes

### One-time migrations on first start

- **Channel pairings are reset** — Access grants now apply to a direct message or a group chat separately, and the earlier grants can't be mapped to one of them. On first start every paired or allowed channel user (Telegram, Slack, Discord, Signal and the others) loses access and must pair again, once for DMs and once for groups if both are used. Channels in allowlist mode keep working, since the configured list is checked on every message.
- **Retired features' data is deleted** — The tables of Everyday Agent, R&D Council, the first-task beta, Discord supervisor mode, Supermemory remote references, standup reports, performance reviews and Agent Comparison are dropped. The X, Infrastructure, Supermemory (including its API key) and chief-of-staff settings are deleted; the encrypted wallet key is kept so it can still be exported. Leftover Twitch and X channels are deleted with their stored credentials, pairings and message logs; tasks they created stay in history.
- **Scheduled tasks** — Jobs that delivered to Twitch or X keep running with delivery turned off, and jobs created by an R&D Council are turned off until their prompt is rewritten.
- **Kimi models** — Saved, cached and fallback choices of discontinued Kimi models move to `kimi-k3` (K2.5, the K2 thinking models) or `kimi-k2.6` (the other K2 previews and `moonshot-v1-*`), with a warning naming the old model. Requests to Moonshot rewrite discontinued ids that are pinned to a task or bot. A Kimi Code key without a saved base URL stays on the endpoint it used before.
- **Mailbox content (macOS)** — A background task re-encrypts mailbox bodies and summaries that were encrypted under one of the app's earlier macOS Keychain names, so blank thread summaries come back. macOS may ask for Keychain access.

### Database changes

- **New columns** — `channel_users.allowed_dm`, `channel_users.allowed_group` and `channel_users.pairing_context` (the reset above); `agent_roles.access_profile_id`, `agent_roles.works_on`, `agent_roles.desktop_host` and `agent_roles.desktop_group` (all `NULL` on upgrade, so existing bots have no access limit and the default **Works on** behavior).
- **New tables** — `answer_tool_data`; eight `pact_*` tables; `application_operations`, `application_operation_attempts`, `application_resource_locks` and `application_operation_events`; `browser_history` and `browser_history_visits`; and `mcp_event_subscriptions` (created when the MCP Events service starts).
- **Dropped tables** — `everyday_agent_*` (10 tables), `council_memos`, `council_runs`, `council_configs`, `first_task_real_work`, `first_task_attempts`, `first_task_setup`, `supervisor_exchange_messages`, `supervisor_exchanges`, `supermemory_remote_refs`, `standup_reports`, `agent_performance_reviews` and `comparison_sessions` with its three triggers and index. The unused `tasks.comparison_session_id`, `agent_team_runs.multi_llm_mode` and `orchestration_graph_nodes.workflow_phase_id` columns stay in place.
- The schema version is unchanged.

### Features that use model tokens by default

- **Composer predictions** — On by default. After a conversation completes, CoWork asks the conversation's provider (the Cheap profile when profile routing is on) for a short suggested next message, including suggestions you discard. Turn it off in **Settings > Appearance > Composer**.
- **Answer repair** — A broken interactive answer block (at most two per answer) is sent back to the model once to be fixed before it is shown.
- **Verification repair** — A blocking failure in a task's final verification runs one repair step and one re-check (not for failures that need your input, access or more budget).

### Changed defaults and behavior

- **Shell commands in on-request network profiles** — Every `run_command`, including background commands, asks for approval of the command and its possible network access. Trusted commands, auto-review, command bundles and remembered approvals no longer replace that decision, and a profile that never asks for approval can't run these commands. Use a profile with networking on for autonomous shell networking. See [Access Profiles](access-profiles.md).
- **In-app browser** — Native tabs are the browser engine for everyone upgrading (switch back in **Settings > Browser > Browser engine**). Page-script tools need **Developer mode**, their first use on a site asks for approval, and file uploads by CoWork ask each time.
- **Z.AI and GLM** — Z.AI defaults to `glm-5.3` and GLM-5-Turbo and GLM-5V-Turbo are no longer listed; a model you saved is still used. The **GLM** provider is now "GLM (BigModel China)" with a default base URL of `https://open.bigmodel.cn/api/paas/v4`. A base URL, key and model you saved are not changed; only a GLM setup with no saved model moves from `glm-4-plus` to `glm-5.3`.
- **Models per conversation and per bot** — Picking a model while a conversation is open changes only that conversation; with nothing open it still sets the global default. A bot with its own model now runs on it (bots previously used the global default).
- **Update window** — Installed builds check for updates about 5 seconds after launch and then daily, and show a small update window when a release is available. Automatic download is off unless you turn it on, and nothing installs without **Install and Relaunch**.
- **Bots** — A bot hands work to teammates only when your current message asks for it.
- **Mission Control and agents** — The Agents tab is gone; the header link opens Team (Calm) or the Bots page, and an agent's full settings open from **Edit agent** in Team or **More settings** in the Bots page.
- **Execution overrides** — Saved Analyze, Debug and Verified pins behave as **Do**; **Plan** is the only pin left.
- **Sub-agents** — The composer strip is replaced by a **Subagents** roster in the right panel, sessions with sub-agents start collapsed in the sidebar, and sub-agent usage stats are opt-in (**Settings > Appearance > Task panel**).
- **Calm stays opt-in** — Today, Work and Team are part of the Calm theme; the default theme is unchanged.

### Removed features

- **Everyday Agent, R&D Council, Twitch channel, Infrastructure tools, X integration, first-task beta, Discord supervisor mode, Supermemory, the chief-of-staff engine with standup reports and performance reviews, Agent Comparison, Multi-LLM judge mode and the Workflow Pipeline** — See the [Changelog](changelog.md) for each one's decision record and what happens to its data. Revoke CoWork's access on twitch.tv and in the X developer portal yourself, and move funds out of the Infrastructure wallet before upgrading.
- **Advanced execution overrides** — The **Advanced…** menu is replaced by **Plan** as the third work choice.
- **Classic browser fallback and the full-view chat box** — Full view shows only the browser.
- **`organize_folder` custom strategy** — It never moved anything; use `by_type` or `by_date`.

## Security

- **Channel access per context** — A grant or pairing code made in one DM or group no longer admits messages from another, and admission is checked before routing.
- **Shell and subprocess networking** — Network access is bound to the approval for one invocation and rechecked against workspace and administrator policy before it runs.
- **LaTeX, attachments and uploads** — `compile_latex` runs inside the process sandbox without network, channel attachments can't be written outside the workspace, and browser upload quotas persist across restarts.
- **MCP** — SSE credentials are sent as headers, never in the URL; paired browsers can't create or change local MCP server commands; and connector OAuth refresh retries once.
- **Scheduled tasks and commands** — Scheduled-task (cron) IPC input is validated in the main process with strict schemas, and quoted or nested disk-format commands need consent like a bare one.
- **Network policy and answers** — OTLP task events, browser networking's internal-host exceptions and PACT signer calls follow the network policy; an answer's preview frame can only reload its own page, and messages sent from an answer's action are marked as such.
- **Permissions and backups** — Saved HTTP read approvals keep their method, body and credential limits, redacted backups restore credentials only to a matching endpoint, and reassigning a session to another agent is authorized and audited.

## Fixes

Highlights from this release's fixes: explicit skill requests route reliably and export-risk approvals explain the risk and keep denials recorded, the renderer bundle loads optional views on demand with no chunk over 500 kB, provider requests trust the operating system's certificate roots, provider errors and empty replies stay failures with the reason above the composer, saving LLM settings no longer erases stored keys, **Clear memory** no longer fails with `database is locked`, MCP servers that require `initialize` first connect on the first try, startup no longer fails with "Database worker queue is full", and many fixes to verification, document outputs, drafts, the sidebar and the task view found in live workflow runs.

The [Changelog](changelog.md) lists every change in this release.

## Compatibility

- The package version is `0.5.61`; the desktop runtime is Electron 44 (44.7.0) and macOS 13 Ventura remains the minimum supported macOS version.
- `0.5.60` can still open an upgraded profile, but the deleted data of retired features and the reset channel pairings do not come back.
- Notable dependency updates: @earendil-works/pi-ai 1.1, @anthropic-ai/sdk 0.132, openai 7.30, pdfjs-dist 6.4, mermaid 12.1 and docx 9.9; the bundled model price and context-limit table is refreshed from models.dev; `e2b` and `ethers` are removed.

## Release validation

The release candidate should pass the repository gates before tagging or publishing:

```bash
npm run fmt:check
npm run type-check
npm run lint
npm run qa:docs-versions
npm run qa:approval-boundaries
npm run qa:harness
npm run build
npm run release:smoke
```

Because this release changes the database schema, also run the upgrade-path check: start `0.5.61` on a copy of a profile last used with `0.5.60` that has paired channel users, a saved Kimi model and a bot, and confirm the migrations complete, the new columns and tables exist, the retired tables are gone, channel users must pair again, the Kimi model moved to K3 or K2.6, saved provider keys still work, and `0.5.60` can still open the upgraded profile.
