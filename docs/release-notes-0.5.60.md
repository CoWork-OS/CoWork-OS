# Release Notes 0.5.60

Release `0.5.60` is a major feature release. It makes the memory folder the place where CoWork keeps what it knows about you, adds a Bots page with scheduled responsibilities and a work view, replaces the sidebar with an icon rail and session panel, moves database work off the main thread, and adds sandboxed web previews, new channels and new models. It also includes a broad security hardening pass, including a fix for a reported command-injection issue in the Signal channel.

The version skips from `0.5.54` to `0.5.60` to reflect the size of the change. Read [Upgrade notes](#upgrade-notes) before upgrading: first start runs several one-time migrations, some retired features delete their data, and two memory features that use model tokens are on by default.

## Highlights

- **Memory folder** — What CoWork knows about you, your workspaces and lessons now lives as plain markdown notes in a local git repo (`~/CoWork Memory` by default, in the open Agent Memory Repo format). Every change is a commit, you can edit notes in any editor or in **Settings > Memory > What CoWork knows**, and **Compact history** makes deleted memories really gone. It is turned on once for every profile on upgrade. See [Memory Repo design](memory-repo-phase1-design.md).
- **Dreaming over the memory folder** — About once a day, or when you press **Dream now**, a model pass merges duplicates, removes stale notes and saves things you said that were not saved yet. Low-risk edits are applied as one undoable commit; anything that touches your own notes waits in **Settings > Memory > Review**, and a notification tells you when there is something to review.
- **Memory sync, team memory and shared notes** — Sync the memory folder across your machines through a private git remote you own, add up to three read-only team memory folders, and import notes from another folder. Agents working on one goal share a notes folder so work is not repeated.
- **One memory engine and a shorter Memory settings tab** — Every memory source goes through one write path with the same redaction, privacy and duplicate checks. The agent's memory tools are now `memory_recall`, `memory_remember`, `memory_forget` and `context_recall`, the agent saves what it learns in every step, each reply can show **Memory used**, and the Memory settings tab goes from about 155 controls to five short sections.
- **Bots page, responsibilities and work view** — The Agents view opens on a Bots page with illustrated bot characters, what your bots need from you, what is running and what is scheduled. Give a bot a responsibility with a trigger, sources, a mode (Observe, Propose, or Act within granted scope), a review boundary and a budget; it is saved paused and runs only when you turn it on. Each bot has a work view with stop and pause controls, inline approvals in chat, opt-in notifications, and one continuous chat thread. See [Bots and conversations](bots-and-conversations.md).
- **New sidebar** — An icon rail (Home, Inbox, Agents, Automations, Library, and More) with keyboard shortcuts and reordering, plus a session panel with always-visible search (Cmd/Ctrl+K), **Running** and **Needs you** filters, day groups and one notice area.
- **Sandboxed web previews and a richer Build view** — HTML artifacts run on an isolated `cowork-preview://` origin with a strict content security policy, a new `preview_web_page` tool lets the agent open, click through and check pages it builds, and the Build view adds attachments, drafts, recent builds, a live preview and a changes panel.
- **Database work off the main thread** — SQLite runs in worker threads in the desktop app, daemon and CLI, and new foreign-key indexes remove a startup stall of about 21 seconds on affected profiles.
- **Agent reliability** — Background processes for dev servers and watchers, clearer command failures, completion checks based on observed evidence, honest test outcomes, better provider error handling and higher default budgets. A repo-root `AGENTS.md` (or `CLAUDE.md`) is loaded in every workspace, and the headless browser now handles tabs, popups, downloads, dialogs and uploads.
- **New models, providers and channels** — GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol, OpenAI's official Sign in with ChatGPT (the older Codex sign-in stays as an unofficial fallback; image generation isn't available with it), the oMLX local provider, Anthropic adaptive thinking, wider prompt caching, WhatsApp Business (Cloud API) and Twilio SMS channels, Teams meeting transcripts, a Home Assistant connector and eight more ACP runtime agents.
- **Interface** — An opt-in Calm visual theme, a redesigned task feed that groups steps by turn, a per-task Cost panel, an Automation Library, an Add Tools page and a use-case gallery that replaces the Ideas panel.

## Upgrade notes

### One-time migrations on first start

