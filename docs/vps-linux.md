# Linux VPS (Headless) Guide

CoWork OS can run on Linux as a long-running daemon in two ways:

1. **Node-only daemon (recommended for VPS)**: no Electron/Xvfb required.
2. **Headless Electron daemon**: closer to desktop parity, but requires Electron runtime deps + Xvfb.

Both modes can be driven remotely using:

- `--headless` (no Electron windows)
- The **WebSocket Control Plane** for remote task creation/monitoring (Web UI + CLI)
- Optional channel gateways (Telegram/Discord/Slack/etc) if you’ve configured them in the DB

This mode is designed for VPS/systemd/docker deployments.

If you want an overview (what the interface is, which runtime to pick, what works on Linux), start with:

- `docs/self-hosting.md`

## Start Here (First-Time VPS Install)

If you just want to get CoWork OS running and open the web UI, use this path first.

What you need:

- SSH access to your VPS (`user@your-vps`)
- One LLM API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`)
- Two terminals (one for server, one for SSH tunnel)

1. On your VPS (server terminal):

```bash
ssh user@your-vps
```

2. Check Node.js + npm:

```bash
node -v
npm -v
```

`cowork-os` requires Node `>=24.0.0`.

If either command is missing, or you see `v22`/`v23`, install Node.js 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

3. Install and start CoWork OS (Node-only daemon, no sudo/global npm required):

```bash
mkdir -p ~/cowork-run
cd ~/cowork-run
npm init -y >/dev/null
npm install cowork-os@latest --no-audit --no-fund

export COWORK_IMPORT_ENV_SETTINGS=1
export OPENAI_API_KEY=your_key_here   # or: export ANTHROPIC_API_KEY=your_key_here
npx coworkd-node --print-control-plane-token
```

Keep this terminal open. It runs the server and prints the token you need for login.

4. On your local machine (second terminal), open SSH tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-vps
```

If local port `18789` is busy:

```bash
ssh -N -L 28789:127.0.0.1:18789 user@your-vps
```

5. Open the dashboard in your browser:

- `http://127.0.0.1:18789/` (or `http://127.0.0.1:28789/` if you used 28789)
- Paste the Control Plane token printed in step 3

This quick start is great for first run/testing. For always-on production, continue with **Option A (Docker)** or **Option B (Systemd)** below.

### Common First-Run Errors

- `npm WARN EBADENGINE`:
  Node version is too old. Install Node 24 and retry step 3.
- `npm ERR! EACCES` on `npm install -g ...`:
  This guide intentionally uses local install (`npm install` + `npx coworkd-node`) so you do not need global npm permissions.
- `sh: 1: tsc: not found` after `npx coworkd-node`:
  You are likely on an older broken npm publish that missed daemon build artifacts. Upgrade and retry:
  `npm install cowork-os@latest --no-audit --no-fund`

## Option A: Docker (Headless Electron)

This repo includes a headless Docker image that runs CoWork OS as a daemon.

### How You Use It (After It’s Running)

1. Create an SSH tunnel from your laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-vps
```

If your local machine already uses port `18789`, use a different local port (example: `28789`):

```bash
ssh -N -L 28789:127.0.0.1:18789 user@your-vps
```

2. Open the minimal Control Plane Web UI locally:

```text
http://127.0.0.1:18789/
```

3. Or use `coworkctl`:

```bash
export COWORK_CONTROL_PLANE_URL=ws://127.0.0.1:18789
export COWORK_CONTROL_PLANE_TOKEN=... # from logs (first token generation) or via --print-control-plane-token
node bin/coworkctl.js call config.get
```

1. Build and start:

```bash
docker compose up --build -d
```

If you prefer the **Node-only daemon** (no Electron/Xvfb), use the compose profile:

```bash
docker compose --profile node up --build -d cowork-os-node
```

Defaults in `docker-compose.yml`:

- Persistent data volume mounted at `/data`
- A persistent workspace volume mounted at `/workspace` (bootstrapped automatically). You can swap this for a host bind mount if you want CoWork OS to operate on files on the VPS.
- Control Plane published on host loopback: `127.0.0.1:18789` (safe default)

2. View the Control Plane token (printed on first startup when it’s generated):

```bash
docker compose logs -f cowork-os
```

If you need to print it again later, restart with:

- `COWORK_PRINT_CONTROL_PLANE_TOKEN=1` (env) or
- `--print-control-plane-token` (flag)

## Option B: Systemd (Node-Only Daemon)

This is the simplest non-Docker setup when you don’t want to install Xvfb/Electron GUI deps.

1. Install OS deps (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl git \
  python3 make g++
```

