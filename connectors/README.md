# Connectors

This folder contains connector templates and reference implementations.

Connectors are MCP servers that expose enterprise APIs (Salesforce, Jira, etc.) to CoWork OS via tools. They are designed to run outside the desktop app so they can be deployed locally or as a managed service.

Templates:

- `connectors/templates/mcp-connector`

Reference implementations:

- `connectors/salesforce-mcp`
- `connectors/jira-mcp`
- `connectors/hubspot-mcp`
- `connectors/zendesk-mcp`
- `connectors/servicenow-mcp`
- `connectors/linear-mcp`
- `connectors/asana-mcp`
- `connectors/okta-mcp`
- `connectors/resend-mcp`
- `connectors/discord-mcp`
- `connectors/google-workspace-mcp`
- `connectors/figma-mcp`
- `connectors/vercel-mcp`
- `connectors/monday-mcp`
- `connectors/finance-data-mcp`
- `connectors/maps-mcp`
- `connectors/home-assistant-mcp`
- `connectors/rhino-mcp`
- `connectors/blender-mcp`
- `connectors/comfyui-mcp`

Local app connectors that accept file paths, such as Rhino, Blender, and
ComfyUI, must scope file and directory arguments to a configured project root
(`COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`) before dispatching to
the bridge/API. They should also reject non-local bridge URLs and undeclared
tool names.

Business-system connectors (Salesforce, HubSpot, Zendesk, ServiceNow, Jira,
Linear) also list a `<connector>.describe_objects` tool marked
`_meta: { "cowork.objectManifest": true }`. It returns the objects the connector
holds and which tools read or write them. CoWork calls it itself and never
offers it to the model; see "Object Manifest" in the contract.

See `docs/enterprise-connectors.md` for the Phase 1 connector contract.