- **Memory moves into the memory folder** — The memory folder is turned on for every profile (turning it off later is respected) and existing facts are copied into it. The database copies are then backed up to an encrypted file in `backups/` (encrypted with the OS keychain) and removed. Commitments and notes about other people stay in the database.
- **Legacy memory data retired** — About two minutes after first start, the old memory stores are written to an encrypted backup (`backups/legacy-memory-<date>.json.enc` in the app data folder) and deleted. CoWork-generated sections in workspace `.cowork/USER.md`, `.cowork/MEMORY.md`, `MISTAKES.md` and `LORE.md` are removed once with a `.history` snapshot; your own text stays.
- **Cleanup and re-indexing** — Duplicate knowledge-graph entities are merged, memory search is re-indexed in the background, and telemetry, duplicate rows and orphaned embeddings are removed. After the cleanup, idle maintenance runs one full `VACUUM`. On large databases this takes minutes and needs free disk space roughly the size of the database.
- **Database indexes and worker** — Indexes on 20 foreign-key columns are created, and the database worker is on by default. If you hit a database problem, set `COWORK_DB_WORKER=0` to return to the previous path and report it. Do not delete your database to fix an upgrade problem.
- **macOS Keychain** — Settings encrypted under older macOS Keychain identities are migrated automatically, and macOS may show a Keychain access prompt. Check that your saved provider keys are still present afterwards.
- **Checkpoints** — Existing transcript checkpoints are unsigned and are ignored; resuming falls back to the saved task state.
- **Migration backups** — The backups in `backups/` are encrypted with the OS keychain in the desktop app. Headless daemon installs without an OS keychain write them as plain JSON readable only by your user account; delete them once you've checked your memory folder. See [Troubleshooting](troubleshooting.md#upgrading-or-downgrading-cowork-os).

### Features that use model tokens by default

- **Dreaming** — On by default with a 50,000-token daily budget, at most about once a day. Turn it off in the Memory folder card.
- **AI memory compression** — On by default with up to 20,000 tokens per day across workspaces. Adjust the budget or turn it off per workspace in **Settings > Memory > Advanced**. Private memories are never sent.
- **Per-task cost budget** — Tasks are capped at $10 by default unless you change the budget.

### Changed defaults and behavior

- **Chat and Smart are now Ask and Do** — The work choices are renamed; what they do and their stored values are unchanged.
- **New installs and new workspaces** — Shell networking is on, unsandboxed shell commands ask for approval per command, and new workspaces can delete files inside the workspace. Existing installs and workspaces keep their saved settings.
- **Agent defaults** — Higher budgets (2M tokens per user turn, 500 iterations with auto-continuation, 25 web searches per task), Docker sandboxes use `node:24-bookworm` with 4 GB of memory (was `node:20-alpine` with 512 MB), high-risk code and operations tasks get an automatic review, Gemini models receive images, and approval cards time out after 5 minutes.
- **Pulse consent** — CoWork asks once, after your first successful task, instead of during setup; the update check no longer depends on the answer.
- **Stricter sandbox and browser rules** — Shell commands always run sandboxed when shell networking is off, attaching to an external Chrome over CDP is refused, WebSockets and service workers are blocked in agent browsers, `execute_code` needs shell permission and approval, and Docker mounts that conflict with the filesystem policy fail before launch.
- **Saved provider keys are tied to their endpoint** — Changing a provider's base URL requires entering the API key again.
- **Full access needs confirmation** — Switching to Full access or the bypass-permissions mode shows a confirmation dialog.
- **Researcher tasks** — Researcher sub-tasks can no longer use external services or the browser.
- **Memory tool names** — The 16 earlier memory tools (`search_memories`, `memory_save`, `memory_curate`, `supermemory_*`, `context_grep` and others) are removed and return "Unknown tool". Skills or prompts that name them must use `memory_recall`, `memory_remember`, `memory_forget` or `context_recall`.
- **Memory settings** — The privacy mode "Disabled" is now the **Use memory** switch, and Chronicle is configured only in **Settings > Tools**.
- **Bots** — No bot roster is installed and startup no longer rewrites bot instructions; existing bots, teams and history are kept. Responsibilities are always saved paused.
- **Diagrams** — Mermaid 12 uses a new default layout and look, so existing diagrams may render differently.

### Removed features

- **Personal Health** — The Health dashboard, source imports and the Apple Health bridge are removed. Upgrading deletes the Health data in the active profile, and older settings backups can't restore it. See the [decision record](personal-health-discontinuation.md).
- **Mobile Companions** — The iOS and Android companion apps, their settings tab and the companion token are removed; older companion apps are refused. See the [decision record](mobile-companions-discontinuation.md).
- **Digital Twins, Companies and Symphony** — Removed, with their persona templates and `twin-*` skills.
- **Stealth fetcher and two sign-in routes** — The stealth scraping fetcher and the Google Antigravity and Gemini CLI sign-in routes are removed. Saved stealth settings fall back to Playwright, and those sign-ins move to another configured provider.
- **Ideas panel** — Replaced by the use-case gallery, which covers all of its workflows.
- **Legacy memory features** — Topic packs, daily summaries, the rule-based Dreaming curator and its settings are replaced by the memory folder and its dreaming.

