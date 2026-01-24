# CoWork-OSS

[![CI](https://github.com/mesutfelat/cowork-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/mesutfelat/cowork-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos/)
[![Electron](https://img.shields.io/badge/electron-40.0.0-47848F.svg)](https://www.electronjs.org/)

**Local-first agent workbench for folder-scoped tasks (BYOK)**

```
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗       ██████╗ ███████╗███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝      ██╔═══██╗██╔════╝██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗██║   ██║███████╗███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ╚════╝██║   ██║╚════██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗      ╚██████╔╝███████║███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═════╝ ╚══════╝╚══════╝
```

CoWork-OSS is an open-source, local-first agent workbench for running multi-step tasks in a folder-scoped workspace, with explicit approvals for destructive actions and built-in skills for generating documents, spreadsheets, and presentations.

**You bring your own model credentials (Anthropic API / AWS Bedrock); usage is billed by your provider.**

> **Independent project.** CoWork-OSS is not affiliated with, endorsed by, or sponsored by Anthropic.
> This project implements a local, folder-scoped agent workflow pattern in open source.

---

## Why CoWork-OSS?

- **Local-first state**: Tasks/events/artifacts are stored locally in SQLite; model requests are sent to your configured provider (Anthropic/Bedrock). No telemetry by default.
- **Folder-scoped security**: Operations are sandboxed to your selected workspace with path traversal protection
- **Permissioned execution**: Explicit user approval required for destructive operations (delete, bulk rename)
- **Extensible skills/tools**: Clear developer path to add custom tools and skills
- **Transparent runtime**: Real-time timeline showing every step, tool call, and decision
- **BYOK (Bring Your Own Key)**: Use your own API credentials — no proxy, no reselling

---

## Providers & Costs (BYOK)

CoWork-OSS is **free and open source**. To run tasks, you must configure your own model credentials.

| Provider | Configuration |
|----------|---------------|
| Anthropic API | Set `ANTHROPIC_API_KEY` in `.env` |
| AWS Bedrock | Configure AWS credentials in Settings |

**Your usage is billed directly by your provider.** CoWork-OSS does not proxy or resell model access.

---

## Features

### Core Capabilities

- **Task-Based Workflow**: Multi-step task execution with plan-execute-observe loops
- **Workspace Management**: Sandboxed file operations within selected folders
- **Permission System**: Explicit approval for destructive operations
- **Skill System**: Built-in skills for creating professional outputs:
  - Spreadsheet creation (Excel format)
  - Document creation (Word/PDF)
  - Presentation creation (PowerPoint)
  - Folder organization
- **Real-Time Timeline**: Live activity feed showing agent actions and tool calls
- **Artifact Tracking**: All created/modified files are tracked and viewable
- **Model Selection**: Choose between Opus, Sonnet, or Haiku models

## Data handling (local-first, BYOK)
- Stored locally: task metadata, timeline events, artifact index, workspace config (SQLite).
- Sent to provider: the task prompt and any context you choose to include (e.g., selected file contents/snippets) to generate outputs.
- Not sent: your API keys (stored locally), unless you explicitly configure external syncing.

### Architecture

```
┌─────────────────────────────────────────────────┐
│              React UI (Renderer)                 │
│  - Task List                                     │
│  - Task Timeline                                 │
│  - Approval Dialogs                              │
│  - Workspace Selector                            │
└─────────────────────────────────────────────────┘
                      ↕ IPC
┌─────────────────────────────────────────────────┐
│            Agent Daemon (Main Process)           │
│  - Task Orchestration                            │
│  - Agent Executor (Plan-Execute Loop)            │
│  - Tool Registry                                 │
│  - Permission Manager                            │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│                  Execution Layer                 │
│  - File Operations                               │
│  - Skills (Document Creation)                    │
│  - Provider Abstraction (Anthropic/Bedrock)      │
└─────────────────────────────────────────────────┘
                      ↕
┌─────────────────────────────────────────────────┐
│              SQLite Local Database               │
│  - Tasks, Events, Artifacts, Workspaces          │
└─────────────────────────────────────────────────┘
```

---

## Setup

### Prerequisites

- Node.js 18+ and npm
- macOS (for Electron native features)
- API credentials (Anthropic API key or AWS Bedrock access)

### Installation

```bash
# Clone the repository
git clone https://github.com/mesutfelat/cowork-oss.git
cd cowork-oss

# Install dependencies
npm install

# Configure your API credentials
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run in development mode
npm run dev
```

### Building for Production

```bash
npm run build
npm run package
```

The packaged app will be in the `release/` directory.

---

## Usage

### 1. Select a Workspace

On first launch, select a folder where CoWork-OSS can work. This folder will be:
- Mounted for read/write access
- Protected by permission boundaries
- Used as the working directory for all tasks

### 2. Create a Task

Click "New Task" and describe what you want to accomplish:

**Example Tasks:**
- "Organize my Downloads folder by file type"
- "Create a quarterly report spreadsheet with Q1-Q4 data"
- "Generate a presentation about our product roadmap"
- "Analyze these CSV files and create a summary document"

### 3. Monitor Execution

Watch the task timeline as the agent:
- Creates an execution plan
- Executes steps using available tools
- Requests approvals for destructive operations
- Produces artifacts (files)

### 4. Approve Requests

When the agent needs to perform destructive actions, you'll see an approval dialog. Review the details and approve or deny.

---

## Security & Safety

### Important Warnings

- **Don't point this at sensitive folders** — select only folders you're comfortable giving the agent access to
- **Use version control / backups** — always have backups of important files before running tasks
- **Review approvals carefully** — read what the agent wants to do before approving
- **Treat web content as untrusted input** — be cautious with tasks involving external data

### Workspace Boundaries

All file operations are constrained to the selected workspace folder. Path traversal attempts are rejected.

### Permission Model

```typescript
interface WorkspacePermissions {
  read: boolean;      // Read files
  write: boolean;     // Create/modify files
  delete: boolean;    // Delete files (requires approval)
  network: boolean;   // Network access (future)
}
```

### Approval Requirements

The following operations always require user approval:
- File deletion
- Bulk rename (>10 files)
- Network access beyond allowlist
- External service calls

---

## Compliance

This project requires users to comply with their model provider's terms and policies:

- [Anthropic Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [AWS Bedrock Third-Party Model Terms](https://aws.amazon.com/legal/bedrock/third-party-models/)

**Note:** Anthropic's Usage Policy requires that consumer-facing applications using AI disclose this to users. CoWork-OSS displays model information in the UI.
**Note:** For consumer-facing use, Anthropic’s Usage Policy requires disclosing that users are interacting with AI at the beginning of each session. CoWork-OSS shows an explicit “AI system” disclosure when starting a new task/session.

## Trademark notice
“Cowork” is an Anthropic product name. CoWork-OSS is an independent open-source project and is not affiliated with Anthropic.
If requested by the rights holder, we will update naming/branding to avoid confusion.

---

## Roadmap

### Completed
- [x] Folder-scoped workspace + path traversal protection
- [x] Approval gates for destructive operations
- [x] Task timeline + artifact outputs
- [x] Multi-provider support (Anthropic API / AWS Bedrock)
- [x] Model selection (Opus, Sonnet, Haiku)
- [x] Built-in skills (documents, spreadsheets, presentations)
- [x] SQLite local persistence

### Planned
- [ ] VM sandbox using macOS Virtualization.framework
- [ ] MCP connector host and registry
- [ ] Sub-agent coordination for parallel tasks
- [ ] Network egress controls with proxy
- [ ] Browser automation
- [ ] Additional model provider support
- [ ] Skill marketplace/loader

---

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Electron 40 + Node.js
- **Database**: better-sqlite3 (embedded SQLite)
- **Build**: electron-builder

---

## Project Structure

```
cowork-oss/
├── src/
│   ├── electron/               # Main process (Node.js)
│   │   ├── main.ts            # Electron entry point
│   │   ├── preload.ts         # IPC bridge
│   │   ├── database/          # SQLite schema & repositories
│   │   ├── agent/             # Agent orchestration
│   │   │   ├── daemon.ts      # Task coordinator
│   │   │   ├── executor.ts    # Agent execution loop
│   │   │   ├── llm/           # Provider abstraction
│   │   │   ├── tools/         # Tool implementations
│   │   │   └── skills/        # Document creation skills
│   │   └── ipc/               # IPC handlers
│   ├── renderer/              # React UI
│   │   ├── App.tsx            # Main app component
│   │   ├── components/        # UI components
│   │   └── styles/            # CSS styles
│   └── shared/                # Shared types
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Development

### Hot Reload

Development mode provides hot reload for both:
- React UI (Vite HMR)
- Electron main process (auto-restart on changes)

### Adding New Tools

1. Define tool schema in `tools/registry.ts`
2. Implement tool logic in `tools/file-tools.ts` or create new file
3. Register tool in `getTools()` method
4. Add execution handler in `executeTool()`

### Adding New Skills

1. Create skill implementation in `skills/` directory
2. Add skill tool definition in `tools/skill-tools.ts`
3. Implement the skill method in SkillTools class

---

## Troubleshooting

### "ANTHROPIC_API_KEY not found"

Set the environment variable in your `.env` file or export it:
```bash
export ANTHROPIC_API_KEY=your_key_here
npm run dev
```

### Electron won't start

Clear cache and rebuild:
```bash
rm -rf node_modules dist
npm install
npm run dev
```

### Database locked

Close all instances of the app and delete the lock file:
```bash
rm ~/Library/Application\ Support/cowork-oss/cowork-oss.db-journal
```

---

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

Areas where help is especially needed:
- VM sandbox implementation using Virtualization.framework
- Additional model provider integrations
- Enhanced document creation libraries
- Network security controls
- Test coverage

---


## License

[MIT](LICENSE)
