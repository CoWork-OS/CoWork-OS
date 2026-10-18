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

## Write tools and idempotency

CoWork sends a stable key for each tool attempt in the request's `_meta`
(`"cowork.idempotencyKey"`); a retry of the same call carries the same key. In `src/index.ts`:

- `readIdempotency(params)` reads it; `idempotencyKeyFor(args, context)` prefers an
  `idempotencyKey` argument when the caller passed one.
- `ledger.run(key, write, findExisting?)` runs the write at most once per key in this process and
  returns its `status`: `created`, `already_exists` (an earlier attempt made the change) or
  `unknown` (no response from the API). `findExisting` is asked only after an unanswered attempt,
  to find what it may have created.
- `writeResult(outcome, envelope)` builds the tool result, and the server adds the status to
  `structuredContent` (with `isError: true` for `unknown`).

`example.create_item` shows the pattern. When the API has its own idempotency header, send the
key there too: that also covers a connector restart, which the in-process ledger does not.

See `docs/enterprise-connectors.md` for the connector contract and tool naming.
