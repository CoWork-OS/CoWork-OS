# Zendesk MCP Connector (MVP)

This connector exposes Zendesk Support APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `ZENDESK_SUBDOMAIN` (required unless `ZENDESK_BASE_URL` provided)
- `ZENDESK_EMAIL` (required for API token auth)
- `ZENDESK_API_TOKEN` (required for API token auth)

Optional:

- `ZENDESK_ACCESS_TOKEN` (OAuth bearer token)
- `ZENDESK_BASE_URL` (override full base URL, e.g., `https://your-domain.zendesk.com`)
- Optional refresh: `ZENDESK_CLIENT_ID`, `ZENDESK_CLIENT_SECRET`, `ZENDESK_REFRESH_TOKEN`

## Build & Run

```bash
npm install
npm run build
npm start
```

## Add to CoWork MCP Settings

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/zendesk-mcp/dist/index.js`
- **Env**: set the variables above

## Tools

- `zendesk.health`
- `zendesk.search_tickets`
- `zendesk.get_ticket`
- `zendesk.create_ticket`
- `zendesk.update_ticket`
- `zendesk.describe_objects`

## Object manifest

`zendesk.describe_objects` returns tickets, users and organizations with their fields, ticket statuses and relations, and which tools read or write tickets.
When `ZENDESK_SUBDOMAIN` or `ZENDESK_BASE_URL` is set, tickets link to their agent page.
CoWork calls it itself and hides it from the model; it makes no API call.

See `docs/enterprise-connectors.md` for the connector contract.
