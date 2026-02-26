# Discord MCP Connector

This connector exposes Discord Bot APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `DISCORD_BOT_TOKEN` (required) — Bot token from the Discord Developer Portal
- `DISCORD_APPLICATION_ID` (optional) — Application ID for the bot
- `DISCORD_GUILD_ID` (optional) — Default guild ID; tools that require a guild will use this if `guild_id` is not passed per-request

### Bot Setup

1. Go to https://discord.com/developers/applications
2. Create an application (or use an existing one)
3. Navigate to **Bot** and click **Reset Token** to get `DISCORD_BOT_TOKEN`
4. Under **Privileged Gateway Intents**, enable:
   - **Server Members Intent** — required for `discord.list_members`
   - **Message Content Intent** — required to read message content via `discord.get_messages`
5. Navigate to **OAuth2 > URL Generator**, select scopes `bot` and `applications.commands`, then select the permissions your bot needs (Manage Channels, Manage Roles, Send Messages, etc.)
6. Use the generated URL to invite the bot to your server

## Build & Run

```bash
npm install
npm run build
npm start
```

## Add to CoWork MCP Settings

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/discord-mcp/dist/index.js`
- **Env**: set the variables above

## Tools

- `discord.health` — Verify bot token and connection
- `discord.list_guilds` — List guilds the bot is in
- `discord.get_guild` — Get guild details (members, channels count)
- `discord.list_channels` — List all channels in a guild
- `discord.get_channel` — Get detailed information about a channel
- `discord.create_channel` — Create text, voice, category, forum, or stage channels
- `discord.edit_channel` — Update channel name, topic, etc.
- `discord.delete_channel` — Delete a channel (irreversible)
- `discord.send_message` — Send a message with optional embeds
- `discord.get_messages` — Fetch recent messages from a channel
- `discord.create_thread` — Create a thread (from a message or standalone)
- `discord.list_roles` — List all roles in a guild
- `discord.create_role` — Create a new role with color, hoist, mentionable
- `discord.edit_role` — Edit an existing role (name, color, hoist, mentionable)
- `discord.delete_role` — Delete a role (irreversible)
- `discord.add_reaction` — React to a message with an emoji
- `discord.create_webhook` — Create a webhook for a channel
- `discord.list_webhooks` — List all webhooks for a channel
- `discord.list_members` — List guild members (requires Server Members Intent)

## Rate Limiting

The connector automatically retries on HTTP 429 (rate limit) responses, waiting for the `retry_after` duration returned by Discord. Retries are capped at 2 attempts with a max delay of 10 seconds per retry.

See `docs/enterprise-connectors.md` for the contract.
