# Resend MCP Connector (MVP)

This connector exposes Resend email APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `RESEND_API_KEY` (required)
- `RESEND_BASE_URL` (optional, default: `https://api.resend.com`)

## Build & Run

```bash
npm install
npm run build
npm start
```

## Tools

- `resend.health`
- `resend.send_email`
- `resend.list_webhooks`
- `resend.create_webhook`
- `resend.delete_webhook`
- `resend.get_received_email`

See `docs/enterprise-connectors.md` for the connector contract.
