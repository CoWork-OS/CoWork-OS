# Enterprise Connectors

This document describes the current shipped MCP connector surface in CoWork OS. The goal is to expose enterprise integrations through a consistent MCP interface while keeping the app decoupled from connector implementation details and avoiding overlap with stronger native integrations.

## Phase 1 Goals

- Define a connector contract (naming, inputs, outputs, errors).
- Provide a reusable MCP connector template for new integrations.
- Specify MVP tool sets for Salesforce and Jira.
- Ship Salesforce and Jira connectors as installable MCP servers in the registry UI.

## Current Connector Strategy

Shipped enterprise connectors run as MCP servers and expose tools over MCP (stdio, SSE, or WebSocket). Each connector still uses direct APIs under the hood (OAuth, REST, GraphQL), but the app consumes them consistently through MCP.

For some integrations with strong native CoWork paths, the runtime now prefers direct APIs first and only falls back to MCP when needed. Today that applies to GitHub and Notion.

Connector notifications are also part of the runtime surface now: MCP resource updates and catalog-change notifications can be bridged into CoWork's Event Triggers so connector-side content changes can wake agents or create follow-up tasks.

Benefits:
- Decoupled release cadence (connectors ship independently of the desktop app).
- Supports local and managed deployments.
- Works with existing CoWork MCP settings, registry, and tool discovery.
- Avoids duplicate surfaces where native integrations are the better default.

## Connector Mentions In The Composer

The main message composer exposes connected/configured connectors through the grouped `@` menu under **Integrations**. The menu is resolved from local state only, so typing `@` does not run connector health checks or network discovery.

Connector mention behavior:

- native and Tier-1 integrations appear only when locally usable
- Google Workspace is shown as Gmail, Google Drive, and Google Calendar instead of one broad connector option
- multi-service MCP connectors split into service-level mention options when their exposed tool names make that safe
- unknown MCP connectors appear as one connector option only when connected/configured
- selected connectors render as icon+name chips in the prompt and user message history
- submitted `integrationMentions` metadata is soft routing guidance only; it does not grant permissions or set `allowedTools`

See [Composer Mentions](composer-mentions.md) for the full resolver and runtime contract.

## Connector Events and Content Triggers

CoWork can now treat MCP connector notifications as automation inputs, not just tool catalogs.

- `notifications/resources/updated` can trigger automations for specific resources or folders.
- `tools_changed`, `resources_changed`, and `prompts_changed` are normalized into `connector_event` payloads.
- Trigger rules can filter by `serverId`, `connectorId`, and `resourceUri`.
- The MCP client manager keeps resource subscriptions in sync with active triggers so the app only subscribes to connector resources it actually needs.

Examples:

- "When a Jira issue assigned to me changes, create a triage task."
- "When a Google Drive document in this folder changes, wake my research agent."

## Connector Transport and Operations

CoWork consumes MCP connectors across the supported transport modes:

- **stdio** for most locally installed registry connectors
- **SSE / streamable HTTP** when the connector exposes a hosted or long-lived server surface
- **WebSocket** for connectors or MCP hosts that need bidirectional session behavior

Operational notes:

- active trigger rules determine which connector resources CoWork subscribes to
- removing or disabling a trigger causes the MCP client manager to unsubscribe when that resource is no longer needed
- reconnects rebuild tool/resource catalogs and re-apply the active subscription set
- stale or failed subscriptions degrade to normal connector access rather than crashing the task runtime; operators should inspect connector status when trigger-driven automations stop firing

## Shipped Connector Allowlist

The shipped connector catalog includes **44 connectors** across CRM, productivity, devtools, communication, legal, and finance categories. Install from **Settings > Connectors > Browse Registry**.

### Enterprise & CRM (11)
Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta, Resend, Discord, Google Workspace

