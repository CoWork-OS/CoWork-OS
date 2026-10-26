<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/cowork-os-sl-dark-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="screenshots/cowork-os-sl-color-logo.png">
    <img src="screenshots/cowork-os-sl-color-logo.png" alt="CoWork OS" width="600">
  </picture>
</p>

<h3 align="center">The AI desktop where every action is visible and approvable before it runs.</h3>

<p align="center"><strong>Rent the model. Own everything else.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/cowork-os"><img src="https://img.shields.io/npm/v/cowork-os.svg" alt="npm"></a>
  <a href="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml"><img src="https://github.com/CoWork-OS/CoWork-OS/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/CoWork-OS/CoWork-OS/discussions"><img src="https://img.shields.io/github/discussions/CoWork-OS/CoWork-OS" alt="Discussions"></a>
  <a href="https://discord.gg/UjykKwjhRC"><img src="https://img.shields.io/discord/1561115815695097986?label=Discord&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/CoWork-OS/CoWork-OS/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22"><img src="https://img.shields.io/github/issues/CoWork-OS/CoWork-OS/good%20first%20issue" alt="Good first issues"></a>
</p>

<p align="center">
  <strong>English</strong> &middot; <a href="README.zh-CN.md">简体中文</a>
</p>

CoWork OS is a free, open-source desktop app for macOS and Windows that does real work for you: files, documents, the browser, your inbox and scheduled jobs. You watch every step as it happens, and with the default **Ask for approval** profile the agent works freely inside your workspace but stops and asks before anything that leaves it: sending, network access, credentials, exports, or files outside the workspace. Use the model you choose; your workspace, memory, skills and history stay on your machine. Model providers may charge for usage and receive the data needed for the tasks you run. [What you own](docs/what-you-own.md)

<p align="center">
  <img src="resources/branding/images/readme-demo.gif" alt="A task in CoWork OS: the plan fills in, the agent asks before running a command, and the finished spreadsheet opens beside the chat" width="820">
</p>

<p align="center"><sub>MIT licensed · runs on your machine · 17,000+ automated tests · <a href="ZeroLeaks-Report-jn70f56art03m4rj7fp4b5k9p180aqfd.pdf">independent security assessment</a> · contributions welcome</sub></p>

## What you can do with it

- **Turn a folder of files into finished work.** "Make a spreadsheet of these invoices with a total per vendor" — the spreadsheet opens beside the chat, editable, and you can ask for changes in place.
- **Get through your inbox without losing control.** It triages, summarizes and drafts replies; nothing is sent until you approve it.
- **Research in a browser you can watch.** The agent browses in a visible window you can take over at any time, and hands back a report with its sources.
- **Put a bot on a schedule.** A bot with its own memory posts a morning summary to Telegram, Slack or Discord, and asks you before it acts outside its scope.
- **Make 3D models and game assets.** "Make a low-poly treasure chest for my Godot game" — Meshy builds it, the approval card names the credit cost first, and the model appears in the chat as a 3D view you can spin, animate and download. [3D Models with Meshy](docs/meshy-3d.md)
- **Work on code with every command shown.** Real terminal tabs, diffs and test runs in the timeline, and approvals for anything risky.
- **Keep it all local if you want.** Run on Ollama or LM Studio on your own machine, or sign in with OpenRouter and use free models with no API key to copy.

<table>
  <tr>
    <td width="33%"><img src="resources/branding/images/readme-today.webp" alt="Today: one card per decision that needs you"></td>
    <td width="33%"><img src="resources/branding/images/readme-approval.webp" alt="An approval card in the middle of a task"></td>
    <td width="33%"><img src="resources/branding/images/readme-workbench.webp" alt="A generated spreadsheet open beside the conversation"></td>
  </tr>
  <tr>
    <td align="center"><sub>Today: what needs you, one card each</sub></td>
    <td align="center"><sub>Every risky step waits for your answer</sub></td>
    <td align="center"><sub>Results open beside the chat</sub></td>
  </tr>
</table>

