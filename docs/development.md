# Development Guide

## Prerequisites

- Node.js 24+ and npm
- macOS 12 (Monterey) or later
- Xcode Command Line Tools (needed for `better-sqlite3`): `xcode-select --install`
- LLM provider credentials are optional — the app defaults to OpenRouter's free model router

## Build from Source

```bash
# Clone the repository
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS

# Install dependencies
npm install

# Set up native modules for Electron (includes automatic macOS retry handling)
npm run setup

# Build and package the app
npm run build          # compile TypeScript and bundle the UI
npm run package        # package into a macOS .app / .dmg
```

Once complete, the packaged app will be in the `release/` folder:
- **`CoWork OS-<version>-arm64.dmg`** — open this, drag CoWork OS to your Applications folder
- **`mac-arm64/CoWork OS.app`** — the app itself (can also double-click to run directly)

## Development Mode

Run the app with hot reload:

```bash
npm run dev
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Production build |
| `npm run package` | Package into macOS .app / .dmg |
| `npm run setup` | Set up native modules for Electron |
| `npm run fmt` | Format code with Oxfmt |
| `npm run fmt:check` | Check formatting without writing |
| `npm run lint` | Run Oxlint (fast, Rust-based linter) |
| `npm run type-check` | TypeScript validation |

## Project Structure

| Directory | Description |
|-----------|-------------|
| `src/electron/` | Main process (Node.js/Electron) |
| `src/renderer/` | React UI components |
| `src/shared/` | Shared types between main and renderer |
| `resources/skills/` | Built-in skill definitions |
| `connectors/` | Enterprise MCP connector implementations |

## Building Custom Connectors

Use the connector template:

```bash
cp -r connectors/templates/mcp-connector connectors/my-connector
cd connectors/my-connector
npm install
# Edit src/index.ts to implement your tools
npm run build
```

See [Enterprise Connectors](enterprise-connectors.md) for the full connector contract.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **macOS** | 12 (Monterey) | 13+ (Ventura or later) |
| **RAM** | 4 GB | 8 GB+ |
| **CPU** | 2 cores | 4+ cores |
| **Architecture** | Intel (x64) or Apple Silicon (arm64) | Apple Silicon |

### Supported macOS Versions

macOS 12 Monterey, 13 Ventura, 14 Sonoma, 15 Sequoia

### Resource Usage

- **Base memory**: ~300-500 MB (Electron + React UI)
- **Per bot integration**: ~50-100 MB additional
- **Playwright automation**: ~200-500 MB when active
- **CPU**: Mostly idle; spikes during AI API calls

### Running on a macOS VM

| Platform | VM Options |
|----------|------------|
| **Apple Silicon Mac** | UTM, Parallels Desktop, VMware Fusion |
| **Intel Mac** | Parallels Desktop, VMware Fusion, VirtualBox |

Recommended VM specs: 4+ GB RAM, 2+ CPU cores, 40+ GB disk space.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for common build and setup issues.