## Security

- **Signal channel command injection** — signal-cli and ngrok commands no longer run through a shell, so message text and other arguments can't be interpreted as shell commands. On Windows, the `signal-cli.bat` launcher runs with quoted arguments and the message is passed on stdin. Thanks to Tal de Vries (@tal2k9dev-star) for reporting this. Advisory: GHSA-ggwv-w8g3-mc75.
- **Browser and network enforcement** — Agent browsers route through a local proxy that enforces network policy, including redirects. Network tools validate every resolved address, cap decoded responses at 5 MiB and drop credentials on cross-origin redirects. Canvas windows and web previews enforce their task's network policy.
- **Sandbox and code execution** — Administrator network limits apply to code execution and the unsandboxed shell fallback, macOS sandbox rules follow the filesystem policy (read-only subtrees, `.git`, policy files and delete permission), and sandboxed commands can't reach other programs' local sockets such as the Docker daemon.
- **Bounded inputs** — Webhook, cron webhook and Pulse bodies, Office and OpenDocument archives, imported skill archives, plugin manifests and PDF parsing all have size, time or memory limits; regex search runs in a terminable worker.
- **Memory privacy** — Private, suppressed and redacted memories never reach prompts or recall tools, secrets are redacted at every memory write, group chats and sub-agents get no memory by default, and writes from tasks that read untrusted content go to an inbox that is never put in prompts. Session checkpoints are signed.
- **Credentials and approvals** — Saved provider keys are only sent to their own endpoint, the Keychain identity is checked at startup, protected-credential requests are authorized, channel approvals can't unlock exact reviews, and MCP elicitation requests that collect data or open URLs fail closed.
- **Remote access and imports** — Read-only MCP tunnels block all tool calls, the relay no longer trusts the Host header, Git skill imports reject symbolic links, and ACP agents on Windows launch without a shell.

See the [September 30](security-fixes-2026-09-30.md), [October 2](security-fixes-2026-10-02.md) and [October 2 browser and runtime](security-fixes-2026-10-02-browser-runtime.md) security fix records for details.

## Fixes

- **Agent work** — Concurrent edits no longer lose changes, edit steps on named files no longer fail, follow-ups sent as a turn ends are processed, a crash during graph dispatch can't run a child twice, failed test runs that were fixed later and verifier timeouts no longer fail the task, and local commands that merely mention `fetch` or a loopback URL are no longer blocked as networking.
- **Bots** — Replies and handoffs wait for durable delivery and keep their order, bots created with a reused name get a numbered handle, and opening a bot no longer creates empty conversations.
- **App lifecycle** — Quitting saves the composer draft before storage closes, shutdown completes cleanly, heartbeat history and temporary workspaces are pruned again, and settings that can't be decrypted no longer block saving.
- **Scheduling and updates** — Persisted scheduled runs are reconciled on startup so runs aren't duplicated, and update checks say whether results are live or cached and no longer report "up to date" after a failed check.
- **Interface** — Fixed blank-window crashes when returning from full-screen views, a duplicate notification icon on macOS and the sidebar crowding narrow windows.
- **Memory and sandbox** — Memory summaries no longer all show the same first line, Everyday Agent "Delete local data" clears only that workspace, and the macOS sandbox works for workspaces under `/private/tmp`.

The [Changelog](changelog.md) lists every change in this release.

## Compatibility

- The package version is `0.5.60`; the desktop runtime is Electron 44 (44.5.1) and macOS 13 Ventura remains the minimum supported macOS version.
- macOS 12 Monterey users should remain on `0.5.51`.
- Existing CoWork data and profiles are migrated on first start as described in [Upgrade notes](#upgrade-notes). `0.5.54` can still open an upgraded profile and ignores the tables it doesn't know, but memory moved into the memory folder is not visible there. Memories saved while back on `0.5.54` are picked up again the next time you upgrade.
- Notable dependency updates: openai 7, mermaid 12, pdfjs-dist 6, lucide-react 1, eventsource 5, @slack/bolt 5 and uuid 14.

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

Because this release changes the database schema and migrates memory, also run the upgrade-path check: start `0.5.60` on a copy of a profile last used with `0.5.54`, confirm the migrations complete, memory facts appear in the memory folder, saved provider keys still work, and `0.5.54` can still open the upgraded profile.
