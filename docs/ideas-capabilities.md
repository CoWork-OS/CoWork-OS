# Ideas Panel: Supported Capabilities

The Ideas panel shows use case prompts that CoWork OS can execute. Each idea uses **built-in capabilities** that are available by default or via standard integrations.

For the full inbox workspace, see [Inbox Agent](inbox-agent.md).

## Core Capabilities (Always Available)

| Capability | Tools / Commands | Notes |
|------------|------------------|-------|
| **Channels** | `channel_list_chats`, `channel_history` | Works with Slack, iMessage, WhatsApp, Telegram, Email (configured per workspace) |
| **File I/O** | `read_file`, `write_file` | Workspace files, artifacts |
| **LaTeX compile** | `compile_latex` | Optional system TeX engine required for PDF output; keeps `.tex` source if unavailable |
| **Shell** | `run_command` | Local commands (with approval) |
| **Web fetch** | `web_fetch` | Static pages, APIs |
| **Browser** | `browser_navigate`, `browser_snapshot`, ref-aware `browser_click` / `browser_fill`, diagnostics, screenshots | Forms, interactive sites, JavaScript apps, visual QA |
| **Scraping** | `scrape_page`, `scrape_multiple` | Structured extraction |
| **Location** | `get_current_location` | One-time OS permission prompt; feeds into Maps MCP for nearby search and routes |
| **Slash skills** | `/simplify`, `/batch`, `/llm-wiki` | Quality passes, parallel migrations, persistent research vaults |

## Integration-Dependent (Graceful Fallbacks)

| Capability | Primary | Fallback | Notes |
|------------|---------|----------|-------|
| **Inbox** | `gmail_action` | `email_imap_unread` → Email channel history | Prompts use "prefer X; if unavailable use Y" |
| **Calendar** | `calendar_action` (Google) | `apple_calendar_action` (macOS) | For conflict checks, digest |
| **Tasks** | `google-workspace.tasks_*`, Notion, Things, Apple Reminders | — | If configured; delete and clear-completed flows require confirmation |
| **Google Slides** | `google-workspace.slides_*` | Local presentation artifacts | Connected deck creation and practical mutations; delete, replace-all, and raw batch updates require confirmation |

## Ideas Panel Scope

Ideas shown in the panel use only the capabilities above. Prompts are written to work when integrations are missing (e.g. inbox triage falls back to Email channel; calendar steps are skipped if no calendar).

For advanced use cases that require **optional skills** (e.g. legal contract review, demand letter draft), see [Use Cases](use-cases.md) for copy-paste prompts. Those skills must be installed from Settings → Plugin Packs or Skills.
