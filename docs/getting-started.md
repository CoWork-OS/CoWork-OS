# Getting Started with CoWork OS

<p align="center">
  <img src="../resources/branding/images/cowork-os-1.webp" alt="CoWork OS home screen" width="700">
  <br><em>The home screen is the fastest way to start tasks, reopen recent work, and launch common workflows.</em>
</p>

## Quick Start

### Step 1: Install Dependencies

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm run setup
```

### Step 2: Run the Desktop App

```bash
npm run dev
```

This will:
1. Start the Vite dev server (React UI)
2. Launch Electron with hot reload enabled
3. Open DevTools automatically

### Step 2b: Run the CLI

Build the CLI once, then launch the terminal UI:

```bash
npm run build:cli
cowork
```

For a one-shot local task:

```bash
cowork run "who are you?"
```

`cowork` uses the same local profile, database, provider settings, workspaces, skills, and MCP connector configuration as the desktop app. It does not need a Control Plane token for normal local use. If the desktop app is installed and already configured, one-shot local CLI runs prefer a hidden app-entry runtime so encrypted desktop settings keep using the same app identity.

Use remote mode only when intentionally calling a remote Control Plane endpoint:

```bash
cowork run "check the remote workspace status" --remote
```

See [CoWork OS CLI](cli.md) for command syntax, local-vs-remote behavior, JSON output, and troubleshooting.

### Step 3: Choose How CoWork Runs AI

On first launch, choose the easiest working model route for your machine:

1. **Sign in with ChatGPT** if you already use a ChatGPT subscription. This is the simplest non-technical path because it uses browser sign-in instead of an API key.
2. **Use local Ollama** if CoWork detects a model already running on your computer. This keeps model calls local and private.
3. **Use an API key** for Claude, OpenAI API, Gemini, OpenRouter, Groq, xAI, DeepSeek, Kimi, NanoGPT, Bedrock, or other compatible providers. The provider picker marks OpenRouter, Gemini, and Groq with **Free** when a free usage path is available.
4. **Explore without AI** if you only want to look around. AI tasks stay gated until one route is connected and tested.

The onboarding flow keeps your answers in the renderer while you are moving through setup. CoWork writes the profile, provider choice, memory preference, and related settings only when you confirm the final recap. The recap is a fixed review frame with a scrollable body, so long work-context notes do not push the final action off screen.

If you use the API-key path, open **Settings > AI & Models** and choose a provider:

   - **Claude** - Claude API key or Claude subscription token
   - **Google Gemini** - Gemini models through Google AI Studio; free usage is available subject to Google's current limits (API key from [aistudio.google.com](https://aistudio.google.com/apikey))
   - **OpenRouter** - Multiple models, including free model options and the Pareto Code coding router (API key from [openrouter.ai](https://openrouter.ai/keys))
   - **OpenAI API** - OpenAI API models (requires API key from [platform.openai.com](https://platform.openai.com/api-keys))
   - **ChatGPT Subscription** - browser sign-in with your ChatGPT account
   - **Groq** - low-latency hosted models with free usage available subject to Groq's current limits
   - **Grok OAuth** - Grok 4.3 with your active SuperGrok subscription, using browser sign-in
   - **xAI API Key** - Grok models billed through your xAI API account
   - **AWS Bedrock** - Enterprise AWS (requires AWS credentials)
   - **Ollama** - Local models (free, requires [Ollama](https://ollama.ai) installed)

3. If you choose **Claude**, pick one of these tabs:
   - **Claude API**: paste an API key from [console.anthropic.com](https://console.anthropic.com/)
   - **Claude Subscription**: install the provider's terminal app, run its token setup flow, and paste the generated `sk-ant-oat...` token
4. If you choose **Grok OAuth**, click **Sign in with Grok**, complete the xAI browser flow, then keep `grok-4.3` or choose another listed Grok model. No `XAI_API_KEY` is required for this path.
5. Click **Refresh Models** to load the live models available to your credential, then choose a model
   - For OpenRouter coding work, choose `openrouter/pareto-code` or `openrouter/pareto-code:nitro`. The optional Pareto score is a decimal from `0` to `1`, not a percentage.
6. Click **Test Connection** to verify
7. Save settings

After you have at least two working model routes, you can optionally create a [Mixture of Agents](mixture-of-agents.md) preset in **Settings > AI & Models > AI Model > Mixture of Agents**. Choose one aggregator model and one or more advisor models, save the preset, then select **Mixture of Agents** as the active provider and the preset as the model for tasks that benefit from model diversity.

<p align="center">
  <img src="../resources/branding/images/cowork-os-10.webp" alt="AI model provider settings" width="700">
  <br><em>Settings centralizes provider credentials, fallback routing, and model selection.</em>
</p>

### Optional: Configure Fallback Chains

After your primary provider works, open:

- **Settings > AI & Models** to set ordered fallback providers/models
- **Settings > Web Search** to set primary and fallback search providers such as Tavily, Exa, Brave, SerpAPI, or Google

CoWork OS uses those ordered chains when a provider is unavailable, rate-limited, or lacks the needed capability for a task.

Mixture of Agents uses the same underlying provider routes for its slots. Slot providers keep their own fallback chains, while MoA provider failover is configured separately when you want the whole preset to fall back after MoA fails.

For LLM providers, retryable failures such as `429` rate limits immediately advance to the next configured fallback provider/model. In **Settings > AI & Models > Provider Failover**, `Retry primary after (seconds)` controls when CoWork OS should probe the primary route again after failover:

- blank uses the default 60-second cooldown
- `0` retries the primary on the next route refresh
- higher values keep the working fallback route active longer before retrying the primary

### Optional: Configure Memory Hub And Supermemory

Before you start relying on long-term context, open **Settings > Memory Hub** and confirm how memory should behave for this profile.

- **Workspace Kit** initializes the local `.cowork/` context files used for durable prompt injection and project guidance.
- **Memory settings** control local capture, privacy mode, retention, preview of the `L0/L1` memory payload, and the Memory Inspector for structured archive observations.
- **Memory Write Approval** controls whether durable memory writes commit immediately or wait in a review queue. Use `curated_only` for hot-memory edits, `external_only` for Supermemory writes/mirrors, `background_only` for Dreaming/distillation/mirroring, or `all` for every durable memory write. Sensitive external-memory payloads are blocked before they are stored in the queue.
- **Memory Inspector** lets you search observation metadata, inspect details and timelines, edit titles/narratives, promote useful entries to curated memory, mark entries private, suppress prompt recall, redact content, soft-delete entries, and rebuild deterministic metadata when needed.
- **Durable Runtime Context** is optional. Enable it if you want long active tasks to retain sanitized task messages and source-linked compaction summaries that the agent can recover with `context_grep` and `context_describe`. It stays task-scoped by default and is erased by **Clear memory** for the workspace.
- **Supermemory** is optional. If you want an external memory provider, enable it here, paste your API key, keep the default `cowork:{workspaceId}` container template unless you need something else, save, and click **Test Connection**.

Supermemory does not replace CoWork's local memory system. It adds an external profile/search layer, explicit `supermemory_*` tools, optional prompt-time profile injection, and optional mirroring of non-private local memory captures. Local structured observations remain authoritative for privacy controls; private, redacted, and suppressed entries stay local. Dreaming also stays local and review-first by proposing memory curation candidates instead of sending memory maintenance to an external provider. If Memory Write Approval is enabled for external or background writes, `supermemory_remember` and mirror writes are staged for review instead of committed immediately. See [Structured Memory Observations](memory-observations.md), [Durable Runtime Context](durable-runtime-context.md), [Dreaming](dreaming.md), [Workspace Memory Flow](workspace-memory-flow.md#memory-write-governance), and [Supermemory Integration](supermemory.md).

## Troubleshooting

- If **Test Connection** fails with 401/403, verify the API key or token and the account permissions behind it.
- If the Claude model list is empty, click **Refresh Models** after entering your API key or Claude subscription token.
- If a provider endpoint changes, override the **Base URL** in Settings (custom providers or Groq/xAI/Kimi/OpenRouter).
- If Ollama fails to connect, confirm the service is running and the base URL is correct (default `http://localhost:11434`).
- If `cowork run` asks for a missing token, confirm you did not pass `--remote`. Local CLI tasks should run without `COWORK_CONTROL_PLANE_TOKEN`.
- If `cowork` reports missing build artifacts in a source checkout, run `npm run build:cli`.
- If `npm run setup` fails on macOS with `Killed: 9`, macOS terminated the native build due to memory pressure. The setup script retries automatically (with exponential backoff); if it still fails, close other apps and run `npm run setup` again.
- Note: as of April 4, 2026, third-party harnesses connected to your Claude account draw from extra usage instead of from your subscription. If you do not use them, nothing changes. If you do, the credit and bundles above have you covered.

