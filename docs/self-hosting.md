# Self-Hosting (Linux VPS / Headless)

CoWork OS supports **Linux headless/server deployments**. This is intended for:

- Packaged Linux server releases from GitHub Releases
- VPS installs (systemd)
- Docker installs (single host)
- “No desktop UI required” operation

The key idea: on Linux you typically do **not** run a desktop app UI. Instead you use:

- **Control Plane Web UI** (built-in, served by the daemon)
- **Control Plane CLI** (`bin/coworkctl.js`)
- Optional: messaging channels (Telegram/Discord/Slack/etc) as your “chat UI”

If you need the desktop app UI on macOS or Windows, that’s a separate mode.

## First 10 Minutes (What Users Actually Do)

Typical flow on a new VPS:

1. Install the packaged Linux server release, or use Docker/source when you need that path.
2. Start the Node daemon.
3. SSH tunnel the Control Plane port to your laptop.
4. Open the minimal Control Plane Web UI in your browser.
5. Create a workspace (or bootstrap one at startup).
6. Create a task and watch events.

New headless tasks inherit the configured default [access profile](access-profiles.md), or can
provide `agentConfig.accessProfileId` through the Control Plane. The target daemon enforces the
profile locally; remote clients do not transfer credentials or widen filesystem, command-tool, or
network access. Invalid profiles fail closed and require operator action.

Where the “UI” lives:

- The daemon serves a minimal Web UI at `http://127.0.0.1:18789/` (on the server).
- You view it from your laptop via tunnel/Tailscale (so it still *looks like* `http://127.0.0.1:18789/` locally).

## Choose Your Runtime

Pick one of these. They all run the same underlying agent runtime, DB, and settings:

| Option | Best For | What You Get | What You Don’t |
|---|---|---|---|
| **Packaged server release** (recommended) | Production VPS installs | Prebuilt Linux x64 tarball, Node daemon entrypoint, systemd templates, full resources/connectors, no source build | Linux x64/glibc only in the first release; not a desktop app package |
| **Node-only daemon from source/npm** | VPS/headless | No desktop window or Xvfb, source-build flexibility | Desktop-only features (Live Canvas, visible Browser V2 Workbench, clipboard, desktop screenshots, etc.) |
| **Headless Electron daemon** | Max parity with desktop runtime | More desktop parity | Heavier deps (Electron + Xvfb on Linux) |
| **Docker** (Node-only or Electron) | “Just run it” installs | Easy persistence via volumes | You still access it via Control Plane (web/CLI) |

Docs:

- Linux VPS guide: `docs/vps-linux.md`
- Node-only daemon details: `docs/node-daemon.md`
- Remote access patterns (SSH tunnel/Tailscale): `docs/remote-access.md`
- Secure private MCP access: `docs/secure-mcp-tunnels.md`

## How You Use It (Interfaces)

On a VPS, users typically interact in one of these ways:

1. **Web UI (recommended first touch)**: open `http://127.0.0.1:18789/` through an SSH tunnel or Tailscale.
2. **CLI**: use `bin/coworkctl.js` to create workspaces, create tasks, watch events, and respond to approvals.
3. **Messaging channels**: configure Telegram/Discord/Slack/etc and treat that as the UI.

There is no requirement to have a macOS machine running.

## Packaged Server Release

For production VPS installs, prefer the GitHub release tarball:

- artifact name: `cowork-os-server-linux-x64-v<version>.tar.gz`
- checksum: `cowork-os-server-linux-x64-v<version>.tar.gz.sha256`
- target: Linux x64 on glibc-based distributions
- runtime: `node bin/coworkd-node.js`
- install layout: extract to `/opt/cowork-os`, set `COWORK_USER_DATA_DIR=/var/lib/cowork-os`, and use `deploy/systemd/cowork-os-node.service`

The tarball includes built daemon output, the full `resources/` tree, bundled connector runtimes, systemd templates, and runtime `node_modules`. It does not launch the desktop UI and does not require Xvfb. Keep Node.js 24 installed on the server.

## Headless-Friendly Channels

These are generally easiest on a VPS:

- Telegram, Discord, Slack, Teams, Google Chat, Mattermost, Matrix, Twitch, LINE, Email

Channels that typically require a macOS relay or a “pairing UI”:

- iMessage (macOS only)
- BlueBubbles (macOS relay)
- WhatsApp often requires QR pairing flows that are easiest from the desktop app (headless support depends on how you plan to complete QR pairing)

## Feature Reality Check (Linux Headless)

Works well:

