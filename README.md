<p align="center">
  <img src="screenshots/cowork-oss-logo-new.png" alt="CoWork OS Logo" width="120">
</p>

<h1 align="center">CoWork OS</h1>

<p align="center">
  <strong>The operating system for personal AI assistants</strong><br>
  Local-first runtime for secure, multi-channel AI agents on macOS
</p>

<p align="center">
  <a href="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml"><img src="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/cowork-os"><img src="https://img.shields.io/npm/v/cowork-os.svg" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.apple.com/macos/"><img src="https://img.shields.io/badge/platform-macOS-blue.svg" alt="macOS"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting Started</a> &middot;
  <a href="docs/">Documentation</a> &middot;
  <a href="CHANGELOG.md">Changelog</a> &middot;
  <a href="SECURITY.md">Security</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="screenshots/cowork-os-main-1.png" alt="CoWork OS Interface" width="700">
</p>

## Why CoWork OS?

- **30+ LLM providers** — Anthropic, OpenAI, Google, Ollama, AWS Bedrock, OpenRouter, and more. Bring your own keys.
- **14 messaging channels** — WhatsApp, Telegram, Discord, Slack, Teams, iMessage, Signal, and more. Chat with your AI from anywhere.
- **100+ built-in skills** — Documents, code review, web search, image generation, cloud integrations, and more.
- **Agent teams** — Multi-agent collaboration with shared checklists, collaborative mode, and multi-LLM synthesis.
- **Security-first** — Approval workflows, sandboxed execution, guardrails, encrypted storage, and 3200+ tests.
- **Local-first & BYOK** — Your data and API keys stay on your machine. No telemetry. No middleman.

## Quick Start

### Download the App

Download the latest `.dmg` from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest) and drag CoWork OS into Applications.

> **First launch:** The app is currently unsigned. On first open, macOS will block it — go to **System Settings > Privacy & Security > Open Anyway**, or run: `xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"`

