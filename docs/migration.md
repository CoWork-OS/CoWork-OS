# Migrating to CoWork OS

This guide helps users transition from other AI assistant platforms or set up CoWork OS alongside existing tools.

## Overview

CoWork OS is a free, open-source, security-first, GUI-first, CLI-capable AI super app and everything app that runs on macOS and Windows. Its open multi-provider harness lets supported accounts, APIs, compatible gateways, cloud credentials, and local models share one runtime for coding, email, documents, spreadsheets, presentations, browser work, agents, automations, desktop review, and terminal task starts.

---

## From OpenClaw

If you're currently using OpenClaw, the migration is mostly an operating model shift:

- OpenClaw is an open personal-agent ecosystem with a strong channel-forward operator model.
- CoWork OS emphasizes a GUI-first Everything Workbench, visible approvals and governance, artifact editing, and a shared desktop, CLI, and headless runtime.

See also: [CoWork OS vs OpenClaw](comparisons/openclaw.md)

### Practical Migration Plan

1. Keep OpenClaw running in parallel for a short validation window.
2. Start CoWork OS with one low-risk channel (for example, a private Telegram or Slack test channel).
3. Enable strict security defaults in CoWork OS first: Pairing mode, approval workflows, and guardrail budgets.
4. Reconnect provider keys and channels one by one.
5. Cut over production channels only after task quality and approval behavior match expectations.

### What Improves After Cutover

| Area | What to expect in CoWork OS |
|---|---|
| Operations | Desktop control plane plus headless runtime options |
| Safety | Approval-gated destructive actions and configurable command blocking |
| Governance | Token/cost/iteration guardrails per task |
| Reach | Desktop, CLI, daemon, and messaging-channel delivery |
| Data control | Local-first persistence, explicit remote-service boundaries, and optional local Ollama inference |

---

## From Coding Agents and AI Workspaces

You do not need to remove Claude Code, Codex, Cursor, OpenCode, ChatGPT, or Claude Cowork to start using CoWork OS. A safer migration is to keep the specialist tool for the workflows where it is strongest, then move broader work into CoWork one lane at a time.

1. Connect one supported model route and run a low-risk task in a test workspace.
2. Recreate only the skills, MCP servers, instructions, and approvals needed for that workflow; configuration formats are not assumed to be portable.
3. Compare output quality, tool behavior, cost, and approval boundaries against the existing app.
4. Move adjacent browser, inbox, document, channel, or automation work into CoWork when keeping it in one harness is useful.
5. Keep both systems where a specialist workflow remains the better fit.

See [Compare CoWork OS](comparisons/index.md) for fit-based guides covering Claude Code, Codex, Cursor, OpenCode, ChatGPT, Claude Cowork, OpenClaw, and Hermes Agent.

---

## From Other AI Assistants

### Channel Migration

If you're already using messaging channels with another AI platform, you can reuse most of your existing setup:

#### WhatsApp
- **Same phone**: CoWork OS uses Web WhatsApp (Baileys library), just like other platforms
- **New QR scan**: You'll need to scan a new QR code in CoWork OS Settings
- **Note**: WhatsApp allows multiple linked devices, so you can run both platforms during transition

#### Telegram
- **Same bot or new**: You can create a new bot via @BotFather, or reuse your existing bot token
- **If reusing token**: Make sure to disable the old platform first to avoid conflicts
- **Recommendation**: Create a new bot for cleaner separation

#### Discord
- **Same application**: You can reuse your Discord application and bot token
- **Guild commands**: If using guild-specific commands, update the Guild IDs in CoWork OS
- **Note**: Only one client can connect with the same token at a time

#### Slack
- **Same app tokens**: You can reuse your Slack app's Bot Token and App-Level Token
- **Socket Mode**: CoWork OS uses Socket Mode, same as most other platforms
- **Note**: Only one connection per token is allowed

#### iMessage
- **macOS only**: iMessage integration requires macOS and the `imsg` CLI tool
- **Setup**: Install via `brew install steipete/tap/imsg`
- **Unique to CoWork OS**: Most platforms don't support iMessage

---

## What You'll Gain

Moving to CoWork OS provides several advantages:

### Security Features

| Feature | Benefit |
|---------|---------|
| **Configurable guardrails** | Set token/cost budgets, iteration limits |
| **Dangerous command blocking** | Built-in + custom patterns to block risky commands |
| **Approval workflows** | Human-in-the-loop for destructive operations |
| **Brute-force protection** | Lockout after failed pairing attempts |
| **Context-aware isolation** | Different tool access for local vs remote use |

### Additional Capabilities

