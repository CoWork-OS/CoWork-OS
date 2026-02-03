# Salesforce MCP Connector (MVP)

This connector exposes Salesforce APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `SALESFORCE_INSTANCE_URL` (required)
- `SALESFORCE_ACCESS_TOKEN` (recommended)

Optional OAuth refresh flow:

- `SALESFORCE_CLIENT_ID`
- `SALESFORCE_CLIENT_SECRET`
- `SALESFORCE_REFRESH_TOKEN`
- `SALESFORCE_LOGIN_URL` (default: `https://login.salesforce.com`)

Optional:

- `SALESFORCE_API_VERSION` (default: `60.0`)

## Build & Run

```bash
npm install
npm run build
npm start
```

## Add to CoWork MCP Settings

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/salesforce-mcp/dist/index.js`
- **Env**: set the variables above

## Tools

- `salesforce.health`
- `salesforce.list_objects`
- `salesforce.describe_object`
- `salesforce.get_record`
- `salesforce.search_records`
- `salesforce.create_record`
- `salesforce.update_record`

See `docs/enterprise-connectors.md` for the contract.
