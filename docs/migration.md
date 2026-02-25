# Migrating to CoWork OS

This guide helps users transition from other AI assistant platforms or set up CoWork OS alongside existing tools.

## Overview

CoWork OS is a security-first personal AI assistant that runs on your Mac. If you're coming from another multi-channel AI platform or looking to self-host your AI assistant, this guide will help you get started.

---

## From OpenClaw to CoWork OS (Alternative Path)

If you're currently using OpenClaw, the migration is mostly an operating model shift:

- OpenClaw is commonly used as an agent experimentation toolkit.
- CoWork OS is designed as a production runtime with built-in approvals, guardrails, and local-first controls.

See also: [OpenClaw alternative guide](openclaw-comparison.md)

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
| Reach | Unified 14-channel gateway for multi-surface delivery |
| Privacy | Local-first storage, BYOK provider model, optional offline Ollama |

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
| **30+ LLM providers** | Built-in + compatible gateways with BYOK flexibility |
| **Local LLM support** | Run completely free and offline with Ollama |
| **Native desktop app** | Full macOS integration with menu bar and shortcuts |
| **Real-time timeline** | See exactly what the agent is doing |
| **Document creation** | Excel, Word, PDF, PowerPoint built-in |
| **Personality system** | Customize how your AI communicates |
| **MCP support** | Extend with external tool servers |

---

## What's Different

### Architecture

| Aspect | CoWork OS | Typical CLI Platform |
|--------|-----------|---------------------|
| **Form factor** | Desktop app (Electron) | CLI + daemon |
| **Primary platform** | macOS | Cross-platform |
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

### 2. Configure LLM Provider

1. Open Settings (gear icon)
2. Select your LLM provider tab
3. Enter your API credentials
4. Test connection
5. Save

Available providers include Anthropic, OpenAI, Gemini, OpenRouter, Bedrock, Ollama, Groq, xAI (Grok), Kimi, plus compatible gateways such as OpenCode Zen, Google Vertex, Google Antigravity, Google Gemini CLI, Z.AI, GLM, Vercel AI Gateway, Cerebras, Mistral, GitHub Copilot, Qwen Portal, MiniMax, Xiaomi MiMo, Venice AI, Synthetic, Kimi Code, and custom OpenAI- or Anthropic-compatible endpoints.

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

### Do I need to re-pair users?

Yes. CoWork OS maintains its own pairing database. Users will need to pair again using the pairing code flow.

### Can I use the same API keys?

Yes. Your LLM provider API keys (Anthropic, OpenAI, etc.) work with any client. Just enter them in CoWork OS Settings.

### Is my data migrated?

No. Task history, conversations, and artifacts are stored locally per platform. You'll start fresh with CoWork OS.

---

## Getting Help

- **Documentation**: See [Repository README](https://github.com/CoWork-OS/CoWork-OS/blob/main/README.md) for full feature documentation
- **Security**: See [Security Guide](security-guide.md) for security best practices
- **Issues**: Report bugs at [GitHub Issues](https://github.com/CoWork-OS/CoWork-OS/issues)
- **Contributing**: See [Contributing](contributing.md) for contribution guidelines
