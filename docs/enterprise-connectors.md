# Enterprise Connectors (Phase 1)

This document defines the Phase 1 connector foundation for CoWork OS. The goal is to make enterprise-grade integrations (Salesforce, Jira, etc.) available through a consistent MCP interface while keeping the app decoupled from connector implementation details.

## Phase 1 Goals

- Define a connector contract (naming, inputs, outputs, errors).
- Provide a reusable MCP connector template for new integrations.
- Specify MVP tool sets for Salesforce and Jira.
- Ship Salesforce and Jira connectors as installable MCP servers in the registry UI.

## Core Decision: MCP-First Connectors

Connectors should run as MCP servers and expose tools over MCP (stdio, SSE, or WebSocket). Each connector still uses direct APIs under the hood (OAuth, REST, GraphQL), but the app consumes them consistently through MCP.

Benefits:
- Decoupled release cadence (connectors ship independently of the desktop app).
- Supports local and managed deployments.
- Works with existing CoWork MCP settings, registry, and tool discovery.

## Connector Contract

### Tool Naming

- Use a connector namespace prefix: `<connector>.<action>`
- Examples:
  - `salesforce.search_records`
  - `salesforce.create_record`
  - `jira.search_issues`
  - `jira.create_issue`

In the CoWork app, MCP tools are prefixed (default `mcp_`), so agents will see:
- `mcp_salesforce.search_records`
- `mcp_jira.search_issues`

### Standard Input Conventions

Use the following fields where applicable:

- `limit`: max items to return.
- `cursor`: pagination cursor from previous response.
- `fields`: list of fields to include (projection).
- `expand`: list of related objects to expand.
- `requestId`: idempotency and tracing.
- `idempotencyKey`: for create/update operations.
- `workspaceId` or `tenantId`: for multi-tenant servers.

### Standard Output Shape (Recommended)

Return JSON in a consistent envelope so the agent can reason about results across connectors:

```
{
  "ok": true,
  "data": { ... },
  "meta": {
    "requestId": "...",
    "durationMs": 123,
    "rateLimit": {
      "limit": 100,
      "remaining": 42,
      "resetAt": "2026-02-03T12:34:56Z"
    }
  },
  "nextCursor": "...",
  "warnings": []
}
```

When errors happen, return MCP `isError: true` with a clear error message.

### Required Baseline Tools

Every connector should provide:

- `<connector>.health`
  - Verifies auth, returns org/user info, scopes, and rate limit snapshot.

Optional but strongly recommended:
- `<connector>.whoami`
- `<connector>.list_projects` or `<connector>.list_accounts`

### Error and Rate Limit Handling

- Normalize rate-limit errors to include `retryAfterMs`.
- Surface vendor error codes in `meta.vendorCode` when possible.
- Retry only on safe, idempotent requests.

### Pagination

- Prefer cursor-based pagination.
- Always return `nextCursor` when more data is available.

## Salesforce Connector (MVP Tool Set)

Tools to implement:

- `salesforce.health`
- `salesforce.list_objects`
- `salesforce.describe_object`
- `salesforce.get_record`
- `salesforce.search_records` (SOQL)
- `salesforce.create_record`
- `salesforce.update_record`

Suggested input schemas:

- `salesforce.search_records`:
  - `soql` (string, required)
  - `limit` (number, optional)
  - `cursor` (string, optional)

- `salesforce.create_record`:
  - `object` (string, required)
  - `fields` (object, required)
  - `idempotencyKey` (string, optional)

## Jira Connector (MVP Tool Set)

Tools to implement:

- `jira.health`
- `jira.list_projects`
- `jira.get_issue`
- `jira.search_issues` (JQL)
- `jira.create_issue`
- `jira.update_issue`

Suggested input schemas:

- `jira.search_issues`:
  - `jql` (string, required)
  - `fields` (array, optional)
  - `limit` (number, optional)
  - `cursor` (string, optional)

- `jira.create_issue`:
  - `projectKey` (string, required)
  - `issueType` (string, required)
  - `fields` (object, required)
  - `idempotencyKey` (string, optional)

## Discord Connector (Tool Set)

Tools:

- `discord.health`
- `discord.list_guilds`
- `discord.get_guild`
- `discord.list_channels`
- `discord.get_channel`
- `discord.create_channel`
- `discord.edit_channel`
- `discord.delete_channel`
- `discord.send_message` (rich embeds, 2000-char validation)
- `discord.get_messages`
- `discord.create_thread`
- `discord.list_roles`
- `discord.create_role`
- `discord.edit_role`
- `discord.delete_role`
- `discord.add_reaction`
- `discord.create_webhook`
- `discord.list_webhooks`
- `discord.list_members`

Authentication: Bot token via `DISCORD_BOT_TOKEN`. Uses Discord REST API v10 (`https://discord.com/api/v10`).

Suggested input schemas:

- `discord.send_message`:
  - `channel_id` (string, required)
  - `content` (string, optional — up to 2000 characters)
  - `embeds` (array, optional — max 10, typed embed objects with title, description, color, fields, footer, image, thumbnail, author)

- `discord.create_channel`:
  - `guild_id` (string, optional — uses `DISCORD_GUILD_ID` default)
  - `name` (string, required)
  - `type` (number, optional — 0=text, 2=voice, 4=category, 5=announcement, 13=stage, 15=forum)
  - `topic` (string, optional)
  - `parent_id` (string, optional — category to nest under)

Rate limiting: Automatic 429 retry with `retry_after` parsing, capped at 2 retries and 10s max delay. Rate limit headers (`X-RateLimit-*`) are exposed in response `meta.rateLimit`.

Privileged intents: `discord.list_members` requires Server Members Intent; `discord.get_messages` requires Message Content Intent. The connector surfaces intent-specific error hints when these fail with 403/Missing Access.

Note: This REST API connector is separate from the Discord gateway adapter (`src/electron/gateway/channels/discord.ts`) which handles real-time WebSocket messaging for the multichannel gateway.

## Connector Template

A minimal MCP connector template is provided at:

- `connectors/templates/mcp-connector`

Use it to bootstrap new connectors quickly. It includes:

- Stdio MCP server implementation
- Example tool definitions
- Clean separation between tool definitions and handlers

## Built-in Connectors (Local Registry)

These are included in the local MCP registry and appear in **Settings → MCP Servers → Browse Registry**:

- Salesforce (CRM)
- Jira (Issue tracking)
- HubSpot (CRM)
- Zendesk (Support)
- ServiceNow (ITSM)
- Linear (Product/Issue tracking)
- Asana (Work management)
- Okta (Identity)
- Discord (Community/messaging — 19 tools)
- Slack (Team messaging)

## Phase 1 Exit Criteria

- Connector contract documented (this file).
- Template available and runnable.
- Tool sets defined for Salesforce and Jira.

Next phases will add OAuth UX, enterprise settings, audit logs, and managed connector hosting.
