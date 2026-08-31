# Channel Integration Comparison

How CoWork OS channel integrations compare to alternative plugin-based implementations.

---

## Discord: CoWork OS vs Plugin-Based Alternatives

| Aspect | CoWork OS | Anthropic Plugin |
|--------|-----------|------------------|
| **Library** | discord.js (Node.js) | Custom MCP server (Bun) |
| **Slash commands** | 15+ (`/task`, `/workspace`, `/approve`, etc.) | None |
| **Rich UI** | Embeds, polls, select menus, buttons | Plain text + reactions |
| **Interaction handling** | Defer + editReply, 3s timeout handling | Basic |
| **Message chunking** | Smart (preserves code fences) | Simple |
| **Access control** | Pairing, allowlist, target-workspace access profiles, and deny-first context restrictions | Pairing, allowlist, per-channel opt-in |
| **Message history** | `channel_history` (local log) + `channel_fetch_discord_messages` (live API, up to 100) | `fetch_messages` (live API, up to 100) |
| **Attachments** | Metadata in message context + `channel_download_discord_attachment` (download by message ID) | `download_attachment` (download by message ID) |

**Summary:** CoWork OS matches the Anthropic plugin for live message history and attachment downloads while offering richer Discord integration (slash commands, embeds, approvals, workspace selection, and profile-governed command/network/file access).

---

## Related Documentation

- [Channel Integrations](channels.md) — Setup and features for all 17 channels
- [Channel User Guides](channel-user-guides.md) — End-user features and best practices for each messaging channel
- [Dedicated Channel Guides](channel-guides/) — Separate guide pages for each messaging channel
- [Gateway User Guide](gateway-user-guide.md) — End-user workflows and best practices for remote chat usage
- [Gateway Message Lifecycle](gateway-message-lifecycle.md) — Remote command routing, active-task policy, delivery, and scheduled channel outputs
- [Research Channels](research-channels.md) — Link-research channels for Telegram and WhatsApp