2. Install Node.js (22+ recommended) and build CoWork OS:

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git /opt/cowork-os
cd /opt/cowork-os
npm run setup:server
npm run build:daemon
npm run build:connectors
```

On first start, `bin/coworkd-node.js` may rebuild `better-sqlite3` for your Node version (native addon ABI).

3. Create a dedicated user + data dir:

```bash
sudo useradd -r -m -s /usr/sbin/nologin cowork || true
sudo mkdir -p /var/lib/cowork-os
sudo chown -R cowork:cowork /var/lib/cowork-os
```

If you cloned/built as `root`, ensure the service user can read (and rebuild native deps if needed):

```bash
sudo chown -R cowork:cowork /opt/cowork-os
```

4. Install the systemd unit + env file templates:

- Unit: `deploy/systemd/cowork-os-node.service`
- Env example: `deploy/systemd/cowork-os.env.example`

```bash
sudo cp /opt/cowork-os/deploy/systemd/cowork-os.env.example /etc/cowork-os.env
sudo $EDITOR /etc/cowork-os.env

sudo cp /opt/cowork-os/deploy/systemd/cowork-os-node.service /etc/systemd/system/cowork-os-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now cowork-os-node

sudo journalctl -u cowork-os-node -f
```

## Optional: Browser Automation (Playwright)

CoWork OS includes browser automation tools (Playwright). On minimal Linux VPS images (and especially slim Docker images),
Chromium may fail to launch until OS dependencies are installed.

If you want browser tools on Debian/Ubuntu, you can install Playwright’s Chromium + dependencies:

```bash
cd /opt/cowork-os
sudo npx playwright install --with-deps chromium
```

If you don’t need browser automation, you can ignore this and rely on `web_fetch` + API-based search providers.

If you’re running under Docker and want Playwright inside the container, you’ll want a container image that includes
the required libraries. (We can add an optional “Playwright-ready” Docker profile/image next.)

## Option C: Systemd (Headless Electron)

This is a good fit when you don’t want Docker.

1. Install OS deps (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl git \
  python3 make g++ \
  xvfb xauth \
  fonts-liberation \
  libgtk-3-0 libnss3 libxss1 libasound2 \
  libgbm1 libdrm2 libxshmfence1 \
  libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdbus-1-3 libnspr4 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  libxext6 libxfixes3 libxcb1 libxrender1 \
  libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
  libexpat1 libglib2.0-0 libsecret-1-0
```

2. Install Node.js (22+ recommended) and build CoWork OS:

```bash
git clone https://github.com/CoWork-OS/CoWork-OS.git /opt/cowork-os
cd /opt/cowork-os
npm run setup:server
npm run build:electron
npm run build:connectors
```

3. Create a dedicated user + data dir:

```bash
sudo useradd -r -m -s /usr/sbin/nologin cowork || true
sudo mkdir -p /var/lib/cowork-os
sudo chown -R cowork:cowork /var/lib/cowork-os
```

4. Install the systemd unit + env file templates:

- Unit: `deploy/systemd/cowork-os.service`
- Env example: `deploy/systemd/cowork-os.env.example`

Example install commands:

```bash
sudo cp /opt/cowork-os/deploy/systemd/cowork-os.env.example /etc/cowork-os.env
sudo $EDITOR /etc/cowork-os.env

sudo cp /opt/cowork-os/deploy/systemd/cowork-os.service /etc/systemd/system/cowork-os.service
sudo systemctl daemon-reload
sudo systemctl enable --now cowork-os

sudo journalctl -u cowork-os -f
```

## Recommended: Persistent Data Directory

On VPS you usually want the DB/settings under a known path (for backups and container volumes).

```bash
export COWORK_USER_DATA_DIR=/var/lib/cowork-os
node bin/coworkd-node.js
```

Or via CLI flag:

```bash
node bin/coworkd-node.js --user-data-dir /var/lib/cowork-os
```

## Bootstrapping a Workspace (Important)

Headless instances can’t “Select Folder” via UI, so you must either:

1. Bootstrap a default workspace at startup:

```bash
export COWORK_BOOTSTRAP_WORKSPACE_PATH=/srv/cowork/workspace
export COWORK_BOOTSTRAP_WORKSPACE_NAME=main
```

2. Or create one remotely over the Control Plane using `workspace.create`.

### coworkctl (Simple Control Plane CLI)

Use the bundled helper to call Control Plane methods:

```bash
export COWORK_CONTROL_PLANE_URL=ws://127.0.0.1:18789
export COWORK_CONTROL_PLANE_TOKEN=... # from startup logs

node bin/coworkctl.js call workspace.list
node bin/coworkctl.js call workspace.create '{"name":"main","path":"/srv/cowork/workspace"}'
node bin/coworkctl.js call config.get
node bin/coworkctl.js watch --event task.event
node bin/coworkctl.js tail '<taskId>' --limit 200
```

