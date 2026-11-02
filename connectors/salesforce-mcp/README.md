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
- `salesforce.describe_objects` (object manifest, read by CoWork itself)

## Object manifest

`salesforce.describe_objects` lists Account, Contact, Lead, Opportunity, Case and Task with their fields, status values and relations, and which tools read or write them. CoWork calls it itself; the model does not see it.
When the org is configured it reads each object's describe (GET only) for labels, active picklist values and custom fields; without credentials, or for an object whose describe fails, the built-in definitions are returned.
The whole live read gets 12 seconds; past that the built-in definitions are returned, so a slow org does not hold up the connector's other calls. Long and rich text areas are marked as personal data on every object.
Record links use `SALESFORCE_INSTANCE_URL` and are left out unless it is `https://`.

See `docs/enterprise-connectors.md` for the contract.
