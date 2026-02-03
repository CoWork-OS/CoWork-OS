# MCP Connector Template

This is a minimal MCP server template for building CoWork enterprise connectors.

## Quick Start

1. Install deps and build:

```bash
npm install
npm run build
```

2. Run the server:

```bash
npm start
```

3. Add to CoWork MCP Settings:

- **Command**: `node`
- **Args**: `/absolute/path/to/connectors/templates/mcp-connector/dist/index.js`

## Customization Steps

1. Rename the connector prefix in `src/index.ts`.
2. Replace the example tools with real tools.
3. Implement OAuth and API calls inside the handlers.

See `docs/enterprise-connectors.md` for the connector contract and tool naming.