## Configure Channels (Headless)

If you want to interact with the agent via Telegram/Discord/Slack/etc on a VPS, you can configure and manage channels over the Control Plane (no desktop UI required).

Examples:

```bash
node bin/coworkctl.js call channel.list

# Create a Telegram channel (disabled by default; test then enable)
node bin/coworkctl.js call channel.create '{"type":"telegram","name":"telegram","config":{"botToken":"..."},"securityConfig":{"mode":"pairing"}}'
node bin/coworkctl.js call channel.test '{"channelId":"..."}'
node bin/coworkctl.js call channel.enable '{"channelId":"..."}'
```

## Configure LLM/Search Credentials (Headless)

You have two headless-friendly options:

1. **Control Plane setup (recommended once running)**  
   Use the Web UI **LLM Setup** panel or call `llm.configure` via `coworkctl`.
2. **Env import on boot**  
   Keep credentials in environment variables and import them at startup.

### Option 1: Configure via Control Plane

Examples:

```bash
# OpenAI
node bin/coworkctl.js call llm.configure '{"providerType":"openai","apiKey":"sk-...","model":"gpt-4o-mini"}'

# Ollama (remote/local URL)
node bin/coworkctl.js call llm.configure '{"providerType":"ollama","settings":{"baseUrl":"http://127.0.0.1:11434"},"model":"gpt-oss:20b"}'

# Azure OpenAI
node bin/coworkctl.js call llm.configure '{"providerType":"azure","apiKey":"...","settings":{"endpoint":"https://...","deployment":"gpt-4.1-mini"}}'
```

Then verify:

```bash
node bin/coworkctl.js call config.get
```

### Option 2: Configure via env import

CoWork OS supports an explicit, opt-in import path:

- `COWORK_IMPORT_ENV_SETTINGS=1` (or `--import-env-settings`)
- Optional: `COWORK_IMPORT_ENV_SETTINGS_MODE=merge|overwrite`
- Optional: `COWORK_LLM_PROVIDER=openai|anthropic|gemini|...`

Example (OpenAI):

```bash
export COWORK_IMPORT_ENV_SETTINGS=1
export COWORK_LLM_PROVIDER=openai
export OPENAI_API_KEY=...
```

Example (search):

```bash
export COWORK_IMPORT_ENV_SETTINGS=1
export TAVILY_API_KEY=...
```

If you rotate keys later, restart with:

```bash
export COWORK_IMPORT_ENV_SETTINGS_MODE=overwrite
```

## Control Plane Overrides

You can override bind host/port at startup:

```bash
export COWORK_CONTROL_PLANE_HOST=127.0.0.1
export COWORK_CONTROL_PLANE_PORT=18789
node bin/coworkd-node.js
```

Keep `host=127.0.0.1` unless you *fully* understand the security implications of binding to `0.0.0.0`.

## Remote Access (SSH Tunnel)

From your local machine:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@your-vps
```

Then connect your client to `ws://127.0.0.1:18789` using the printed token.

If local port `18789` is busy, either:

- Use another fixed local port (`28789`, `38789`, etc.):

```bash
ssh -N -L 28789:127.0.0.1:18789 user@your-vps
```

Use `http://127.0.0.1:28789/` and `ws://127.0.0.1:28789`.

- Or auto-pick a free local port:

```bash
LOCAL_PORT=18789
while lsof -nP -iTCP:${LOCAL_PORT} -sTCP:LISTEN >/dev/null 2>&1; do
  LOCAL_PORT=$((LOCAL_PORT + 1))
done
echo "Using local port: ${LOCAL_PORT}"
echo "Open: http://127.0.0.1:${LOCAL_PORT}/"
ssh -N -L ${LOCAL_PORT}:127.0.0.1:18789 user@your-vps
```

## Web Dashboard (Browser UI)

When the Control Plane server is running, it also serves a minimal web UI at:

- `http://127.0.0.1:18789/` (over SSH tunnel)

Open it in your browser, paste the Control Plane token, and you can:

- Configure LLM provider credentials (LLM Setup)
- List/create workspaces
- Create tasks and send messages
- View task events (recent history + live stream)
- Approve/deny approvals

Also see: `docs/remote-access.md` (SSH + Tailscale Serve/Funnel).

## Approvals Over Control Plane

In headless mode, approval prompts (shell commands, deletions, etc.) can be handled remotely over the Control Plane:

- CoWork broadcasts `approval_requested` events including an `approvalId`
- Respond via `approval.respond` with `{ approvalId, approved }`

This enables running a VPS instance without requiring a local UI or messaging channels for approvals.
