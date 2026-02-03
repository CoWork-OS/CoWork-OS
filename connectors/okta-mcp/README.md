# Okta MCP Connector (MVP)

This connector exposes Okta Users API endpoints to CoWork OS through MCP tools.

## Requirements

- `OKTA_BASE_URL` (e.g., `https://your-org.okta.com`)
- `OKTA_API_TOKEN`

## Build & Run

```bash
npm install
npm run build
npm start
```

## Tools

- `okta.health`
- `okta.list_users`
- `okta.get_user`
- `okta.create_user`
- `okta.update_user`
