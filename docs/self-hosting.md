# Self-Hosting (Linux VPS / Headless)

CoWork OS supports **Linux headless/server deployments**. This is intended for:

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

1. Start the daemon (Node-only recommended).
2. SSH tunnel the Control Plane port to your laptop.
3. Open the minimal Control Plane Web UI in your browser.
4. Create a workspace (or bootstrap one at startup).
5. Create a task and watch events.

Where the “UI” lives:

- The daemon serves a minimal Web UI at `http://127.0.0.1:18789/` (on the server).
- You view it from your laptop via tunnel/Tailscale (so it still *looks like* `http://127.0.0.1:18789/` locally).

## Choose Your Runtime

Pick one of these. They all run the same underlying agent runtime, DB, and settings:

| Option | Best For | What You Get | What You Don’t |
|---|---|---|---|
| **Node-only daemon** (recommended) | VPS/headless | No GUI deps, simplest ops | Desktop-only features (Live Canvas, clipboard, desktop screenshots, etc.) |
| **Headless Electron daemon** | Max parity with desktop runtime | More desktop parity | Heavier deps (Electron + Xvfb on Linux) |
| **Docker** (Node-only or Electron) | “Just run it” installs | Easy persistence via volumes | You still access it via Control Plane (web/CLI) |

Docs:

- Linux VPS guide: `docs/vps-linux.md`
- Node-only daemon details: `docs/node-daemon.md`
- Remote access patterns (SSH tunnel/Tailscale): `docs/remote-access.md`

## How You Use It (Interfaces)

On a VPS, users typically interact in one of these ways:

1. **Web UI (recommended first touch)**: open `http://127.0.0.1:18789/` through an SSH tunnel or Tailscale.
2. **CLI**: use `bin/coworkctl.js` to create workspaces, create tasks, watch events, and respond to approvals.
3. **Messaging channels**: configure Telegram/Discord/Slack/etc and treat that as the UI.

There is no requirement to have a macOS machine running.

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
- Cron scheduling + channel delivery (optional)
- Messaging channels (Telegram/Discord/Slack/etc) if configured

Expected limitations:

- Desktop UI features are not available in Node-only mode (Live Canvas, visual annotator UI, clipboard integration, “open in Finder”, etc.)
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

Avoid binding the Control Plane directly to `0.0.0.0` unless you fully understand the risk and have network-level protections.

## Data & Backups

All persistent state lives under the **user data directory** (DB + encrypted settings + cron store + message history):

- Configure with `COWORK_USER_DATA_DIR=/var/lib/cowork-os` (recommended on VPS)
- Or `--user-data-dir /var/lib/cowork-os`

Back up that directory (or the Docker volume) to back up the instance.

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
Approvals are visible and actionable over the Control Plane (Web UI + `approval.list` / `approval.respond`).

**Can I expose Control Plane to the public internet?**  
Not recommended. Prefer SSH tunnel or Tailscale. If you must, treat it like a high-value admin API and put it behind strong network controls.
