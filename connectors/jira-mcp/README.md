# Jira MCP Connector (MVP)

This connector exposes Jira Cloud APIs to CoWork OS through MCP tools.

## Requirements

Provide credentials via environment variables:

- `JIRA_BASE_URL` (required) Example: `https://your-domain.atlassian.net`

Authentication options (choose one):

**1) OAuth (Bearer token)**

- `JIRA_ACCESS_TOKEN`
- Optional refresh: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REFRESH_TOKEN`

**2) API token (Basic auth)**

- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Optional:

- `JIRA_API_VERSION` (default: `3`)
  Notes for OAuth:
- If using Atlassian 3LO OAuth, set `JIRA_BASE_URL` to `https://api.atlassian.com/ex/jira/<cloudId>` (the app can set this automatically when using the OAuth UI).

## Build & Run

```bash
npm install
npm run build
npm start
```

## Add to CoWork MCP Settings

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/jira-mcp/dist/index.js`
- **Env**: set the variables above

## Tools

- `jira.health`
- `jira.list_projects`
- `jira.get_issue`
- `jira.search_issues`
- `jira.create_issue`
- `jira.update_issue`
- `jira.describe_objects`

## Object manifest

`jira.describe_objects` returns issues and projects with their fields, status categories and relations, and which tools read or write them.
Issues link to `<JIRA_BASE_URL>/browse/<key>` when `JIRA_BASE_URL` is an https site URL (not the `api.atlassian.com` OAuth gateway).
CoWork calls it itself and hides it from the model; it makes no API call.

See `docs/enterprise-connectors.md` for the contract.
