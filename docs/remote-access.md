# Remote Access Guide

CoWork-OSS provides multiple options for remote access to your Control Plane, allowing you to manage tasks, monitor progress, and interact with agents from anywhere.

## Overview

The Control Plane WebSocket server binds to `127.0.0.1:18789` by default for security. For remote access, you have three options:

| Method | Use Case | Setup Complexity |
|--------|----------|------------------|
| **SSH Tunnel** | Personal use, existing SSH infrastructure | Low |
| **Tailscale Serve** | Private network access (Tailnet only) | Medium |
| **Tailscale Funnel** | Public internet access | Medium |

## SSH Tunnel (Recommended for Personal Use)

SSH tunnels provide secure remote access using standard SSH port forwarding. This is ideal if you already have SSH access to the machine running CoWork.

### Prerequisites

- SSH access to the remote machine running CoWork
- Control Plane enabled in CoWork settings
- Authentication token configured

### Setup

1. **Enable Control Plane** in CoWork Settings > Control Plane
2. **Note your token** (copy it for client configuration)
3. **Create SSH tunnel** from your local machine:

```bash
# Basic SSH tunnel
ssh -N -L 18789:127.0.0.1:18789 user@remote-host

# With keep-alive for long sessions
ssh -N -L 18789:127.0.0.1:18789 -o ServerAliveInterval=60 user@remote-host

# Background mode
ssh -fN -L 18789:127.0.0.1:18789 user@remote-host
```

4. **Connect your client** to `ws://127.0.0.1:18789` with your token

### SSH Tunnel Options

| Flag | Description |
|------|-------------|
| `-N` | Don't execute remote commands (tunnel only) |
| `-L` | Local port forwarding |
| `-f` | Run in background |
| `-o ServerAliveInterval=60` | Keep connection alive |

### Custom Port

If you've configured a different port in CoWork:

```bash
# Replace 18789 with your configured port
ssh -N -L <local-port>:127.0.0.1:<remote-port> user@remote-host
```

### Persistent Tunnel with autossh

For automatic reconnection, use `autossh`:

```bash
# Install autossh
brew install autossh  # macOS
apt install autossh   # Debian/Ubuntu

# Create persistent tunnel
autossh -M 0 -N -L 18789:127.0.0.1:18789 \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  user@remote-host
```

## Tailscale Integration

Tailscale provides zero-config VPN networking. CoWork supports two modes:

### Tailscale Serve (Private Network)

Exposes your Control Plane to devices on your Tailnet only.

1. **Install Tailscale** from [tailscale.com](https://tailscale.com)
2. **Connect to your Tailnet**: `tailscale up`
3. **Enable in CoWork**: Settings > Control Plane > Tailscale Mode > "Serve"
4. **Access via**: `wss://<hostname>.<tailnet>.ts.net`

### Tailscale Funnel (Public Internet)

Exposes your Control Plane to the public internet (requires Tailscale subscription).

1. **Enable Funnel** on your Tailscale account
2. **Enable in CoWork**: Settings > Control Plane > Tailscale Mode > "Funnel"
3. **Access via**: `wss://<hostname>.<tailnet>.ts.net` from anywhere

## Security Considerations

### Best Practices

1. **Keep gateway loopback-only**: Never bind to `0.0.0.0` unless absolutely necessary
2. **Use strong tokens**: CoWork generates 256-bit tokens by default
3. **Rotate tokens regularly**: Use the "Regenerate Token" button periodically
4. **Enable TLS**: Use `wss://` over public networks (automatic with Tailscale)
5. **Rate limiting**: CoWork automatically blocks IPs after 5 failed auth attempts

### Authentication Flow

```
Client                              CoWork Control Plane
  │                                        │
  │  ─────── WebSocket Connect ──────────► │
  │                                        │
  │  ◄────── Challenge (nonce) ─────────── │
  │                                        │
  │  ─────── Connect { token } ──────────► │
  │                                        │
  │  ◄────── Success + Client ID ───────── │
  │                                        │
  │  ═══════ Authenticated Session ═══════ │
```

### Token Storage

- Tokens are encrypted using the OS keychain (via Electron's safeStorage)
- Never share tokens in plain text
- Use environment variables or secure vaults for automation

## Client Configuration

### Example: Node.js Client

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:18789');

ws.on('open', () => {
  // Send connect request with token
  ws.send(JSON.stringify({
    type: 'request',
    id: 1,
    method: 'connect',
    params: {
      token: 'your-token-here',
      deviceName: 'My CLI Client'
    }
  }));
});

ws.on('message', (data) => {
  const frame = JSON.parse(data);
  console.log('Received:', frame);
});
```

### Example: Python Client

```python
import asyncio
import websockets
import json

async def connect():
    uri = "ws://127.0.0.1:18789"
    async with websockets.connect(uri) as ws:
        # Authenticate
        await ws.send(json.dumps({
            "type": "request",
            "id": 1,
            "method": "connect",
            "params": {
                "token": "your-token-here",
                "deviceName": "Python Client"
            }
        }))

        response = await ws.recv()
        print(f"Response: {response}")

asyncio.run(connect())
```

## Remote Client Mode (Connecting to Remote CoWork)

CoWork can also operate as a client connecting to a remote Control Plane. This is useful when you want to use a local CoWork instance to manage tasks on a remote machine.

### Configuration

In Settings > Control Plane > Remote Connection:

| Setting | Description |
|---------|-------------|
| **Gateway URL** | WebSocket URL (e.g., `ws://127.0.0.1:18789` via SSH tunnel) |
| **Token** | Authentication token from the remote Control Plane |
| **TLS Fingerprint** | (Optional) Certificate pin for `wss://` connections |

### Connection Modes

| Mode | Description |
|------|-------------|
| **Local** | This CoWork instance runs the Control Plane server |
| **Remote** | Connect to a Control Plane on another machine |

## Troubleshooting

### SSH Tunnel Issues

**Connection refused:**
```bash
# Check if CoWork is running and Control Plane is enabled
curl http://127.0.0.1:18789/health
```

**Tunnel disconnects:**
```bash
# Use keep-alive options
ssh -N -L 18789:127.0.0.1:18789 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  user@remote-host
```

### Authentication Failures

**"Too many failed attempts":**
- Wait 5 minutes (automatic ban expires)
- Or restart the Control Plane server

**"Invalid token":**
- Verify token matches the one in CoWork settings
- Check for extra whitespace when copying

### Tailscale Issues

**"Funnel not available":**
- Ensure you have a Tailscale subscription with Funnel enabled
- Run `tailscale serve status` to check configuration

## API Reference

See the [Control Plane Protocol](./control-plane-protocol.md) documentation for the full WebSocket API.
