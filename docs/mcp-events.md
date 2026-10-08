# MCP Events in CoWork OS

MCP Events can start work when a connected MCP server reports a matching event. The source server advertises event names and subscription filters; CoWork stores the monitor, accepts the event, and runs its saved instructions through the normal task and approval pipeline. A monitor can continue an existing task or create a new one.

CoWork implements the experimental [MCP Events design](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) for **webhook** and **poll** delivery. This covers the webhook flow documented for [ChatGPT plugins](https://developers.openai.com/plugins/build/mcp-events). Push-only (`events/stream`) servers are not supported yet. This draft can change; event names and schemas belong to the connected server.

## Create a monitor

1. Connect an MCP server that advertises `events` in its MCP `2026-07-28` `server/discover` response. Existing MCP `initialize` servers continue to work for their earlier tool/resource capabilities.
2. In **Settings → Automations → Event Triggers**, choose **MCP Event**, the server, an advertised event, its JSON subscription filters, and the delivery mode. Save instructions for the task that will run when the event arrives. Set **Continue an existing task** and its task ID to keep the work in one conversation.
3. Or ask CoWork in a task to watch a connected MCP event. The `manage_connector_events` tool can list available events, subscribe with instructions, list monitors, and unsubscribe. It continues the requesting task by default. Without a configured public callback URL, it chooses poll when the event supports it.
4. Review the monitor's subscription state in Event Triggers. An error or history gap is shown there. Disabling or removing a monitor stops local dispatch; CoWork also sends `events/unsubscribe` for a webhook subscription and retries cleanup if the server is temporarily unavailable.

The connected server validates event names, filter arguments, and access to the watched resource. Event payloads are treated as external data. The agent's actions still pass through its saved access profile and normal tool approvals.

## Webhook setup

Webhook delivery needs a public HTTPS callback URL. CoWork's receiver listens on `127.0.0.1:8766` by default; set `COWORK_MCP_EVENTS_PORT` to use another port. Put an HTTPS reverse proxy or tunnel in front of it and forward `/mcp-events/*` to that local port. Enter the public **base URL** in the monitor. CoWork appends `/mcp-events/<trigger-id>` when subscribing. For chat-created monitors, `COWORK_MCP_EVENTS_PUBLIC_URL` can supply the base URL.

The MCP server verifies the callback with a signed challenge before activation. CoWork requires Standard Webhooks signatures, a recent timestamp, a matching subscription ID for event delivery, and a body no larger than 256 KiB. It acknowledges an event only after the trigger engine has accepted it into its durable queue. Repeated event IDs are deduplicated by the trigger engine. The callback signing secret is encrypted with Electron `safeStorage` when available. Headless runtimes can set `COWORK_MCP_EVENTS_KEY` to a stable, randomly generated 32-byte base64 key; losing this key prevents existing webhook secrets from being decrypted and requires recreating those monitors.

Webhook subscriptions refresh before the server's `refreshBefore` deadline. CoWork keeps the server cursor and subscription state in SQLite, resumes after restart, and surfaces `truncated` or `gap` reports. An expired or revoked source grant can stop delivery even while a monitor remains configured; inspect the monitor's error state and reconnect the source account if needed.

## Poll setup

Choose poll when the event advertises `poll`, especially on a local machine without a public callback. CoWork calls `events/poll` with the saved cursor, handles batches, respects the server's `nextPollMs` with a one-second minimum, and advances the cursor only after accepting the returned events. Polling begins from the server's current position when no cursor is stored. A source that has no replayable history may miss events while CoWork is offline.

## Validation boundary

Focused tests cover modern MCP discovery, legacy handshake compatibility, webhook signature rejection and challenge response, poll cursor persistence, and unsubscribe on monitor removal. They do not prove delivery from a third-party MCP provider or an externally deployed HTTPS reverse proxy. Test that path with a connected provider before relying on a monitor for operational work.