| | |
| --- | --- |
| **See every step, approve the risky ones** | The timeline shows each file read, command and edit as it happens. Access profiles (Ask for approval, Approve for me, Full access, Custom) decide what waits for you, and hard limits hold even if you approve. [Access profiles](docs/access-profiles.md) |
| **Get finished files, not just answers** | Documents, spreadsheets, decks, web pages and PDFs open beside the agent, editable, and you can ask for changes without starting over. [Everything Workbench](docs/everything-workbench.md) |
| **An inbox that drafts, you send** | Local-first triage, search across your mail, and reply drafts; sending always waits for you. [Inbox Agent](docs/inbox-agent.md) |
| **A browser you can watch and take over** | Real tabs that stay loaded, downloads and history, and logins filled only on the exact site after you confirm. [Browser Workbench](docs/browser-workbench.md) |
| **Bots that work while you don't** | Bots with their own memory, model and schedule, reachable on Telegram, Slack, Discord, WhatsApp and more. [Bots](docs/bots-and-conversations.md) · [Channels](docs/channels.md) |
| **Memory you can open and edit** | What CoWork knows about you is plain markdown in a local git folder: read it, change it, sync it or delete it. [Memory](docs/features.md#persistent-memory-system) |
| **Any model you choose, switch any time** | OpenRouter sign-in with free models, ChatGPT sign-in, local Ollama or LM Studio, or API keys for Claude, OpenAI, Gemini, Groq and more, per conversation. [Models & Access](docs/providers.md) |

## Why CoWork OS?

| If you use… | You might choose CoWork OS when you want… |
| --- | --- |
| A terminal agent (Hermes Agent, OpenClaw, Claude Code) | The same kind of agent in a desktop app, with approvals you can see, files that open beside the chat, and memory you can read. CoWork can import a Hermes or OpenClaw setup. |
| A hosted desktop assistant (ChatGPT, Claude Cowork) | An open-source app where you pick the model, run local models, and keep your workspace, memory and history on your machine. |
| A coding agent (Cursor, Codex) | One workspace for code and everything around it: documents, inbox, browser, bots and schedules. |

These are fit notes, not rankings; see [Compare CoWork OS](docs/comparisons/index.md) for each product's strengths and the evidence behind each page.


## Install

**macOS** (Apple Silicon, macOS 13 or later). No Gatekeeper dialog:

```bash
curl -fsSL https://coworkosapp.com/install.sh | bash
```

**Windows** (64-bit), in PowerShell. No SmartScreen prompt:

```powershell
irm https://coworkosapp.com/install.ps1 | iex
```

**Any platform with Node.js 24**, including Intel Macs. Installs the desktop app and the `cowork` CLI:

```bash
npm install -g cowork-os
```

Linux servers: use the [packaged headless server](docs/vps-linux.md). Re-run the same command to update.

<details>
<summary>Trouble installing? Use the DMG or EXE instead</summary>

Download the installer from [GitHub Releases](https://github.com/CoWork-OS/CoWork-OS/releases/latest). Releases are not notarized by Apple or code signed for Windows, so a browser download needs one extra step the first time:

- **macOS DMG:** drag CoWork OS into Applications and open it. When macOS says it was not opened, click **Done**, then go to **System Settings > Privacy & Security** and click **Open Anyway**. Step-by-step screenshots: [macOS Installation](docs/macos-installation.md).
- **Windows EXE:** when SmartScreen says **Windows protected your PC**, click **More info > Run anyway**. Checksums and antivirus notes: [Windows Installation](docs/windows-installation.md).
- **macOS 12 Monterey:** `0.5.51` is the last compatible release: `npm install -g cowork-os@0.5.51`.

</details>

## Getting started

1. **Open CoWork OS.** On macOS the first start may ask for the `cowork-os Safe Storage` keychain item; click **Always Allow**.
2. **Pick a model.** Choose **Continue with OpenRouter** for free models with no API key to copy (from 0.5.61), sign in with ChatGPT, use a detected local Ollama model, or paste an API key. Free options are marked, and you can switch models any time.
3. **Describe a task**, for example "make a spreadsheet of my last ten invoices from ~/Downloads", or pick one from the use-case gallery.
4. **Watch and approve.** The timeline shows each step. Work inside the workspace runs on its own; anything that sends, reaches the network, uses credentials or leaves the workspace waits for your answer.

From the terminal: `cowork` opens the terminal UI and `cowork run "who are you?"` runs a one-shot task against the same local profile. [Getting Started](docs/getting-started.md) · [CoWork CLI](docs/cli.md)

## Migrating from Hermes or OpenClaw

Bring your Hermes Agent or OpenClaw setup with you (from 0.5.61). CoWork reads `~/.hermes` or `~/.openclaw` without changing it and shows what it would import before anything is written: persona, memory, your own skills, model choice, chat bots and their allowlists, and scheduled jobs. API keys and bot tokens come over only if you ask, and go to the operating system's encrypted storage.

```bash
cowork import --from hermes --dry-run
cowork import --from hermes
```

Use `--from openclaw` for OpenClaw, or **Settings > Import** in the app; first-run setup offers it when it finds either folder. You can also keep running your existing Hermes and hand tasks to it from CoWork over ACP. Guides: [Migrating from Hermes](docs/migrating-from-hermes.md) · [Migrating from OpenClaw](docs/migrating-from-openclaw.md)

## Documentation

| | |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Install, first model, first task |
| [Feature Tour](docs/feature-tour.md) | Why CoWork OS, how a task runs, and the full feature inventory |
| [Features](docs/features.md) | Categorized feature reference |
| [Models & Access](docs/providers.md) | Provider routes, sign-ins, local models, fallbacks |
| [Migrating from Hermes](docs/migrating-from-hermes.md) · [OpenClaw](docs/migrating-from-openclaw.md) | Import persona, memory, skills, bots and schedules |
| [Access Profiles](docs/access-profiles.md) | Approvals, sandbox, network and filesystem policy |
| [Security Guide](docs/security-guide.md) | Threat model, guardrails, sandboxing, credential storage |
| [Self-Hosting](docs/self-hosting.md) | Linux server, Docker and remote access |
| [Development](docs/development.md) | Build from source and run the tests |
| [All docs](docs/) · [Changelog](CHANGELOG.md) · [Release Notes 0.5.61](docs/release-notes-0.5.61.md) | |

## Community

- **Chat:** [Discord](https://discord.gg/UjykKwjhRC): #help for questions, #show-and-tell for what you built, #contributors for working on CoWork OS
- **Questions and ideas:** [GitHub Discussions](https://github.com/CoWork-OS/CoWork-OS/discussions)
- **Bugs and requests:** [Issues](https://github.com/CoWork-OS/CoWork-OS/issues). We reply within a day.
- **Contribute:** start with a [good first issue](https://github.com/CoWork-OS/CoWork-OS/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and read [CONTRIBUTING.md](CONTRIBUTING.md).
- **Read Chinese?** `README.zh-CN.md` needs a native-speaker review: see [#635](https://github.com/CoWork-OS/CoWork-OS/issues/635).
- **Security reports:** [SECURITY.md](SECURITY.md)

<!-- COWORK_PUBLIC_ADOPTION_STATS_START -->
### Public Adoption Signals

| Signal | Current | All time |
|---|---:|---:|
| GitHub stars | 511 | n/a |
| GitHub forks | 93 | n/a |
| Installer/server downloads | 2,160 | 2,160 |
| Download delta | +58 | n/a |
| npm downloads | 350 (last week) | 9,933 |
| GitHub views, last 14-ish days | 839 total / 497 unique | n/a |
| GitHub clones, last 14-ish days | 32,744 total / 1,725 unique | n/a |

Generated 2026-10-26T08:51:09.381Z. These are public GitHub/npm adoption signals, not active-user or in-app telemetry numbers. All-time values are shown only where the source API provides lifetime coverage. [Full report](docs/public-adoption-stats.md).
<!-- COWORK_PUBLIC_ADOPTION_STATS_END -->

## License

MIT License. See [LICENSE](LICENSE).

---

<sub>"Cowork" is an Anthropic product name. CoWork OS is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic. If requested by the rights holder, we will update naming/branding.</sub>
osai-verify: b359fb38a6b6ca5e28d0
