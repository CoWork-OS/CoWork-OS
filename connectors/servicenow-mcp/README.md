# ServiceNow MCP Connector (MVP)

This connector exposes ServiceNow Table API endpoints to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `SERVICENOW_INSTANCE_URL` (e.g., `https://dev12345.service-now.com`) OR `SERVICENOW_INSTANCE` (subdomain only)
- `SERVICENOW_USERNAME` + `SERVICENOW_PASSWORD` (basic auth) OR `SERVICENOW_ACCESS_TOKEN` (bearer)

## Build & Run

```bash
npm install
npm run build
npm start
```

## Tools

- `servicenow.health`
- `servicenow.list_records`
- `servicenow.get_record`
- `servicenow.create_record`
- `servicenow.update_record`
- `servicenow.describe_objects` (object manifest, read by CoWork itself)

## Object manifest

`servicenow.describe_objects` lists `incident`, `problem`, `change_request` and `sys_user` with their fields, state codes and relations, and which tools read or write them. CoWork calls it itself; the model does not see it.
When the instance is configured it reads each table's own `sys_dictionary` columns (custom `u_` columns included) and its active English `sys_choice` states (GET only); columns inherited from `task`, and anything a failed read leaves out, come from the built-in definitions.
The whole live read gets 12 seconds; past that the built-in definitions are returned, so a slow instance does not hold up the connector's other calls. Journal, HTML and multi-line text columns are marked as personal data on every table.
Record links are added only when the instance URL is `https://`.
