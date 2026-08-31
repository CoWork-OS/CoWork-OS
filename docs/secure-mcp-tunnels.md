# Secure MCP Tunnels

Secure MCP Tunnels let CoWork OS expose selected local or private MCP tools through an outbound-only relay that you operate. They provide the same basic shape as a hosted secure tunnel service without depending on OpenAI, ngrok, localtunnel, or a public inbound port on the user's machine.

This feature is guarded by `COWORK_SECURE_MCP_TUNNELS=1`.

## Access Profile Boundary

Secure MCP Tunnel credentials authorize the tunnel transport; they do not
grant a task new local capabilities. When the target is the local CoWork MCP
host, the target node still applies the task's effective [access
profile](access-profiles.md), administrator policy, tool restrictions, and
hard guardrails before a tool executes. Relay policy and `allowedTools` can
only narrow that result. A caller token cannot select a broader profile,
escape a filesystem/domain boundary, or turn a denied profile into an
available one.

## What It Solves

Use Secure MCP Tunnels when a remote CoWork surface needs to call a private MCP server:

- CoWork desktop tools running on a user's laptop
- a private HTTP MCP endpoint on `127.0.0.1`
- an MCP endpoint on a private LAN address such as `10.x.x.x` or `192.168.x.x`
- a headless/server CoWork node that should not expose arbitrary inbound ports

The local CoWork app opens an outbound WebSocket to a CoWork relay. Remote callers send MCP JSON-RPC requests to the relay, and the relay forwards only those MCP messages over the existing outbound socket.

```text
Remote CoWork caller
  -> CoWork secure MCP tunnel relay
  -> outbound WebSocket held by local CoWork OS
  -> local/private MCP HTTP endpoint
  -> response returns through the same tunnel
```

## How This Differs From Webhook Tunnels

Webhook tunnels such as ngrok/localtunnel expose a local HTTP port publicly. Secure MCP Tunnels do not.

| Capability | Webhook tunnel | Secure MCP tunnel |
|---|---|---|
| Primary use | Public webhook ingress | MCP JSON-RPC forwarding |
| Network direction from user machine | Public inbound URL to local port | Outbound WebSocket to relay |
| Target scope | Any HTTP path on exposed port | Configured MCP endpoint only |
| Policy layer | Channel/webhook auth | Tool allowlist, read-only mode, size/time limits |
| Recommended for MCP tools | No | Yes |

Keep webhook tunnels for channels that need public webhook callbacks. Use Secure MCP Tunnels for private MCP tool access.

## Components

### Local Tunnel Client

Implemented in `src/electron/tunnels/TunnelClient.ts`.

Responsibilities:

- connect outbound to the relay with a tunnel client token
- advertise local target metadata
- receive `mcp_request` messages
- forward requests to the configured MCP target
- return `mcp_response` or `mcp_error`
- reconnect with backoff
- emit status and audit events

### MCP Forwarder

Implemented in `src/electron/tunnels/McpTunnelForwarder.ts`.

The forwarder posts MCP JSON-RPC to the configured HTTP MCP target. For the built-in CoWork target, it points at:

```text
http://127.0.0.1:<coworkHostPort>/mcp
```

Custom HTTP targets must be loopback, `.local`, or private-network addresses. Public HTTP targets are rejected because this tunnel is not intended to become a generic proxy.

### Tunnel Supervisor

Implemented in `src/electron/tunnels/TunnelSupervisor.ts`.

Responsibilities:

- manage active tunnel clients
- start enabled tunnels when the feature flag is enabled
- stop clients cleanly
- keep connection status for the Settings UI
- persist redacted audit events to JSONL

### Relay

Implemented in `src/electron/tunnels/relay.ts`.

The relay is self-hostable. It keeps tunnel records and active sessions in memory in the current MVP. Production deployments should add durable storage and tenant ownership checks before multi-user use.

## Enable The Feature

