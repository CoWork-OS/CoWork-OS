# Point 3 portable integration acceptance — 30 September 2026

## Scope and current status

Acceptance ran in an isolated source checkout on branch `cowork-os/web-preview`. The primary checkout and installed desktop profile were not changed. This report distinguishes manager/RPC acceptance from a real-model integration task. The latest connected-tool completion and focused revocation tests are recorded in [PR readiness evidence](browser-pr-readiness-2026-09-30.md); broader release acceptance remains open.

## Implemented behavior

- Portable preferences use the host's existing settings managers, including provider configuration, guardrails, permissions and built-in tools. Provider revisions exclude derived model catalog caches; actual configuration conflicts remain enforced. Refused durable storage does not publish a successful live change.
- MCP settings and registry actions use closed workspace-scoped requests, current permission checks and real managers. Registry install/update previews present the exact launch plan and require a session-owned, expiring, one-use approval token. Browser consumers use the same adapter consistently. Existing host credentials remain host-side.
- Skill Store URL/Git/registry imports and uninstall use real registries and session-scoped bounded progress. Managed accounts use encrypted records and redacted public DTOs. Gateway CRUD, tests and pairing/user revocation use the existing ChannelGateway.
- Gateway configuration is encrypted with OS protection when available or the initialized protected host repository otherwise. Corrupt or unavailable ciphertext fails closed. Browser channel DTOs omit credentials, local paths and sensitive health error/message identifiers. WhatsApp QR data belongs to the requesting session.
- MCP/gateway/WhatsApp subscriptions poll only while mounted and clean up on unsubscribe or session disposal.

## Accepted evidence

`node scripts/qa/smoke-browser-integrations.mjs` passed on the Node host. `COWORK_WEB_INTEGRATION_SMOKE_DAEMON_ENTRY=bin/coworkd.js node scripts/qa/smoke-browser-integrations.mjs` passed on the freshly compiled Electron host, including the final DTO redaction and safe-field additions. The final root log is `/tmp/cowork-point23-integrations-final-smoke.log`.

Both runs used disposable profiles and real managers. They imported a localhost skill fixture, observed bounded progress, performed synthetic managed-account credential CRUD, saved and updated a disabled gateway channel, inspected runtime-matched encrypted storage and redacted readback, restarted the host, and recovered skill/account/channel state. They sent no external messages and created no provider accounts. The profiles and child processes were cleaned up.

The live Browser QA profile saved its OpenRouter configuration, refreshed models, passed a connection test, and retained configuration after Node and Electron restarts. Actual file tasks and successful follow-ups ran with that provider. The original free-model route was inconsistent and sometimes rate-limited; the successful Electron file workflow used the catalog's GPT-4o-mini option. No credential is included in these artifacts.

The browser MCP screen added and connected the local `qa_echo` fixture, showed its tool metadata and reconnected it after host restart on Node and Electron. Real task tracing exposed a separate tool-count cap that discarded the available tool when built-ins filled the allowance. The cap fix passed 130 focused tests. In the real Electron task `4de54f4d-c861-4338-841b-93ede781d29e`, the browser showed External service → Allow once and the fixture call returned `qa_echo:browser-tool-connected` with `success=true`. Approval prompts were explicitly enabled only for this disposable QA host. A later reporting step incorrectly required a second successful `mcp_qa_echo` call and marked the task Failed, despite its correct plain-text response. End-to-end task acceptance remains open for that contract defect. The fixture was disconnected and disabled via the browser after testing; a subsequent task-denial proof is not claimed.

## Explicit limits

ChatGPT subscription OAuth has adapter/start/cancel/expiry test coverage, but completed login was not demonstrated in this session. Teams creation is unsupported by the existing shared gateway schema/API. Local filesystem settings stay host-only. External provider signup, production channel delivery, all-provider OAuth and packaged release parity are not claimed by the disposable acceptance runs.

## Final PR checkpoint

The reporting-step contract is fixed. A fresh real-provider browser task completed after exactly one approved `mcp_qa_echo` call, followed by a report-only step with zero tool calls. The fixture was then disconnected and disabled. Focused MCP manager tests deny disconnected calls; registry tests exercise token ownership, expiry and replay. This does not claim a real remote connector revocation test or full integration parity.