> Works out of the box — defaults to [OpenRouter's free model router](https://openrouter.ai), no API key needed.

### Or Install via npm

```bash
npm install -g cowork-os
cowork-os
```

### Or Build from Source

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm install && npm run setup
npm run build && npm run package
```

See the [Development Guide](docs/development.md) for prerequisites and details.

## How It Works

1. **Create a task** — Describe what you want ("organize my Downloads by file type", "create a quarterly report spreadsheet"). No workspace needed — a temp folder is used automatically if you don't select one.
2. **Choose a mode** — Run normally, or toggle **Autonomous** (auto-approve actions), **Collaborative** (multi-agent perspectives), or **Multi-LLM** (compare providers with a judge) per task.
3. **Monitor execution** — Watch the real-time task timeline as the agent plans, executes, and produces artifacts. Shell commands run in a live terminal view where you can see output in real-time, stop execution, or provide input (e.g. `y`/`n`) directly.
4. **Approve when needed** — Destructive operations require your explicit approval (unless Autonomous mode is on).

## Features

### Agent Runtime

Task-based execution with dynamic re-planning, three per-task modes (Autonomous, Collaborative, Multi-LLM), agent teams, agent comparison, git worktree isolation, and performance reviews. [Learn more](docs/features.md#agent-capabilities)

### Mission Control

Centralized agent orchestration dashboard with a Kanban task board, real-time activity feed, agent heartbeat monitoring, standup reports, and performance reviews. [Learn more](docs/mission-control.md)

### Live Canvas

Agent-driven visual workspace for interactive HTML/CSS/JS content, data visualization, and iterative image annotation. [Learn more](docs/features.md#live-canvas)

### Multichannel Gateway

Unified AI gateway across 14 channels with security modes, rate limiting, ambient mode, scheduled tasks, and chat commands. [Learn more](docs/channels.md)

### Integrations

- **Cloud Storage**: Notion, Box, OneDrive, Google Workspace, Dropbox, SharePoint
- **Enterprise Connectors**: Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta, Resend
- **Developer Tools**: Claude Code-style `glob`/`grep`/`edit_file`, Playwright browser automation, MCP client/host/registry

[Learn more](docs/features.md)

### LLM Providers

12 built-in providers + 20+ compatible/gateway providers. Use cloud APIs or run fully offline with Ollama. [Learn more](docs/providers.md)

### Extensibility

- **100+ built-in skills** across developer, productivity, communication, documents, and more
- **Custom skills** in `~/Library/Application Support/cowork-os/skills/`
- **Declarative plugins** with 5 built-in plugin packs
- **MCP support** — client, host, and registry

### Voice Mode

Text-to-speech (ElevenLabs, OpenAI, Web Speech API), speech-to-text (Whisper), and outbound phone calls. [Learn more](docs/features.md#voice-mode)

### Memory & Context

Persistent memory with privacy protection, FTS5 search, LLM compression, and workspace kit (`.cowork/`) for durable project context. [Learn more](docs/features.md#persistent-memory-system)

<p align="center">
  <img src="screenshots/cowork-os-main3.png" alt="Collaborative Mode" width="700">
  <br>
  <em>Multi-agent collaborative mode with real-time thought sharing</em>
</p>

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Security Layers                               │
│  Channel Access Control │ Guardrails & Limits │ Approval Flows   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    React UI (Renderer)                           │
│  Task List │ Timeline │ Approval Dialogs │ Live Canvas           │
└─────────────────────────────────────────────────────────────────┘
                              ↕ IPC
┌─────────────────────────────────────────────────────────────────┐
│                 Agent Daemon (Main Process)                      │
│  Task Queue │ Agent Executor │ Tool Registry │ Cron Service      │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│                    Execution Layer                               │
│  File Ops │ Skills │ Browser │ LLM Providers (30+) │ MCP        │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  SQLite DB │ MCP Host │ WebSocket Control Plane │ Remote Access  │
└─────────────────────────────────────────────────────────────────┘
```

See [Architecture](docs/architecture.md) for the full technical deep-dive.

## Security

<p align="center">
  <img src="screenshots/ZeroLeaks-result-010226.png" alt="ZeroLeaks Security Assessment" width="500">
  <br>
  <em>Top security score on <a href="https://zeroleaks.ai/">ZeroLeaks</a> — outperforming many commercial solutions</em>
  <br>
  <a href="ZeroLeaks-Report-jn70f56art03m4rj7fp4b5k9p180aqfd.pdf">View Full Report</a>
</p>

- **Configurable guardrails**: Token budgets, cost limits, iteration caps, dangerous command blocking
- **Approval workflows**: User consent required for destructive operations
- **Sandbox isolation**: macOS `sandbox-exec` (native) or Docker containers
- **Encrypted storage**: OS keychain + AES-256 fallback
- **3200+ tests** including 132+ security unit tests and 259+ WebSocket protocol tests

See [Security Guide](docs/security-guide.md) and [Security Architecture](docs/security/) for details.

## Deployment

| Mode | Platform | Guide |
|------|----------|-------|
| **Desktop App** | macOS | [Getting Started](docs/getting-started.md) |
| **Headless / Server** | Linux VPS | [VPS Guide](docs/vps-linux.md) |
| **Self-Hosted** | Docker / systemd | [Self-Hosting](docs/self-hosting.md) |
| **Remote Access** | Tailscale / SSH | [Remote Access](docs/remote-access.md) |

## Screenshots

<p align="center">
  <img src="screenshots/cowork-os-main2.png" alt="Task Timeline" width="700">
  <br><em>Task timeline and execution view</em>
</p>

<p align="center">
  <img src="screenshots/cowork-os-settings1.png" alt="Settings" width="700">
  <br><em>AI provider and channel configuration</em>
</p>

## Roadmap

### Planned

- [ ] VM sandbox using macOS Virtualization.framework
- [ ] Network egress controls with proxy
- [ ] Cross-platform UI support (Windows, Linux)

See [CHANGELOG.md](CHANGELOG.md) for the full history of completed features.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | First-time setup and usage |
| [Features](docs/features.md) | Complete feature reference |
| [Channels](docs/channels.md) | Messaging channel setup (14 channels) |
| [Providers](docs/providers.md) | LLM provider configuration |
| [Development](docs/development.md) | Build from source, project structure |
| [Architecture](docs/architecture.md) | Technical architecture deep-dive |
| [Security Guide](docs/security-guide.md) | Security model and best practices |
| [Enterprise Connectors](docs/enterprise-connectors.md) | MCP connector development |
| [Self-Hosting](docs/self-hosting.md) | Docker and systemd deployment |
| [VPS/Linux](docs/vps-linux.md) | Headless server deployment |
| [Remote Access](docs/remote-access.md) | Tailscale, SSH tunnels, WebSocket API |
| [Mission Control](docs/mission-control.md) | Agent orchestration dashboard |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |
| [Uninstall](docs/uninstall.md) | Uninstall instructions |

## Data Handling

- **Stored locally**: Task metadata, timeline events, artifacts, workspace config, memories (SQLite)
- **Sent to provider**: Task prompt and context you choose to include
- **Not sent**: Your API keys (stored via OS keychain), private memories

## Compliance

Users must comply with their model provider's terms: [Anthropic](https://www.anthropic.com/legal/commercial-terms) · [AWS Bedrock](https://aws.amazon.com/legal/bedrock/third-party-models/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE).

---

<sub>"Cowork" is an Anthropic product name. CoWork OS is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic. If requested by the rights holder, we will update naming/branding.</sub>