Set the feature flag before starting CoWork OS:

```bash
export COWORK_SECURE_MCP_TUNNELS=1
npm run dev
```

For packaged or daemon environments, add the same environment variable to the launch service or shell profile.

## Start A Local Relay

For development:

```bash
export COWORK_TUNNEL_RELAY_ADMIN_TOKEN="replace-with-a-long-random-token"
npm run tunnel-relay:dev
```

The relay listens on `127.0.0.1:8787` by default.

Optional relay environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `COWORK_TUNNEL_RELAY_PORT` | `8787` | Relay HTTP/WebSocket port |
| `COWORK_TUNNEL_RELAY_HOST` | `127.0.0.1` | Bind host |
| `COWORK_TUNNEL_RELAY_ADMIN_TOKEN` | unset | Required to create tunnel credentials |
| `COWORK_TUNNEL_RELAY_ALLOW_DEV_ADMIN` | unset | Set to `1` only for local tests that intentionally skip admin auth |

The relay fails closed for credential creation when no admin token is configured. Do not set `COWORK_TUNNEL_RELAY_ALLOW_DEV_ADMIN=1` outside local development tests.

## Provision A Tunnel On The Relay

Create relay-side credentials:

```bash
curl -sS \
  -X POST http://127.0.0.1:8787/v1/tunnels \
  -H "authorization: Bearer $COWORK_TUNNEL_RELAY_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "my-local-cowork-tools",
    "policy": {
      "allowedTools": [],
      "readOnly": false,
      "requestTimeoutMs": 60000
    }
  }'
```

The response includes:

```json
{
  "id": "tun_...",
  "clientToken": "ctun_...",
  "callerToken": "ccall_...",
  "policy": {
    "allowedTools": [],
    "readOnly": false,
    "maxRequestBytes": 262144,
    "maxResponseBytes": 1048576,
    "requestTimeoutMs": 60000
  }
}
```

Keep `clientToken` on the local machine that owns the private MCP target. Give `callerToken` only to the trusted remote caller or service that should be able to invoke the tunnel.

You can also provide your own `clientToken` and `callerToken` in the create request when integrating with an external secret manager.

## Configure The Local CoWork App

1. Start CoWork with `COWORK_SECURE_MCP_TUNNELS=1`.
2. Open **Settings > MCP > Secure Tunnels**.
3. Click **Add Tunnel**.
4. Enter the relay URL, for example `http://127.0.0.1:8787` for local development or `https://relay.example.com` for production.
5. Choose a target:
   - **CoWork MCP host**: exposes CoWork's connected MCP tools through the local MCP host.
   - **Private HTTP MCP URL**: forwards to a private MCP endpoint such as `http://127.0.0.1:3333/mcp`.
6. Paste the relay `clientToken`.
7. Optionally paste the relay `callerToken` for local reference.
8. Add an allowlist of tool names, or leave it empty to allow all tools exposed by the target.
9. Enable **Read-only mode** when remote callers should not invoke write-like tools.
10. Save and click **Start**.

When the target is **CoWork MCP host**, CoWork starts its local MCP HTTP host on the configured port and points the tunnel at `/mcp`. If the host was already running on the wrong transport or port, CoWork restarts it on the requested HTTP port.

## Call A Tunnel

Remote callers invoke the relay endpoint with the caller token:

```bash
curl -sS \
  -X POST http://127.0.0.1:8787/v1/tunnels/tun_.../mcp \
  -H "authorization: Bearer ccall_..." \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Tool calls use normal MCP JSON-RPC:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "mcp_example.read",
    "arguments": {
      "id": "abc123"
    }
  }
}
```

## Security Model

The tunnel is intentionally not a generic HTTP proxy.

Security controls:

