# HubSpot MCP Connector (MVP)

This connector exposes HubSpot CRM APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `HUBSPOT_ACCESS_TOKEN` (required)
- Optional refresh: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REFRESH_TOKEN`
- `HUBSPOT_BASE_URL` (optional, default: `https://api.hubapi.com`)

## Build & Run

```bash
npm install
npm run build
npm start
```

## Add to CoWork MCP Settings

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/hubspot-mcp/dist/index.js`
- **Env**: set the variables above

## Tools

- `hubspot.health`
- `hubspot.search_objects`
- `hubspot.get_object`
- `hubspot.create_object`
- `hubspot.update_object`
- `hubspot.describe_objects`

## Object manifest

`hubspot.describe_objects` returns the CRM objects this connector holds (contacts, companies, deals, tickets), their fields, default pipeline stages and which tools read or write them.
CoWork calls it itself and hides it from the model; it makes no API call.

See `docs/enterprise-connectors.md` for the connector contract.
