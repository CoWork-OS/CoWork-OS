# Uninstall CoWork OS

There are two ways to uninstall CoWork OS depending on whether you want to keep local data.

## Option 1: Uninstall app/binaries only (keep database)

This removes installed application files and CLI/package artifacts while keeping workspace, settings, and task data for later restore.

### macOS app (manual drag-installed build)

```bash
pkill -f '/Applications/CoWork OS.app' || true
rm -rf "/Applications/CoWork OS.app"
```

### npm global package install

```bash
npm uninstall -g cowork-os
```

### Local install in a folder

```bash
rm -rf ~/cowork-run
```

### Source/development clone

```bash
rm -rf /path/to/CoWork-OS
```

### VPS/headless Docker install

```bash
cd /path/to/docker-compose-dir
docker compose down
```

### VPS/headless systemd install

```bash
sudo systemctl stop cowork-os cowork-os-node
sudo systemctl disable cowork-os cowork-os-node
sudo rm -f /etc/systemd/system/cowork-os.service
sudo rm -f /etc/systemd/system/cowork-os-node.service
sudo systemctl daemon-reload
```

### Data locations to keep

Choose the one used by your install:

- macOS (Electron): `~/Library/Application Support/cowork-os/`
- Linux desktop/Electron: `~/.config/cowork-os/`
- Linux daemon/headless fallback: `~/.cowork/`
- Node daemon custom path: value passed in `COWORK_USER_DATA_DIR` or `--user-data-dir`
- Docker/systemd example paths: named volume `cowork_data`, `/var/lib/cowork-os`, and any host bind mount in `/workspace`

## Option 2: Full uninstall + data deletion (database included) — irrecoverable

> **WARNING:** This removes all application data and settings (tasks, tasks timeline, memory, credentials, channel/session state, and the local database). **All data will be deleted and everything will be gone forever.**

Use this only when you are sure you want to destroy local state.

### Delete all user-data locations

```bash
rm -rf ~/Library/Application\ Support/cowork-os
rm -rf ~/.config/cowork-os
rm -rf ~/.cowork
```

### Remove with custom user-data path

```bash
rm -rf "$COWORK_USER_DATA_DIR"
```

### Fully remove Docker install data

```bash
cd /path/to/docker-compose-dir
docker compose down -v
docker compose rm -f
```

### Fully remove systemd/headless example data

```bash
sudo rm -rf /var/lib/cowork-os
```

After the data wipe, also remove remaining app binaries/shell package entries from Option 1 if you haven't already.
