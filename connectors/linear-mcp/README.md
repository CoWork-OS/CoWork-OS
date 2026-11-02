# Linear MCP Connector (MVP)

This connector exposes Linear GraphQL APIs to CoWork OS through MCP tools.

## Requirements

- `LINEAR_API_KEY` (required)

## Build & Run

```bash
npm install
npm run build
npm start
```

## Tools

- `linear.health`
- `linear.list_projects`
- `linear.search_issues`
- `linear.get_issue`
- `linear.describe_objects`

## Object manifest

`linear.describe_objects` returns issues and projects with their fields and Linear's default workflow states, and which tools read them.
CoWork calls it itself and hides it from the model; it makes no API call.