### Step 4: Create Your First Task

1. **Start in the private starter workspace**
   - CoWork creates a private starter workspace automatically, so you can run a safe first task without choosing a real folder.
   - Click **Choose folder** when you want CoWork OS to work with your own files.
   - That folder becomes your workspace (e.g., `~/Documents/test-workspace`).

2. **Initialize the Workspace Kit (Optional, Recommended)**
   - Open **Settings** > **Memory Hub**
   - Under **Workspace Kit**, click **Initialize**
   - This creates a `.cowork/` directory in your workspace for durable context, prompt injection, and project scaffolding
   - The root kit can include shared workspace files such as `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `IDENTITY.md`, `RULES.md`, `SOUL.md`, `VIBES.md`, and `LORE.md`
   - `BOOTSTRAP.md` is a one-time onboarding checklist; once you complete onboarding, removing it marks onboarding complete and CoWork OS tracks that state in `.cowork/workspace-state.json`
   - `HEARTBEAT.md` is reserved for recurring heartbeat-only checks rather than general task context
   - Project-specific context lives under `.cowork/projects/<projectId>/`, where `CONTEXT.md` captures project notes and `ACCESS.md` captures project access boundaries

### Try The Everything Workbench

After the app is configured, try tasks that produce or use visible work surfaces:

- `create a small spreadsheet with 6 columns and 4 rows`
- `create a sample Word document`
- `create a two-slide presentation`
- `create a simple HTML landing page`
- `go to example.com and test the website as a normal user`
- `open my local app and test the main flow at desktop, tablet, and mobile sizes`

Generated documents, spreadsheets, presentations, and web pages appear as artifact cards and open in the right sidebar or fullscreen workbench. Live website testing opens the [Browser Workbench](browser-workbench.md), where the agent and user share the same Browser V2 in-app browser, with visible cursor movement, responsive viewport testing, accessibility snapshot refs, diagnostics, screenshots, annotation, and follow-up controls.
   - Changes to tracked kit files keep revision snapshots under `.cowork/**/.history/`
   - You can validate kit health, freshness, and secret/missing-file warnings locally with `npm run kit:lint`

2. **Create a Task**
   - Click "+ New Task"
   - Title: "Organize my files"
   - Description: "Please organize all files in this folder by file type (Images, Documents, etc.)"
   - Click "Create Task"

   Or run the same kind of local task from the terminal:

   ```bash
   cowork run "Please organize all files in this folder by file type, but ask before moving anything destructive."
   ```

3. **Watch it Work**
   - The agent will create a plan
   - Execute steps using available tools
   - Show real-time progress in the timeline
   - Request approval before destructive changes

<p align="center">
  <img src="../resources/branding/images/cowork-os-4.webp" alt="Task execution timeline" width="700">
  <br><em>Task runs show live progress, intermediate work, approvals, and outputs in one view.</em>
</p>

## Orientation: Where The New Product Surfaces Live

Once the app opens, the most important places to know are:

- **Home**: quick launch plus recent sessions and recent automation activity
- **Everything Workbench**: generated documents, spreadsheets, decks, web pages, PDFs, and previews open from task output cards into resizable sidebar or fullscreen artifact workspaces. Use this as the default place for everyday generated knowledge work: review or edit the file, then ask the agent for changes without switching to a separate Word, Excel, PowerPoint, browser, or chat app. See [Everything Workbench](everything-workbench.md).
- **Uploaded PDFs**: attach a PDF to a task or chat turn when you want CoWork to summarize it, answer questions from it, extract clauses, or transform it. The first prompt includes only a compact PDF excerpt plus page/extraction metadata and the workspace-relative path; CoWork reads the full PDF on demand with the document parser. PDF excerpts are treated as untrusted document data, and visual layout questions use the visual PDF reader instead.
- **Message box shortcuts**: type `/` in the main message box to search app commands and skill-backed workflow shortcuts in one menu. Use `/side` to ask read-only questions about the selected running session from the right panel, `/schedule` for standalone scheduled tasks, `/schedule here` for scheduled follow-ups in the selected thread, `/clear` to clear the current task view without deleting history, `/plan <task>` for Plan mode, `/cost <task>` for estimates, `/multitask [N] <task>` for bounded parallel lane work, or shortcuts such as `/strategy`, `/batch-rename`, and `/gmail-summary-drive` from the bundled CoWork Shortcuts pack. Skill-backed selections insert the slash token first so you can add context before sending; Claude-for-Legal workflows can then show structured matter-context cards in the task view. See [Message Box Shortcuts](message-box-shortcuts.md), [Side Chat](side-chat.md), [Multitask Command](multitask.md), and [Claude-for-Legal Workflows](claude-for-legal.md).
- **Task menu**: open a task and use the three-dot menu beside the title for pin/rename/archive, copy working directory/task ID/deeplink/Markdown, fork session, view outputs, or turn the current task into a same-thread or new-task automation. See [Task Automations](task-automations.md).
- **Automations**: open the main-sidebar Automation Studio to discover templates, build a versioned structured flow, test it without external writes, turn it on, and inspect step-level activity. See [Automation Studio](automation-studio.md).
- **Agents Hub**: create and inspect reusable managed agents from **Agents**. The clicked-agent detail page is for configuration and actions, not a separate chat. **Test this agent**, **Preview**, and starter prompts start a normal managed-session task and open it in the main task window, where follow-ups, approvals, responses, and outputs work like any other task. See [Managed Agents](managed-agents.md).
- **Devices**: manage the local machine and saved remote CoWork nodes, run remote tasks, and inspect remote task history
- **Settings > Automations**: advanced prompt-based Routines, Task Queue, Workflow Intelligence, Scheduled Tasks, Webhooks, Event Triggers, and Daily Briefing controls
- **Settings > Profiles**: create, switch, export, and import isolated app profiles
- **Settings > Companies**: company shell setup, goals, projects, issues, planner state, and linked operators
- **Mission Control**: company and operator monitoring, Heartbeat-agent state, global runtime queue status, workspace Mission Board, feed, and Ops view
- **Settings > Skills**: Skill Store imports plus optional external read-only skill directories
- **Settings > Channels**: Slack multi-workspace setup, Telegram group routing, Discord guild allowlists, channel/chat/thread specialization, and enterprise channels such as Feishu/Lark and WeCom
- **Settings → Tools → Computer use** (macOS): Accessibility + Screen Recording onboarding, built-in tool toggles, and context for [desktop automation](computer-use.md)
- **Settings → Memory Hub → Chronicle**: primary Chronicle setup for consent-gated recent-screen context, pause/resume, capture scope, OCR status, and linked memory behavior. The dedicated `chronicle` tool category still lives in **Settings → Tools → Built-in tools**. See [Chronicle](chronicle.md).
- **Spreadsheet artifacts**: when a task creates a spreadsheet, use the output card's **Open** action. Excel workbooks and CSV/TSV files open in the right sidebar; native Numbers, Google Sheets shortcut, ODS, and XLSB files use external-app/folder actions. Use fullscreen mode for editable spreadsheets with copy/save/zoom, row/column selection, attachments, voice input, and follow-up prompts. See [Spreadsheet Artifacts](spreadsheet-artifacts.md).
- **Document artifacts**: when a task creates a Word-style document, the output card appears in the task feed. DOCX opens directly in the right-sidebar editor with Google Docs-style controls and save/copy actions; DOC, RTF, ODT, OTT, Pages, and related formats use best-effort preview or external-app/folder actions. Fullscreen mode keeps the follow-up composer and refreshes the preview after requested edits. See [Document Artifacts](document-artifacts.md).
- **Presentation artifacts**: when a task creates a PowerPoint deck, the output card appears in the task feed. PPTX opens in the right-sidebar presentation viewer with thumbnails, slide navigation, zoom, speaker notes, and fast text-first loading while slide images render or load from cache. Fullscreen mode keeps the follow-up composer so you can request deck edits and see the preview refresh after the file is updated. See [Presentation Artifacts and PPTX Preview](pptx-generation-and-preview.md).
- **Web page artifacts**: when a task creates `.html` / `.htm` or built React output such as `dist/index.html`, the output card appears in the task feed. The main **Open** action opens a sandboxed web preview in the right sidebar; fullscreen mode keeps the follow-up composer so you can request page edits and see the preview refresh after the file or build output is updated. React-style projects without built output show a build-output-needed state instead of starting a dev server. See [Web Page Artifacts](web-page-artifacts.md).

If you are just getting started, do not configure everything at once. Set up an LLM provider, run one local task, then add Devices, Automations, or Companies as needed.

## Optional: Try Chronicle

Use this if you want CoWork OS to understand vague on-screen references from the desktop app.

1. Open **Settings > Memory Hub > Chronicle**.
2. Turn on **Chronicle (Research Preview)** and accept the consent prompt.
3. Grant **Screen Recording** for CoWork OS if macOS prompts for it.
4. Optional but useful: grant **Accessibility** so Chronicle can attach better frontmost app/window metadata.
5. Confirm **Settings > Tools > Built-in tools** still has **Chronicle** enabled.
6. Restart the app if you changed Screen Recording.
7. Put a window with distinctive visible text on screen for 15-30 seconds.
8. Start a fresh task with the per-task **Chronicle ON** toggle left enabled and ask:

```text
Use screen_context_resolve now. Tell me what app and window are on screen and what text is visible on the right side.
```

Once that works, try vaguer prompts such as `what is this on screen` or `why is this failing`. You can later pause Chronicle from the Chronicle settings card or the tray menu instead of turning it off entirely.

See [Chronicle](chronicle.md) for the full guide and [Troubleshooting](troubleshooting.md#chronicle-desktop-screen-context-issues) if it does not trigger.

## Optional: Add A Remote Device

Use this when you want CoWork OS to run tasks on another machine, such as a Mac mini or remote workstation.

1. Start CoWork on the remote machine and enable the Control Plane.
2. Decide how you will reach it:
   - same LAN
   - SSH tunnel
   - Tailscale
   - reverse proxy only when the Control Plane stays loopback/private and `COWORK_CONTROL_PLANE_ALLOWED_ORIGINS` is set
3. On your main machine, open the **Devices** tab.
4. Click **Add new device**.
5. Enter the gateway URL, token, display name, and purpose.
6. Connect the device and confirm it appears in the device list.
7. Select that device and run a small test task.

After connection, you can browse remote workspaces, attach files from the remote machine, and inspect remote task history from the same Devices surface.

For VPS/headless deployments, prefer SSH tunnels or Tailscale. Direct `0.0.0.0`/`::` Control Plane binds fail closed unless Tailscale, private container context, or an explicit break-glass override is configured.

## Optional: Set Up Profiles

Use profiles when you want separate CoWork environments for personal work, clients, staging, or isolated channel credentials.

Typical profile workflow:

1. Open **Settings > Profiles**.
2. Create a new profile or duplicate your current one.
3. Switch into that profile before configuring channels, providers, or skills.
4. Use **Export Profile** to create a transferable profile bundle.
5. Use **Import Profile** on another machine or install to restore the same setup, with optional rename on import.

Each profile keeps its own local database, encrypted settings, managed skills, channel configs, and session history.

## Optional: Turn On Automations

Open **Automations** in the main sidebar when you want to build a structured flow. Start from a template, a conservative prompt-generated draft, or a blank flow; test it with sample JSON; review its scopes and approvals; save the draft; and select **Turn on** only after validation passes. See [Automation Studio](automation-studio.md).

Open **Settings > Automations** for advanced queue policy, prompt-based Routines, lower-level schedules/hooks/triggers, Daily Briefing, and Workflow Intelligence.

Recommended order:

1. **Automation Studio**: create one safe flow, keep it manual at first, run a dry test, then turn it on and inspect Activity.
2. **Task Queue**: confirm concurrency and timeout defaults for wider background execution.
3. **Routines**: use a prompt-based routine only when a deterministic multi-step graph is unnecessary.
4. **Daily Briefing**: enable a daily summary if you want background context generation.
5. **Webhooks / Event Triggers**: connect inbound automation only after you have a stable workspace and provider setup, and only when you need the lower-level surfaces directly.
6. **Workflow Intelligence**: enable reviewable Next actions once you have at least one stable workflow target. Dreaming can then curate memory candidates from completed work and memory-specific Heartbeat signals. Code-change auto-create works best on trusted git-backed workspaces where worktrees are available.

Rule of thumb:

- use Automation Studio for a structured multi-step flow with variables, branches, testing, approvals, and step-level activity
- use prompt-based `Routines` for one saved instruction block with target, policy, outputs, and run history
- use `Scheduled Tasks`, `Webhooks`, or `Event Triggers` directly only when you specifically need the advanced underlying engine
- use a task's three-dot menu and `Add automation...` when a task you just ran should become a recurring automation; this creates a task-sourced routine, continues the same thread by default, and preserves a source task/deeplink reference

## Zero-Human Company Quick Start

If you want to use CoWork OS as a founder-operated autonomous company shell:

1. Choose a real git-backed workspace.
2. Open **Settings** > **Memory Hub**.
3. Initialize **Venture operator kit**.
4. Fill in the generated `.cowork/` company files (`COMPANY.md`, `OPERATIONS.md`, `KPIS.md`, `PRIORITIES.md`, `HEARTBEAT.md`).
5. Open **Settings** > **Companies**.
6. Create or select the company shell you want to operate.
7. Click **Open Digital Twins** from that company.
8. Activate:
   - `Company Planner`
   - `Founder Office Operator`
9. Enable heartbeat for both operators.
10. Return to **Settings** > **Companies** and confirm the operators are linked to the intended company.
11. Open **Mission Control** from that company.
12. In the planner strip, enable scheduling, set the planner agent, and click **Run Planner**.
13. Use the `Ops` tab to monitor goals, projects, planner-managed issues, and linked execution runs.

See [Zero-Human Company Operations](zero-human-company.md) for the full architecture, recipe, use cases, and operating model.

## Example Tasks to Try

### 1. File Organization

```
Title: Organize Downloads
Description: Organize all files in this folder by type. Create folders for Images, Documents, Spreadsheets, and Other. Move files into appropriate folders.
```

### 2. Create a Spreadsheet

```
Title: Create sales report
Description: Create an Excel spreadsheet with monthly sales data for Q1-Q4. Include columns for Month, Revenue, Expenses, and Profit. Add a summary row with totals.
```

### 3. Create a Document

```
Title: Write project summary
Description: Create a Word document summarizing our project. Include sections for Overview, Goals, Timeline, and Next Steps. Use professional formatting.
```

### 4. Create a Presentation

```
Title: Create quarterly report
Description: Create a PowerPoint presentation with 5 slides covering Q1 2024 highlights. Include: Title slide, Overview, Key Metrics, Challenges, and Next Steps.
```

When the task completes, the `.pptx` appears as a presentation artifact card. Click **Open** to inspect it in the right-sidebar viewer with thumbnails, slide navigation, zoom, extracted speaker notes, and a white slide canvas. CoWork shows slide text immediately, then loads cached or freshly rendered slide images in the background. Use fullscreen mode when you want to request follow-up deck edits from the same viewer.

### 5. Web Research (works out of the box; optional paid providers for richer results)

```
Title: Research AI trends
Description: Search the web for the latest trends in AI for 2024 and create a summary document with the top 5 findings.
```

### 6. Browser Automation

```
Title: Screenshot a webpage
Description: Navigate to https://example.com and take a screenshot. Save it as example-screenshot.png.
```

Interactive browser tasks use the visible Browser Workbench by default. For form testing or JavaScript-heavy apps, the agent should navigate, call `browser_snapshot`, and then use refs for click/fill/type/read actions. For responsive checks, use `browser_emulate` before screenshots or snapshots so the shared workbench and saved captures reflect the tested desktop/tablet/mobile viewport. Real signed-in Chrome/Edge control is explicit opt-in through `browser_attach`; the default workspace browser profile does not reuse system Chrome cookies.

Browser Use Cloud stealth browsers are available only as an explicit opt-in backend. Configure `BROWSER_USE_API_KEY`, then request `browser_provider: "browser-use-cloud"` for a public HTTP(S) site. Cloud mode is blocked for localhost, private networks, `file:` URLs, generated local HTML artifacts, and intranet-style hostnames; use the default visible Browser Workbench for those targets. Browser Use Cloud sessions are stopped by `browser_close`, and retryable pending-stop results include the Browser Use session id if the stop API fails.

### 7. Inspect An Uploaded Video

Attach an `.mp4`, `.mov`, or `.webm` file and ask:

```
Title: Inspect the demo recording
Description: Review the attached video. Summarize the visible UI states, any failures, and the final outcome.
```

CoWork samples the video into representative still frames for image-capable models. The task timeline shows the extracted contact sheet and representative full frame as inline image artifacts, so you can inspect the same screenshots the agent used. See [Video Attachments](video-attachments.md).

## Understanding the UI

### Sidebar (Left)

- **Workspace Info**: Shows current workspace name and path
- **Settings Button**: Configure LLM, search, and channel settings
- **New Task Button**: Create a new task
- **Task List**: All tasks sorted by creation date
- **Task Status Indicators**:
  - Blue = Active (planning/executing)
  - Green = Completed
  - Red = Failed/Cancelled
  - Gray = Pending

### Task View (Right)

- **Task Header**: Title and metadata
- **Task Description**: What you asked for
- **Activity Timeline**: Real-time execution log showing:
  - Task created
  - Plan created
  - Steps started/completed
  - Tool calls
  - Files created/modified
  - Errors

### Approval Dialogs

When the agent needs permission for:
- Deleting files
- Bulk operations
- Shell commands

You'll see a dialog with:
- What it wants to do
- Why it needs to do it
- Approve or Deny buttons

## Configuring Providers

### LLM Providers

Open **Settings** > **LLM**:

| Provider | Setup |
|----------|-------|
| Claude | Use **Claude API** with a key from [console.anthropic.com](https://console.anthropic.com), or use **Claude Subscription** with a token from `claude setup-token` |
| Google Gemini | Enter API key from [aistudio.google.com](https://aistudio.google.com/apikey); Google AI Studio free usage may be available subject to current limits |
| OpenRouter | Enter API key from [openrouter.ai](https://openrouter.ai/keys); free model options are available, and `openrouter/pareto-code` / `openrouter/pareto-code:nitro` support coding-score-based routing |
| OpenAI (API Key) | Enter API key from [platform.openai.com](https://platform.openai.com/api-keys) |
| OpenAI (ChatGPT) | Click "Sign in with ChatGPT" to use your subscription |
| AWS Bedrock | Enter AWS Access Key, Secret Key, and Region |
| Ollama | Install Ollama, pull a model, select it |
| Groq | Enter API key in Settings; free usage may be available subject to current limits |
| xAI (Grok API) | Enter API key in Settings |
| xAI Grok OAuth | Sign in with Grok to use an active SuperGrok subscription; defaults to `grok-4.3` |
| Kimi (Moonshot) | Enter API key in Settings |

Prompt caching is enabled by default on supported Anthropic and GPT-style routes. CoWork automatically keeps stable session prompt sections cacheable and dynamic turn context uncached, so follow-ups can reuse the provider-side prefix without caching the clock, recall, or one-off guidance.

### Compatible / Gateway Providers

Configure these in **Settings** > **LLM Provider** by entering API keys/tokens, model IDs, and base URLs when required.

| Provider | Setup |
|----------|-------|
| OpenCode Zen | API key + base URL in Settings |
| Google Vertex | Access token + base URL in Settings |
| Google Antigravity | Access token + base URL in Settings |
| Google Gemini CLI | Access token + base URL in Settings |
| Z.AI | API key + base URL in Settings |
| GLM | API key + base URL in Settings |
| Vercel AI Gateway | API key in Settings |
| Cerebras | API key in Settings |
| Mistral | API key in Settings |
| GitHub Copilot | GitHub token in Settings |
| Moonshot (Kimi) | API key in Settings |
| Qwen Portal | API key in Settings |
| MiniMax | API key in Settings |
| MiniMax Portal | API key in Settings |
| Xiaomi MiMo | API key in Settings |
| Venice AI | API key in Settings |
| Synthetic | API key in Settings |
| Kimi Code | API key in Settings |
| OpenAI-Compatible (Custom) | API key + base URL in Settings |
| Anthropic-Compatible (Custom) | API key + base URL in Settings |

Advanced override: prompt caching can be disabled manually with `promptCaching.mode: "off"` in the saved LLM settings payload or by launching the app with `COWORK_PROMPT_CACHE_MODE=off`.

### Search Providers (Optional — DuckDuckGo works out of the box)

Web search works immediately via the built-in DuckDuckGo provider (free, no API key). For richer results (news, images, AI-optimized ranking), configure a paid provider in **Settings** > **Web Search**:

| Provider | Setup |
|----------|-------|
| DuckDuckGo | Built-in — no setup needed (automatic fallback) |
| Tavily | Enter API key from [tavily.com](https://tavily.com) |
| Exa | Enter API key from [exa.ai](https://exa.ai/) |
| Brave | Enter API key from [brave.com/search/api](https://brave.com/search/api) |
| SerpAPI | Enter API key from [serpapi.com](https://serpapi.com) |
| Google | Enter API key and Search Engine ID from Google Cloud Console |

### Channel Integrations (Optional)

#### WhatsApp Bot
1. Open **Settings** > **WhatsApp**
2. Click **Add WhatsApp Channel**
3. A QR code will appear
4. Open WhatsApp on phone → **Settings** > **Linked Devices** > **Link a Device**
5. Scan the QR code
6. Once connected, enable **Self-Chat Mode** if using your personal number
7. Set a **Response Prefix** (e.g., "🤖") to distinguish bot messages

After connection, WhatsApp uses the shared gateway message lifecycle: send normal text to start or follow up on a task, `/new` for a fresh next task, `/new temp` for a scratch temporary session, `/stop` to cancel, and `/commands` for the current remote command catalog. See [Using CoWork from WhatsApp and Other Channels](gateway-user-guide.md) for examples and best practices.

For shared groups or dedicated operational channels, use **Channel Specialization** in the channel settings to default a channel, group, or topic/thread to a workspace, agent role, prompt guidance, tool restrictions, and optional shared-memory policy.

#### Telegram Bot
1. Create bot with [@BotFather](https://t.me/BotFather)
2. Open **Settings** > **Channels** > **Telegram**
3. Enter bot token
4. Optionally set a group routing mode (`all`, `mentionsOnly`, `mentionsOrCommands`, `commandsOnly`)
5. Optionally add allowed Telegram group chat IDs if the bot should only respond in specific groups
6. Enable and test

#### Discord Bot
1. Create app at [Discord Developer Portal](https://discord.com/developers/applications)
2. Open **Settings** > **Channels** > **Discord**
3. Enter bot token and application ID
4. Invite bot to server
5. Optionally add allowed Guild IDs if the bot should ignore other servers
6. Enable and test

#### Slack Bot
1. Create app at [Slack API Apps](https://api.slack.com/apps)
2. Enable Socket Mode and create App-Level Token (xapp-...)
3. Add OAuth scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `files:write`
4. Subscribe to events: `app_mention`, `message.im`
5. Install to workspace and copy Bot Token (xoxb-...)
6. Open **Settings** > **Channels** > **Slack**
7. Enter Bot Token and App-Level Token
8. Repeat **Add Slack Workspace** if you want more than one Slack installation in the same CoWork profile
9. Enable and test

#### Feishu / Lark
1. Create a bot/app in the Feishu or Lark developer console
2. Copy the App ID, App Secret, verification token, and event encryption key
3. Open **Settings** > **Channels** > **Feishu / Lark**
4. Enter credentials, set the webhook/event callback URL shown by CoWork, then enable and test

#### WeCom
1. Create a WeCom app in the WeCom admin console
2. Copy the Corp ID, Agent ID, Secret, token, and EncodingAESKey
3. Open **Settings** > **Channels** > **WeCom**
4. Enter credentials, configure the callback URL shown by CoWork in WeCom, then enable and test

### App Integrations (Optional)

Open **Settings** > **Integrations** and click any card to configure productivity and storage tools:

- **Notion** — search and manage pages
- **Box** — search and manage files
- **OneDrive** — search and manage files
- **Google Workspace** (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Chat) — shared OAuth
- **Dropbox** — list, search, and manage files
- **SharePoint** — search sites and manage drive items

After an integration is configured, type `@` in the main message box to pick it from the grouped **Agents**, **Integrations**, and **Files** menu. Google Workspace appears as service-specific options such as Gmail, Google Drive, Google Calendar, Google Docs, Google Sheets, Google Slides, Google Tasks, and Google Chat when native or MCP-backed tools are available. Selecting an integration inserts an icon+name chip and sends soft routing metadata with the prompt. See [Composer Mentions](composer-mentions.md).

Google Workspace uses one shared OAuth connection for built-in tools and the Google Workspace MCP connector. If an existing connection is missing newer scopes for services such as Calendar MCP tools, Tasks, or Slides, reconnect from **Settings > Integrations > Google Workspace** and leave the default scope set enabled.

For slash-searchable app commands and workflow shortcuts, type `/` in the same message box. The `/` picker is separate from `@` mentions and uses the skills/plugin-pack system for workflow aliases. Selecting a skill-backed workflow inserts the command into the composer so you can add more text before sending. Legal practice workflows can also ask for structured matter details in the main task view. See [Message Box Shortcuts](message-box-shortcuts.md) and [Claude-for-Legal Workflows](claude-for-legal.md).

### Enterprise MCP Connectors (Optional)

Install enterprise connectors from **Settings** > **Integrations** > **Browse Registry**:

| Connector | Type | Setup |
|-----------|------|-------|
| **Salesforce** | CRM | OAuth or API key |
| **Jira** | Issue Tracking | API token + domain |
| **HubSpot** | CRM | API key |
| **Zendesk** | Support | API key + subdomain |
| **ServiceNow** | ITSM | OAuth or credentials |
| **Linear** | Product/Issue | API key |
| **Asana** | Work Management | Personal access token |
| **Okta** | Identity | API token + domain |
| **Discord** | Community | Bot token + application ID |
| **Google Workspace** | Productivity | Shared OAuth in-app flow; reconnect when newer required scopes are missing |
| **Rhino** | Architecture/CAD | Localhost Rhino bridge + `COWORK_ARCH_PROJECT_ROOT` |
| **Blender** | 3D/Rendering | Localhost Blender bridge + `COWORK_ARCH_PROJECT_ROOT` |
| **ComfyUI** | Image Generation | Local ComfyUI API + `COWORK_ARCH_PROJECT_ROOT` |

Most service connectors provide tools like `search`, `get`, `create`, and `update` for their respective APIs. Local creative connectors provide app-specific tools for Rhino, Blender, and ComfyUI; their file arguments must stay inside `COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`. **47 connectors** are available in total, including Stripe, Tavily, Grafana, Metabase, Socket, Rhino, Blender, ComfyUI, and more. See [Enterprise Connectors](enterprise-connectors.md) for the full catalog.

### Social Integrations (Optional)

#### X (Twitter)
1. Open **Settings** > **X (Twitter)**
2. Choose Browser Cookies or Manual Cookies
3. (Optional) Enable **Mention Trigger** and configure:
   - command prefix (default `do:`)
   - allowlisted authors
   - poll interval and fetch count
4. Save and test the connection
5. See [X Mention Triggers](x-mention-triggers.md) for bridge/native behavior and troubleshooting.

## Development Workflow

### Making Changes

The app supports hot reload:

1. **React UI Changes**: Edit files in `src/renderer/` - auto-refreshes
2. **Electron Main Changes**: Edit files in `src/electron/` - auto-restarts
3. **Shared Types**: Edit `src/shared/types.ts` - both reload

### Project Structure

```
src/
├── electron/          # Backend (Node.js)
│   ├── main.ts       # App entry point
│   ├── agent/        # AI agent logic
│   │   ├── llm/      # LLM providers
│   │   ├── search/   # Search providers
│   │   ├── browser/  # Browser V2 session manager and workbench bridge
│   │   ├── tools/    # Tool implementations
│   │   └── skills/   # Document skills
│   ├── gateway/      # WhatsApp, Telegram, Discord & Slack
│   └── database/     # SQLite storage
├── renderer/         # Frontend (React)
│   ├── App.tsx       # Main component
│   └── components/   # UI components
└── shared/           # Shared between both
    └── types.ts      # TypeScript types