| Feature | Benefit |
|---------|---------|
| **Dozens of model routes** | Built-in providers, compatible gateways, supported account connections, local runtimes, and Mixture of Agents presets |
| **Local LLM support** | Run supported models locally with Ollama; model availability and hardware needs vary |
| **Native desktop app** | Full desktop UX on macOS and Windows (menu bar on macOS, system tray on Windows) |
| **GUI-first agent management** | Create reusable agents, spawn many runs, inspect timelines, assign work, and monitor teams through Agents Hub and Mission Control |
| **Real-time timeline** | See exactly what the agent is doing |
| **Everyday document work** | Excel, Word, PDF, and PowerPoint-style outputs built into the task workspace |
| **Personality system** | Customize how your AI communicates |
| **MCP support** | Extend with external tool servers |

---

## What's Different

### Architecture

| Aspect | CoWork OS | Typical CLI Platform |
|--------|-----------|---------------------|
| **Form factor** | Desktop app (Electron) | CLI + daemon |
| **Primary platform** | macOS + Windows | Cross-platform |
| **Installation** | `npm install` + `npm run dev` | `npm install -g` |
| **Configuration** | GUI Settings panel | Config files / CLI flags |

### Security Model

| Aspect | CoWork OS |
|--------|-----------|
| **Default mode** | Pairing (most restrictive) |
| **Sandbox** | Workspace boundaries (VM planned) |
| **Approval** | GUI dialogs |
| **Guardrails** | Configurable in Settings UI |

---

## Setup Steps

### 1. Install CoWork OS

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS
npm install
npm run dev
```

### 2. Configure Model Access

1. Open Settings (gear icon)
2. Open **AI & Models** > **Model Access** and select a supported route
3. Enter your API credentials
4. Test connection
5. Save

Available routes include supported provider accounts, API keys, compatible gateways, cloud credentials, local models, and custom OpenAI- or Anthropic-compatible endpoints. The current route catalog and setup requirements live in [Model Providers](providers.md); provider eligibility, model availability, limits, and charges can change independently of CoWork.

### 3. Set Up Messaging Channels

For each channel you want to use:

1. Go to Settings > Channels
2. Select the channel type
3. Enter credentials (tokens, keys)
4. Configure security mode (Pairing recommended)
5. Test and enable

### 4. Configure Guardrails

1. Go to Settings > Guardrails
2. Set appropriate budgets:
   - Token budget (e.g., 100,000)
   - Cost budget (e.g., $1.00)
   - Iteration limit (e.g., 50)
3. Enable dangerous command blocking
4. Add custom blocked patterns if needed

### 5. Add Workspaces

1. Click "Select Workspace" in the main window
2. Choose folders you want the agent to access
3. Avoid sensitive folders (documents, system files)

---

## Running Both Platforms

During transition, you may want to run both platforms:

### Recommendations

1. **Use different bots**: Create separate Telegram/Discord bots for each platform
2. **Stagger channels**: Migrate one channel at a time
3. **Test thoroughly**: Verify each channel works before migrating the next
4. **Keep backups**: Ensure you have backups before any major changes

### Avoiding Conflicts

- **Same bot token**: Only one platform can use a token at a time
- **WhatsApp**: Can have multiple linked devices, but messages route to all
- **Webhooks**: Make sure only one platform receives webhook events

---

## Common Questions

### Can I import my skills/prompts from another platform?

CoWork OS uses a JSON-based skill format. If your existing platform exports skills, you may need to convert them. Skills are stored in:
```
~/Library/Application Support/cowork-os/skills/
```

For Codex-style skill repos that only ship a `SKILL.md`, create a CoWork manifest such as `webxr-dev.json` and, if you want to preserve bundled instructions, add a sibling directory such as `webxr-dev/SKILL.md`. The same sidecar directory can also contain `references/` and `scripts/` that the prompt references through `{baseDir}`.

To invoke an imported managed skill, mention it explicitly in the prompt by ID, for example: `Use the webxr-dev skill to add teleport locomotion to my Three.js Quest scene.` The `/skill <id>` command only toggles a skill on or off; it does not execute the skill as a slash command.

### Do I need to re-pair users?

Yes. CoWork OS maintains its own pairing database. Users will need to pair again using the pairing code flow.

### Can I use the same API keys?

Often, if the provider permits the key to be used with third-party clients and CoWork supports the relevant API. Add it under **Settings > AI & Models > Model Access**, test the connection, and confirm the provider's current terms. Account-based access and first-party app subscriptions are not automatically equivalent to API access.

### Is my data migrated?

No. Task history, conversations, and artifacts are stored locally per platform. You'll start fresh with CoWork OS.

---

## Getting Help

- **Documentation**: See [Repository README](https://github.com/CoWork-OS/CoWork-OS/blob/main/README.md) for full feature documentation
- **Security**: See [Security Guide](security-guide.md) for security best practices
- **Issues**: Report bugs at [GitHub Issues](https://github.com/CoWork-OS/CoWork-OS/issues)
- **Contributing**: See [Contributing](contributing.md) for contribution guidelines
