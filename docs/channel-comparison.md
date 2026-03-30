# Channel Integration Comparison

How CoWork OS channel integrations compare to alternative implementations (e.g. Anthropic Claude Code plugins).

---

## Discord: CoWork OS vs Anthropic Claude Code Plugin

| Aspect | CoWork OS | Anthropic Plugin |
|--------|-----------|------------------|
| **Library** | discord.js (Node.js) | Custom MCP server (Bun) |
| **Slash commands** | 15+ (`/task`, `/workspace`, `/approve`, etc.) | None |
| **Rich UI** | Embeds, polls, select menus, buttons | Plain text + reactions |
| **Interaction handling** | Defer + editReply, 3s timeout handling | Basic |
| **Message chunking** | Smart (preserves code fences) | Simple |
| **Access control** | Pairing, allowlist via security config | Pairing, allowlist, per-channel opt-in |
| **Message history** | `channel_history` (local log) + `channel_fetch_discord_messages` (live API, up to 100) | `fetch_messages` (live API, up to 100) |
| **Attachments** | Metadata in message context + `channel_download_discord_attachment` (download by message ID) | `download_attachment` (download by message ID) |

**Summary:** CoWork OS matches the Anthropic plugin for live message history and attachment downloads while offering richer Discord integration (slash commands, embeds, approvals, workspace selection).

---

## Related Documentation

- [Channel Integrations](channels.md) — Setup and features for all 17 channels
- [Research Channels](research-channels.md) — Link-research channels for Telegram and WhatsApp
