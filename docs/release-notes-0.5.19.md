# Release Notes 0.5.19

This page summarizes the product and engineering changes included in `0.5.19`, following `v0.5.18`.

## Overview

Release `0.5.19` expands production operations with **isolated app profiles** (export/import), **enterprise messaging** (Feishu/Lark and WeCom), a **stronger multichannel gateway** (multiple Slack workspaces per profile, Telegram group routing, Discord guild filtering, aligned Signal and email policies), **ordered LLM and search failover** (including **Exa**), **optional external skill directories**, and **ACP lifecycle and trust hardening** (persisted tasks, remote cancel, scoped access, remote endpoint validation). It also deepens **computer use (macOS)** ergonomics, **Usage Insights** for LLM usage, **MCP host** behavior, and refreshes documentation across README, guides, and security references. The automated suite now reports **over 4,580 passing tests** across **330+ test files** (`npm run test`).

## What changed

### Profiles and portability

- **Isolated profiles**: separate `userData`, database, encrypted settings, channels, skills, and sessions per profile.
- **Export / import**: profile bundles for migration, backups, or parallel environments (`Settings → Profiles`).
- **IPC and wiring**: profile lifecycle integrated with main process and settings UI.

### Multichannel gateway

- **Channel instances**: router and gateway treat each configured channel as a distinct instance (stable `channelId`) so routing, replies, and state stay correct with multiple connections of the same type.
- **Slack**: multiple Slack workspaces in one profile via multiple Slack channel entries.
- **Telegram**: group routing modes and optional allowed group chat IDs.
- **Discord**: optional guild allowlist so the bot ignores other servers.
- **Signal**: consistent DM vs group policies and number allowlists.
- **Email**: sender allowlist uses exact address or domain matching.
- **Feishu / Lark** and **WeCom**: new first-class adapters and settings panels with webhook / encrypted event handling.

### LLM and search

- **Ordered LLM fallback**: configure up to five ordered fallback providers/models; factory and UI align with routing visibility.
- **Exa search**: new provider in **Settings → Web Search**, integrated into search factory ordering, cooldowns, and fallbacks.
- **Usage Insights**: LLM-oriented breakdowns and shared date/provider helpers where applicable.

### Skills

- **External skill directories**: optional absolute read-only folders loaded with precedence `bundled < external < managed < workspace`; managed in **Settings → Skills**; persisted via secure settings.
- **Read-only policy**: bundled and external skills are not editable in-app as managed copies.

### ACP and federated agents

- **Persisted ACP tasks**: `acp_tasks` table and handler load/save for restart-safe task state.
- **Remote invoker**: HTTPS-first remote calls, loopback `http` for local dev, rejection of private/link-local targets (except loopback rules), bounded request timeouts, and **remote task cancel**.
- **Scoped control-plane access**: read/write/admin scopes; non-operator clients limited to their own tasks and inbox reads where enforced.
- **Remote agent registration**: endpoint validation on register.

### Computer use (macOS)

- Session management, permission/risk surfaces, and settings onboarding; see **[Computer use (macOS)](computer-use.md)** for the full guide.

### MCP and automations

- **CoWork MCP host provider** and host server refinements; connector resource subscription behavior documented with **Event Triggers** and MCP notifications.

### Runtime and operator surfaces

- **Runtime visibility** service path consolidated (legacy internal parity helper removed in favor of `RuntimeVisibilityService`).
- **Mission Control** and related UI/CSS/data-hook updates.
- **Heartbeat policy** repository and related agent/heartbeat wiring where applicable.

### Media and security hardening

- **Video tools**: validation for reference image/video paths (absolute, exists, size/type limits).
- **Documentation**: security guide updates for Exa, enterprise channel egress, ACP remote trust, `skills` / `acp` secure-setting categories, and file/media guardrails.

### Testing and quality

- **Test corpus**: `npm run test` — **4,583 tests passed** (68 skipped in default run), **331 test files passed** (8 skipped), including **135** focused security tests under `tests/security/` and a large **control-plane / WebSocket protocol** suite.
- **ACP handler tests**: in-memory DB fake to avoid native `better-sqlite3` ABI drift in Vitest.
- **Gateway and channel tests**: expanded coverage for email, Signal, router task updates, Exa provider, profiles, computer-use helpers, MCP host, and Mission Control components where added.

### Documentation

- README, docs home, getting started, features, channels, providers, architecture, ACP integration, enterprise connectors, security guide, skill store, showcase, GTM, digital twins, and changelog aligned with **17 channels**, profiles, Exa, fallback chains, and ACP hardening.

## Upgrade notes

- After upgrade, open **Settings → Web Search** if you use paid search: set **Exa** and fallback order as needed.
- New enterprise channels require correct callback URLs and tenant credentials in each vendor console.
- Profile export may contain sensitive credentials; treat bundles like backups and store them accordingly.

## References

- [Changelog](changelog.md) — full version history
- [Features](features.md) — feature reference
- [Channels](channels.md) — channel setup
- [Skill Store & External Skills](skill-store-and-external-skills.md) — external directories

This page is the canonical high-level summary for changes in `0.5.19`.
