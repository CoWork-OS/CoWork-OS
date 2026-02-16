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

See `docs/enterprise-connectors.md` for the Phase 1 connector contract.