### Dev Tools & Analytics (19)
Figma, Vercel, Monday, Excalidraw, Supabase, Netlify, Honeycomb, Ahrefs, Cloudflare, Tavily, tldraw, Amplitude, Clerk, Grafana, Socket, Metabase, Shadcn UI, GrowthBook, Tomba

### Productivity (11)
Miro, Hugging Face, Mermaid Chart, Make, Smartsheet, Airtable, Cal.com, Cloudinary, Mem, Drafts (macOS), Fantastical (macOS)

### Finance & Payments (4)
Stripe, PayPal, Square, Attio

### Legal (1)
Clinical Trials

### Communication (1)
Mailtrap

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

## Google Workspace Connector (OAuth)

Three Google integrations using shared OAuth with PKCE flow:

- `google_calendar.*` — List calendars, get/create/update/delete events
- `google_drive.*` — List files, search, read, upload, manage permissions
- `gmail.*` — List messages, search, read, send, manage labels

Authentication: OAuth 2.0 with PKCE via local callback server (port 18765). Scopes are mapped per service (Calendar, Drive, Gmail).

## Connector Template

A minimal MCP connector template is provided at:

- `connectors/templates/mcp-connector`

Use it to bootstrap new connectors quickly. It includes:

- Stdio MCP server implementation
- Example tool definitions
- Clean separation between tool definitions and handlers

## Built-in Connectors (Local Registry)

**44 connectors** are included in the local MCP registry and appear in **Settings → Connectors → Browse Registry**. All are npm-installable MCP servers (stdio transport) unless noted as manual (bundled connectors).

| Category | Connectors |
|----------|------------|
| **CRM & Enterprise** | Salesforce, Jira, HubSpot, Zendesk, ServiceNow, Linear, Asana, Okta |
| **Communication** | Resend, Discord, Mailtrap |
| **Productivity** | Google Workspace (OAuth), Figma, Vercel, Monday, Miro, Supabase, Excalidraw, Make, Smartsheet, Netlify, Airtable, Cal.com, Cloudinary, Mem, Drafts (macOS), Fantastical (macOS) |
| **Dev Tools** | Hugging Face, Ahrefs, Mermaid Chart, Cloudflare, Honeycomb, Tavily, tldraw, Amplitude, Clerk, Grafana, Socket, Metabase, Shadcn UI, GrowthBook, Tomba |
| **Finance** | Stripe, PayPal, Square, Attio |
| **Legal** | Clinical Trials |

Not shipped in the current connector catalog: Slack, DocuSign, Outreach (removed from Tier-1). Slack remains available as a channel gateway. GitHub and Notion prefer native CoWork integrations first, with MCP as fallback.

## Chat Setup Orchestration (Tier-1)

The runtime now exposes a provider-agnostic setup tool for Tier-1 connectors:

- Tool: `integration_setup`
- Actions: `list`, `inspect`, `configure`
- Providers: `resend`, `google-workspace`, `jira`, `linear`, `hubspot`, `salesforce`, `zendesk`, `servicenow`

Operational contract:

- `list`: returns install/config/connect/ready status for each Tier-1 provider
- `inspect`: returns missing inputs and a deterministic `plan_hash`
- `configure`: can install, apply env/OAuth settings, connect, and health-check
- `expected_plan_hash` can be passed to `configure`; if stale, configure fails safely with `stale_plan=true` and performs no mutation
- Resend keeps provider-specific inbound webhook configuration (`enable_inbound`, `webhook_secret`)

Shared capability metadata now drives both:

- chat setup semantics (`integration_setup`)
- MCP auto-connect readiness checks

This removes drift between configuration UI/runtime behavior and connector readiness detection.

See [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](integration-skill-bootstrap-lifecycle.md) for full payload examples and response fields.

## Phase 1 Exit Criteria

- Connector contract documented (this file).
- Template available and runnable.
- Tool sets defined for Salesforce and Jira.

Next phases will add OAuth UX, enterprise settings, audit logs, and managed connector hosting.
