# Release Notes 0.5.42

Release `0.5.42` is a Windows installer hotfix for `0.5.41` with composer routing, message-box shortcut, integration mention, and bundled-skill documentation refreshes.

## Added

- **Linux server release package**: GitHub releases can now include `cowork-os-server-linux-x64-v<version>.tar.gz` plus a `.sha256` checksum for VPS/systemd deployments. The package runs `coworkd-node`, includes built daemon assets, full resources, connector runtimes, runtime dependencies, and is smoke-tested through the Control Plane `/health` endpoint. See [Linux VPS](vps-linux.md).
- **Task-sourced scheduled automations**: task view now includes `... > Add automation...`, opening a task-prefilled modal that saves a real cron scheduled task through the existing scheduler API. Saved jobs include the source task title, task ID, and `cowork://tasks/<taskId>` deeplink. See [Task Automations](task-automations.md).
- **React/Next.js implementation guidance**: added the bundled `react-best-practices` skill for React workspace changes, Next.js feature work, reviews, refactors, data-fetching improvements, bundle-size checks, and rendering-performance fixes. See [React Best Practices Skill](skills/react-best-practices.md).
- **Composer mentions**: typing `@` in the message box now opens a grouped menu for Agents, configured Integrations, and Files. Integration selections insert rich icon+name chips, render the same way in sent user messages and restored sessions, and pass `integrationMentions` metadata as soft runtime guidance. See [Composer Mentions](composer-mentions.md).
- **`@Inbox` shortcut**: typing `@Inbox` or `@inbox ...` in the main composer now opens Inbox Agent and routes the query through Ask Inbox.
- **Message box shortcuts**: typing `/` in the message box now searches deterministic app commands and skill-backed workflow shortcuts in one picker. Built-in app commands include `/schedule`, `/clear`, `/plan`, `/cost`, `/compact`, `/doctor`, and `/undo`; plugin-pack aliases resolve through the skills runtime. See [Message Box Shortcuts](message-box-shortcuts.md).
- **CoWork Shortcuts pack**: added a bundled workflow-shortcuts pack with aliases such as `/strategy`, `/review`, `/memory`, `/batch-rename`, `/smart-deduplication`, `/folder-structure`, `/gmail-summary-drive`, `/calendar-prep-brief`, `/multi-source-report`, `/weekly-newsletter`, `/daily-inbox-zero`, `/monday-planning-brief`, and `/end-of-day-log`.
- **Smart PDF attachments**: uploaded PDFs now enter the prompt as compact attachment metadata plus an excerpt instead of a full inline dump. When the user asks for deeper PDF content, CoWork reads the workspace-local file with `parse_document`; chat-mode PDF turns are narrowly promoted to read-only analysis so full-document Q&A and summaries work without enabling mutating tools.

## Fixed

- **Windows installer architecture**: the Windows release artifact is now built as an x64 app package, so standard Windows PCs install `CoWork OS.exe` correctly and desktop shortcuts point to a runnable executable.
- **Release packaging guardrail**: added an explicit `package:win:x64` packaging command so Windows release artifacts are not accidentally built with the host Mac architecture.
- **Composer deletion stability**: fixed duplicate `@` rendering and the React `removeChild` crash when deleting mention text or chips.
- **Shortcut command safety**: `/clear` now clears the current task view without deleting history or switching workspace context; `/schedule` keeps deterministic schedule-handler precedence even when another task is selected.
- **Google Workspace reconnect recovery**: stale Google Workspace OAuth tokens are cleared after refresh bad-request failures, and changed Google OAuth client credentials/scopes clear old tokens before reconnect.
- **Azure OpenAI tool-result replay**: long Responses fallback tool-call ids are normalized before replay so Azure OpenAI no longer rejects those turns with a `call_id` length error.
- **PDF attachment safety**: prompt-time PDF excerpts now carry an explicit untrusted-content boundary, scanned/image-heavy PDFs report scan/OCR status accurately, and visual PDF analysis remains separate from ordinary document text extraction.

## Changed

- **Automation concept docs**: README, Features, Core Automation, docs home, and Development now clarify that task automations are a shortcut into `Scheduled Tasks`, not a separate Workflow Intelligence loop or routine authoring path.
- **Bundled-skill docs**: README, Features, Skill Store, development guidance, docs home, and status docs now reflect `react-best-practices` and the 147 built-in skill count.
- **Shortcut docs**: README, Features, Plugin Packs, Skills Runtime Model, Skill Store, Development, Use Cases, docs home, changelog, and this release note now describe the current message-box shortcut model, alias precedence, parameter behavior, and CoWork Shortcuts pack.
- **Integration display in the composer**: Google Workspace is shown as Gmail, Google Drive, and Google Calendar in the `@` menu; gateway channels and MCP connectors appear only when locally usable.

## Notes

The `0.5.41` npm package remains published, but the GitHub `v0.5.41` release is immutable and its Windows asset cannot be replaced in place. Use `0.5.42` for Windows installs.
