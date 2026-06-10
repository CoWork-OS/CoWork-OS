# Blender MCP Connector

Local MCP connector for driving Blender through a localhost Blender bridge.

The connector defaults to `http://127.0.0.1:17642`. Override with:

```sh
COWORK_ARCH_PROJECT_ROOT=/path/to/project
BLENDER_MCP_BRIDGE_URL=http://127.0.0.1:17642
BLENDER_MCP_BRIDGE_TIMEOUT_MS=120000
```

The Blender bridge should expose JSON endpoints matching the tool names after
the `blender.` prefix, for example `POST /import_model` and `POST /render_view`.

Only localhost bridge URLs are accepted. File and directory arguments must
resolve inside `COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`; paths
outside that root and URL-style paths are rejected before they reach the bridge.