- The relay requires an admin bearer token before it creates tunnel credentials.
- Local tunnel clients authenticate with a `clientToken`.
- Remote callers authenticate with a separate `callerToken`.
- Relay-side policy is authoritative. The local client cannot relax it.
- Local policy is also enforced before forwarding to the private MCP target.
- The target task's access profile remains authoritative for CoWork MCP-host calls; tunnel tokens do not widen it.
- Plain HTTP relay URLs are allowed only for loopback development; non-loopback relay URLs must use HTTPS/WSS.
- Custom MCP targets must be loopback, `.local`, or private-network addresses.
- Request and response size limits are enforced.
- Request timeouts are enforced.
- The relay caps pending requests per tunnel.
- Audit events record metadata only, not full request or response bodies.

Default policy limits:

| Setting | Default |
|---|---:|
| `maxRequestBytes` | `262144` |
| `maxResponseBytes` | `1048576` |
| `requestTimeoutMs` | `60000` |
| `allowedTools` | empty means all tools |
| `readOnly` | `false` |

Read-only mode uses a conservative tool-name heuristic. It blocks tool names containing write-like tokens such as `write`, `create`, `update`, `delete`, `remove`, `send`, `publish`, `execute`, `run`, `install`, `deploy`, `commit`, and `push`. For stronger production control, use explicit `allowedTools`.

## Audit Logs

Runtime audit events are visible in **Settings > MCP > Secure Tunnels** and persisted locally as JSONL under the app user-data security directory.

Events include:

- tunnel ID
- timestamp
- caller label when provided
- MCP method
- tool name for `tools/call`
- approved/blocked result
- status
- duration
- redacted error message

Full MCP request and response bodies are not logged by default.

## Production Deployment Notes

The current relay is an in-memory MVP suitable for local development, single-host self-hosting, and integration testing. Before operating it as a shared production service, add:

- durable tunnel records
- hashed token storage
- tenant/workspace ownership
- token rotation and revocation APIs
- TLS termination with strict HTTPS/WSS
- per-token rate limits
- structured audit export
- health checks and metrics
- multi-node session routing if more than one relay instance is deployed

For single-host self-hosting, keep the relay behind a private network, reverse proxy, or Tailscale. Do not expose an unauthenticated relay admin API.

## Troubleshooting

### Start Button Is Disabled

The local tunnel requires a client token. Provision a relay tunnel first, then paste the returned `clientToken` into **Settings > MCP > Secure Tunnels**.

### "Secure MCP Tunnels Are Disabled"

Start CoWork with:

```bash
export COWORK_SECURE_MCP_TUNNELS=1
```

### "Tunnel Relay URL Must Use HTTPS"

Plain HTTP is allowed only for loopback development (`localhost`, `127.0.0.1`, or `::1`). Use `https://` for remote relays.

### "Tunnel Client Is Not Connected"

The relay has a tunnel record, but no local CoWork client is connected. Check:

- the local tunnel is started in Settings
- the client token matches the relay tunnel record
- the relay URL points to the correct host
- firewalls or reverse proxies allow WebSocket upgrades to `/v1/tunnels/connect`

### Tool Calls Are Blocked

Check the relay policy and the local tunnel policy:

- `allowedTools` blocks all tools not listed when non-empty
- read-only mode blocks write-like tool names
- request or response size limits may reject large payloads
- the target task's access profile or administrator policy may deny the tool; choose a valid, sufficiently capable profile on the target node rather than widening the tunnel policy

### Local CoWork Host Fails

For **CoWork MCP host** targets, make sure the requested port is free. CoWork uses `http://127.0.0.1:<port>/mcp`.

## Verification

Focused tests:

```bash
npx vitest run src/electron/tunnels/__tests__/protocol.test.ts src/electron/tunnels/__tests__/relay.test.ts
```

Compile:

```bash
npm run build:electron
npm run build:react
```

End-to-end local smoke:

```bash
npm run tunnel-relay:test
```

The smoke starts a local relay, starts a local MCP test endpoint, connects a WebSocket tunnel client, sends `tools/list` through the relay, and verifies the response.