```

### Debugging

**Renderer Process (UI)**:
- DevTools open automatically in dev mode
- Use `console.log()` - shows in DevTools Console

**Main Process (Backend)**:
- Use `console.log()` - shows in terminal
- Check logs:
  - macOS: `~/Library/Application Support/cowork-os/`
  - Windows: `%APPDATA%\\cowork-os\\`

### Database

SQLite database location:
- macOS: `~/Library/Application Support/cowork-os/cowork-os.db`
- Windows: `%APPDATA%\\cowork-os\\cowork-os.db`

View it with any SQLite browser or:
```bash
# macOS
sqlite3 ~/Library/Application\ Support/cowork-os/cowork-os.db
.tables
SELECT * FROM tasks;
```

```powershell
# Windows (PowerShell)
sqlite3 "$env:APPDATA\cowork-os\cowork-os.db"
.tables
SELECT * FROM tasks;
```

## Building for Production

```bash
# Build both renderer and electron
npm run build

# Package desktop app
npm run package
```

Output: `release/*.dmg` (macOS) and `release/*.exe` (Windows)

## Common Issues

### Issue: "No LLM provider configured"

**Solution**: Open Settings (gear icon) and configure at least one LLM provider.

### Issue: Electron won't start

**Solution**: Clear and reinstall:
```bash
rm -rf node_modules dist
npm run setup
npm run dev
```

### Issue: "Permission denied" for workspace

**Solution**: Choose a folder you have write access to, like:
- `~/Documents/cowork-test`
- `~/Downloads/test`

Don't use system folders like `/System` or `/Applications`.

### Issue: Tasks fail immediately

**Solution**: Check:
1. LLM provider is configured in Settings
2. API key is valid
3. Workspace has proper permissions
4. Network connection for API calls
5. Check console for error messages

### Issue: Ollama connection failed

**Solution**:
1. Make sure Ollama is running: `ollama serve`
2. Check URL is correct (default: `http://localhost:11434`)
3. Make sure you've pulled a model: `ollama pull llama3.2`

## Tips for Best Results

1. **Be Specific**: Clear task descriptions work better
2. **Start Small**: Test with a few files before bulk operations
3. **Review Plans**: Check the execution plan before it runs
4. **Respond Carefully**: Read approval requests and structured input prompts before accepting or submitting
5. **Monitor Progress**: Watch the timeline to understand what's happening, especially when parallel tool groups collapse into summary lanes
6. **Use Local Models**: Ollama is free and works offline

## Next Steps

### Try Advanced Features

1. **Web Search**: Configure a search provider and ask research questions
2. **Browser Automation**: Have the agent navigate websites and extract data
3. **Remote Access**: Set up WhatsApp, Telegram, Discord, or Slack bot for mobile/remote access
4. **Document Creation**: Create professional Excel, Word, PDF, or PowerPoint files
5. **Goal Mode**: Define success criteria and let the agent auto-retry until verification passes
6. **Custom Skills**: Create reusable workflows with custom prompts in Settings > Custom Skills
7. **MCP Servers**: Connect to external tools via MCP in Settings > MCP Servers
8. **Enterprise Connectors**: Install from 47 connectors (Salesforce, Jira, HubSpot, Stripe, Tavily, Grafana, Rhino, Blender, ComfyUI, and more) via Settings > Connectors
9. **Cloud Storage/Productivity**: Connect Notion, Box, OneDrive, Google Workspace (Gmail/Calendar/Drive/Docs/Sheets/Slides/Tasks/Chat), Dropbox, or SharePoint — click their cards in Settings > Integrations
10. **Parallel Tasks**: Run multiple tasks concurrently (configure in Settings > Task Queue)
11. **Guardrails**: Set token/cost budgets and blocked commands in Settings > Guardrails

### Learn More

- [Full README](README.md) - Complete documentation
- [Implementation Summary](IMPLEMENTATION_SUMMARY.md) - Technical details
- [Project Status](PROJECT_STATUS.md) - Feature status

## Getting Help

- Check console output for errors
- Review the task timeline for clues
- Read error messages in the UI
- Report issues at [GitHub Issues](https://github.com/CoWork-OS/CoWork-OS/issues)
