# Changelog

All notable changes to CoWork OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
| 0.3.25 | 2025-02-05 | Google Workspace integration, gateway enhancements, agent retry logic |
| 0.1.6 | 2025-01-25 | Discord bot integration with slash commands |
| 0.1.5 | 2025-01-25 | Browser automation with Playwright |
| 0.1.4 | 2025-01-25 | Real Office format support (Excel, Word, PDF, PowerPoint) |
| 0.1.3 | 2025-01-25 | Telegram bot, web search, Ollama support |
| 0.1.0 | 2025-01-24 | First public release with core features |
| 0.0.1 | 2025-01-20 | Initial development setup |

[Unreleased]: https://github.com/CoWork-OS/CoWork-OS/compare/v0.3.25...HEAD
[0.3.25]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.3.25
[0.1.6]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.6
[0.1.5]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.5
[0.1.4]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.4
[0.1.3]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.3
[0.1.0]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.1.0
[0.0.1]: https://github.com/CoWork-OS/CoWork-OS/releases/tag/v0.0.1
