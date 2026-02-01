# Migrating to CoWork-OSS

This guide helps users transition from other AI assistant platforms or set up CoWork-OSS alongside existing tools.

## Overview

CoWork-OSS is a security-first personal AI assistant that runs on your Mac. If you're coming from another multi-channel AI platform or looking to self-host your AI assistant, this guide will help you get started.

---

## From Other AI Assistants

### Channel Migration

If you're already using messaging channels with another AI platform, you can reuse most of your existing setup:

#### WhatsApp
- **Same phone**: CoWork-OSS uses Web WhatsApp (Baileys library), just like other platforms
- **New QR scan**: You'll need to scan a new QR code in CoWork-OSS Settings
- **Note**: WhatsApp allows multiple linked devices, so you can run both platforms during transition

#### Telegram
- **Same bot or new**: You can create a new bot via @BotFather, or reuse your existing bot token
- **If reusing token**: Make sure to disable the old platform first to avoid conflicts
- **Recommendation**: Create a new bot for cleaner separation

#### Discord
- **Same application**: You can reuse your Discord application and bot token
- **Guild commands**: If using guild-specific commands, update the Guild IDs in CoWork-OSS
- **Note**: Only one client can connect with the same token at a time

#### Slack
- **Same app tokens**: You can reuse your Slack app's Bot Token and App-Level Token
- **Socket Mode**: CoWork-OSS uses Socket Mode, same as most other platforms
- **Note**: Only one connection per token is allowed

#### iMessage
- **macOS only**: iMessage integration requires macOS and the `imsg` CLI tool
- **Setup**: Install via `brew install steipete/tap/imsg`
- **Unique to CoWork-OSS**: Most platforms don't support iMessage

---

## What You'll Gain

Moving to CoWork-OSS provides several advantages:

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
| **6 LLM providers** | Claude, GPT-4, Gemini, Bedrock, OpenRouter, Ollama |
| **Local LLM support** | Run completely free and offline with Ollama |
| **Native desktop app** | Full macOS integration with menu bar and shortcuts |
| **Real-time timeline** | See exactly what the agent is doing |
| **Document creation** | Excel, Word, PDF, PowerPoint built-in |
| **Personality system** | Customize how your AI communicates |
| **MCP support** | Extend with external tool servers |

---

## What's Different

### Architecture

| Aspect | CoWork-OSS | Typical CLI Platform |
|--------|------------|---------------------|
| **Form factor** | Desktop app (Electron) | CLI + daemon |
| **Primary platform** | macOS | Cross-platform |
| **Installation** | `npm install` + `npm run dev` | `npm install -g` |
| **Configuration** | GUI Settings panel | Config files / CLI flags |

### Security Model

| Aspect | CoWork-OSS |
|--------|------------|
| **Default mode** | Pairing (most restrictive) |
| **Sandbox** | Workspace boundaries (VM planned) |
| **Approval** | GUI dialogs |
| **Guardrails** | Configurable in Settings UI |

---

## Setup Steps

### 1. Install CoWork-OSS

```bash
git clone https://github.com/mesutfelat/cowork-oss.git
cd cowork-oss
npm install
npm run dev
```

### 2. Configure LLM Provider

1. Open Settings (gear icon)
2. Select your LLM provider tab
3. Enter your API credentials
4. Test connection
5. Save

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

CoWork-OSS uses a JSON-based skill format. If your existing platform exports skills, you may need to convert them. Skills are stored in:
```
~/Library/Application Support/cowork-oss/skills/
```

### Do I need to re-pair users?

Yes. CoWork-OSS maintains its own pairing database. Users will need to pair again using the pairing code flow.

### Can I use the same API keys?

Yes. Your LLM provider API keys (Anthropic, OpenAI, etc.) work with any client. Just enter them in CoWork-OSS Settings.

### Is my data migrated?

No. Task history, conversations, and artifacts are stored locally per platform. You'll start fresh with CoWork-OSS.

---

## Getting Help

- **Documentation**: See [README.md](README.md) for full feature documentation
- **Security**: See [SECURITY_GUIDE.md](SECURITY_GUIDE.md) for security best practices
- **Issues**: Report bugs at [GitHub Issues](https://github.com/mesutfelat/cowork-oss/issues)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines
