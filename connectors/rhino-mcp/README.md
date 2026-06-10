# Rhino MCP Connector

Local MCP connector for driving Rhino through a localhost Rhino bridge.

The connector defaults to `http://127.0.0.1:17641`. Override with:

```sh
COWORK_ARCH_PROJECT_ROOT=/path/to/project
RHINO_MCP_BRIDGE_URL=http://127.0.0.1:17641
RHINO_MCP_BRIDGE_TIMEOUT_MS=120000
```

The Rhino bridge should expose JSON endpoints matching the tool names after the
`rhino.` prefix, for example `POST /create_project` and `POST /generate_massing`.

Only localhost bridge URLs are accepted. File and directory arguments must
resolve inside `COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`; paths
outside that root and URL-style paths are rejected before they reach the bridge.
