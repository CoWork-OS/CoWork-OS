# Development Guide

## Prerequisites

- Node.js 24+ and npm
- macOS 12 (Monterey)+ or Windows 10/11
- `sqlite3` CLI (required for eval corpus/replay scripts)
- macOS: Xcode Command Line Tools (needed for `better-sqlite3`): `xcode-select --install`
- Windows: Visual Studio Build Tools 2022 (C++) and Python 3 (needed for native module builds)
- LLM provider credentials are optional — the app defaults to OpenRouter's free model router

## Build from Source

```bash
# Clone the repository
git clone https://github.com/CoWork-OS/CoWork-OS.git
cd CoWork-OS

# Install dependencies
npm install

# Set up native modules for Electron (includes macOS retry and Windows ARM64 fallback handling)
npm run setup

# Build and package the app
npm run build          # compile TypeScript and bundle the UI
npm run package        # package desktop installers (.dmg on macOS, .exe on Windows)
```

Once complete, the packaged app will be in the `release/` folder:
- **`*.dmg`** — macOS installer image
- **`*.exe`** — Windows NSIS installer
- **`mac-*/CoWork OS.app`** — unpacked macOS app bundle
- **`win-*/`** — unpacked Windows app directory

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
| `npm run package` | Package desktop installers (`.dmg` on macOS, `.exe` on Windows) |
| `npm run setup` | Set up native modules for Electron |
| `npm run fmt` | Format code with Oxfmt |
| `npm run fmt:check` | Check formatting without writing |
| `npm run lint` | Run Oxlint (fast, Rust-based linter) |
| `npm run type-check` | TypeScript validation |
| `npm run qa:eval:build` | Build regression eval corpus from failed/partial tasks |
| `npm run qa:eval:run` | Replay eval suite (deterministic or hooks mode) |
| `npm run qa:eval:enforce-regressions` | Enforce production-fix -> eval-case policy |
| `npm run qa:reliability` | Reliability loop (`qa:eval:run` + battery script) |
| `npm run skills:validate-routing` | Validate skill routing metadata |
| `npm run skills:validate-content` | Validate skill prompt content, placeholders, and references |
| `npm run skills:audit` | Generate skill audit scorecards in `tmp/qa/` |
| `npm run skills:check` | Run full skill quality gate (routing + content + audit + eval) |

## Reliability Workflow (Local)

```bash
# Build/refresh local regression corpus
npm run qa:eval:build -- --window-days 30 --limit 300 --suite reliability-regressions

# Deterministic suite replay
npm run qa:eval:run -- --suite reliability-regressions --mode deterministic

# Optional: run against a custom DB path
COWORK_DB_PATH=/tmp/cowork-eval.db npm run qa:eval:run -- --suite reliability-regressions --mode deterministic

# Validate production-fix regression policy (mainly used by PR CI)
npm run qa:eval:enforce-regressions
```

See also:
- [Reliability Flywheel](reliability-flywheel.md)

## Skills QA Workflow

Run these checks when editing bundled skills:

```bash
npm run skills:validate-routing
npm run skills:validate-content
npm run skills:audit
npm run skills:check
```

Notes:
- `skills:check` is phase-driven (`SKILLS_CHECK_PHASE=1|2|3`).
- Phase 2+ enables path enforcement for `{baseDir}` references.
- Phase 3 enables strict warning enforcement.

## Focused Test Suites

For completion/output UX changes, run the focused suites:

```bash
npx vitest run \
  src/renderer/utils/__tests__/task-outputs.test.ts \
  src/renderer/utils/__tests__/task-completion-ux.test.ts \
  src/renderer/utils/__tests__/task-event-visibility.test.ts \
  src/electron/agent/__tests__/daemon-complete-task.test.ts \
  src/electron/control-plane/__tests__/task-event-bridge-contract.test.ts \
  src/renderer/__tests__/task-event-status-map.test.ts
```

When unit-testing `TaskExecutor` completion paths, mock `daemon.getTaskEvents()` in harnesses.
`finalizeTask()` always reads task events to build output summaries.

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
| **Desktop OS** | macOS 12 / Windows 10 | macOS 13+ / Windows 11 |
| **RAM** | 4 GB | 8 GB+ |
| **CPU** | 2 cores | 4+ cores |
| **Architecture** | x64 or arm64 | Native architecture of your host |

### Supported Desktop OS Versions

- macOS 12 Monterey, 13 Ventura, 14 Sonoma, 15 Sequoia
- Windows 10 and Windows 11 (x64 and ARM64)

### Resource Usage

- **Base memory**: ~300-500 MB (Electron + React UI)
- **Per bot integration**: ~50-100 MB additional
- **Playwright automation**: ~200-500 MB when active
- **CPU**: Mostly idle; spikes during AI API calls

### Running in a VM

| Host Platform | VM Options |
|----------|------------|
| **Apple Silicon Mac** | UTM, Parallels Desktop, VMware Fusion |
| **Intel Mac** | Parallels Desktop, VMware Fusion, VirtualBox |
| **Windows** | Hyper-V, VMware Workstation, VirtualBox |

Recommended VM specs: 4+ GB RAM, 2+ CPU cores, 40+ GB disk space.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for common build and setup issues.
