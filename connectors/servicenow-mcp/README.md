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