- Task execution engine + tool runtime (file ops, web fetch, integrations, MCP)
- Control Plane (WebSocket API + minimal Web UI)
- Secure MCP Tunnel relay for outbound-only private MCP access, when run with an admin token and a private/TLS deployment
- Cron scheduling + channel delivery (optional)
- Messaging channels (Telegram/Discord/Slack/etc) if configured

Expected limitations:

- Desktop UI features are not available in Node-only mode (Live Canvas, visible Browser V2 Workbench, visual annotator UI, clipboard integration, “open in Finder”, etc.). Browser tools can still use Playwright-local fallback when installed and explicitly needed.
- Some channels are inherently macOS-tied:
  - iMessage requires Apple Messages / macOS
  - BlueBubbles requires a macOS relay

## Browser Automation (Playwright) on VPS

CoWork OS includes Playwright-based browser automation tools.

On minimal Linux images (and slim Docker images), Chromium may fail to launch until dependencies are installed.

- Current approach: install Playwright Chromium + OS deps (see `docs/vps-linux.md`).
- Next step (planned): add an optional “Playwright-ready” Docker profile/image so browser automation works out-of-the-box.

## Security Defaults (Important)

- Control Plane binds to **loopback** by default (`127.0.0.1:18789`).
- Remote access should be done via:
  - SSH tunnel (simplest)
  - Tailscale Serve/Funnel (if you want private/public exposure)

Headless/managed deployments fail closed on direct public Control Plane binds. `0.0.0.0`/`::` is blocked unless Tailscale is enabled, the daemon is running inside a privately published container with `COWORK_CONTROL_PLANE_BIND_CONTEXT=container`, or you set the explicit break-glass `COWORK_CONTROL_PLANE_ALLOW_INSECURE_PUBLIC_BIND=1`.

For reverse proxies, keep the daemon bound to loopback/private networking where possible. Set `COWORK_CONTROL_PLANE_ALLOWED_ORIGINS` to the public HTTPS origin for browser WebSocket access, and only set `COWORK_CONTROL_PLANE_TRUST_PROXY=1` when the proxy controls forwarded headers.

## Data & Backups

All persistent state lives under the **user data directory** (DB + encrypted settings + cron store + message history):

- Configure with `COWORK_USER_DATA_DIR=/var/lib/cowork-os` (recommended on VPS)
- Or `--user-data-dir /var/lib/cowork-os`

Back up that directory (or the Docker volume) to back up the instance.

## Timezone (Docker & Systemd)

To pin the daemon to a specific IANA timezone (e.g. for cron, timestamps, scheduling):

- Set `COWORK_TZ` in the environment (e.g. `COWORK_TZ=America/New_York`, `COWORK_TZ=Europe/London`).
- **Docker:** In `docker-compose.yml`, add `COWORK_TZ=America/New_York` under `environment`. The entrypoint sets `TZ` from `COWORK_TZ` before starting.
- **Systemd:** In `/etc/cowork-os.env` (or your env file), add `COWORK_TZ=America/New_York`. The daemon applies it at startup.
- Invalid IANA timezone values fall back to UTC with a warning.

## Common Questions (FAQ)

**Do I need a macOS machine at all?**  
No. Linux headless mode is designed to be fully usable by itself via Control Plane (web/CLI) and optionally messaging channels.

**Is there a GUI?**  
You get a minimal **Web UI** (served by the daemon) plus a CLI. The full desktop UI is available on macOS and Windows.

**How do I run my first task?**  
Create a workspace (bootstrap or `workspace.create`), then `task.create`, then watch `task.event` (Web UI or `coworkctl`).

**Where are credentials stored?**  
In the encrypted settings store under the user data directory (see above). In headless mode you can set credentials via Control Plane (`llm.configure` / Web UI LLM Setup) or import from env vars at boot (`COWORK_IMPORT_ENV_SETTINGS=1`).

**How do approvals work without a desktop UI?**  
Approvals are visible and actionable over the Control Plane (Web UI + `approval.list` /
`approval.respond`). They operate within the task's access profile; an approval cannot widen a
finite profile scope or repair an unavailable profile. See [Remote Access](remote-access.md) and
[Access Profiles](access-profiles.md).

**Can I expose Control Plane to the public internet?**  
Not recommended. Prefer SSH tunnel or Tailscale. Headless/managed startup blocks direct public binds unless Tailscale, private container context, or `COWORK_CONTROL_PLANE_ALLOW_INSECURE_PUBLIC_BIND=1` is configured. If you must reverse proxy it, set `COWORK_CONTROL_PLANE_ALLOWED_ORIGINS` to the public HTTPS origin and treat it like a high-value admin API.
