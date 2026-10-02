# Security fixes — 2026-09-30

These six fixes are implemented in the working tree and are recorded under
**Unreleased**. They have not been published as a release. The remediation started
from commit `cceb509ac0c0a083ba0a8e7d75a6b7eddabb2871` and was checked against the
current implementations, including callers, interactive previews, and restored
session behavior.

The [October 2 follow-up](security-fixes-2026-10-02.md) records five additional
fixes. It supersedes the read-only tunnel tool-name filtering described below:
the current implementation blocks all tool calls when read-only mode is enabled.

## Changes and compatibility

| Boundary | Previous behavior | Fixed behavior | Compatibility |
| --- | --- | --- | --- |
| Live Canvas networking and ownership (CWE-863) | Agent-authored HTML and JavaScript could open connections outside task network controls. Interactive webviews used a separate, unguarded session; foreign task session IDs could inherit another task's network access. | Windows and webviews use an isolated session bound to the owning task's live permissions. Requests, resources, and redirects are guarded. Task tools reject foreign task/workspace sessions. Missing owners and closed sessions cannot make remote requests; an unbound Canvas protocol handler cannot serve agent-authored content. | Local HTML, CSS, JavaScript, images, snapshots, and interactive previews remain available. Remote traffic supports HTTP(S); WebSocket and other remote schemes are blocked. Popups cannot create an unguarded window. |
| HTTP DNS validation (CWE-918) | DNS validation and the actual connection used separate lookups, so a changed answer could reach an address that had not been validated. | The socket lookup uses the validated address while preserving the original HTTP Host and HTTPS hostname/certificate verification. Each redirect is checked independently. Internal or mixed public/internal answers, empty results, and resolution failures are refused. | Loopback development servers remain reachable, subject to task policy. Domain rules and protected-credential redirect restrictions still apply. |
| Channel webhook request bodies (CWE-400) | LINE, Teams, Google Chat, Feishu, and WeCom accumulated entire unauthenticated bodies before provider processing. | All five ingress handlers use the shared raw-byte reader, reject overflow with HTTP 413 before provider processing, release retained chunks, and reject interrupted uploads. | The default limit is 1 MiB. Complete raw bytes are decoded after reading, preserving legitimate UTF-8 split across chunks. Existing signature/token verification remains in place. |
| Secure MCP tunnel methods (CWE-862) | Requests without a tool name bypassed tool policy, allowing a remote caller to invoke host shutdown. | Relay and forwarder share an explicit client-method allowlist. Shutdown and unknown methods are denied for both read-only and read/write tunnels; malformed tool calls are rejected. | Supported methods are `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. Tool allowlists and read-only tool-name filtering still apply. |
| HTTP response bodies and deadlines (CWE-400) | Response bodies were fully buffered before output truncation, and the timeout was cleared after headers arrived. | Both HTTP tools consume decoded bytes incrementally, cancel oversized bodies, and keep the deadline active through DNS, connection, and body consumption. Timers are cleaned up on success and failure. | Decoded responses are capped at 5 MiB. `maxLength` continues to control returned text length, not the resource budget. JSON/text/HTML formatting, protected credentials, HEAD, and bodyless statuses remain supported. |
| Imported skill archive inflation (CWE-409) | ClawHub ZIP entries were fully inflated before file and bundle limits were checked; downloads were fully allocated before checking actual size. | Downloads use a bounded stream reader. ZIP entries are read incrementally against the file limit and remaining bundle budget, with expansion paused immediately on overflow. Actual expanded bytes govern the limit even when ZIP metadata claims a smaller size. | Limits remain 5 MiB compressed, 512 KiB per expanded file, 5 MiB total expanded content, and 200 archive entries. Ordinary imports, path normalization, staging, and quarantine remain intact. |

For **Ask for approval** networking, Canvas HTML and scripts cannot silently open a
connection. An approved `canvas_open_url` authorizes its destination origin for
that session. Opening a URL directly through Canvas controls also authorizes that
origin, subject to the task's restrictions. Grants apply only while task
permissions match the state used to authorize the origin and are not persisted
across app restarts. Resources or
redirects to other origins require their own authorization. See
[Live Canvas network access](live-canvas-security.md).

Exporting Canvas HTML and explicitly opening it in an external browser uses that
browser's network settings. The in-app Canvas guard does not govern an external
application.

## Implementation and regression coverage

| Area | Shared enforcement and callers | Regression coverage |
| --- | --- | --- |
| Canvas | `src/electron/canvas/canvas-manager.ts`, `canvas-network-policy.ts`, and `canvas-protocol.ts`; task/visual tools, Canvas IPC, main-process webview attachment, `CanvasPreview`, and `BrowserView` | `canvas-network-policy.test.ts`, `canvas-tools.test.ts`, and `scripts/qa/smoke-canvas-security.cjs` |
| HTTP connections | `src/electron/security/pinned-fetch.ts`; HTTP tools and Canvas HTTP(S) protocol handlers | `pinned-fetch.test.ts` exercises a real local server and a DNS answer that changes after validation; also rejects mixed answers, encoded metadata addresses, and resolution failures |
| Webhooks | `src/electron/gateway/channels/webhook-channel-utils.ts` and the five affected channel handlers | `webhook-body-limits.test.ts` sends oversized bodies through each ingress handler and verifies that provider processing does not run; ordinary chunked input and existing authentication tests remain covered |
| Tunnels | `src/electron/tunnels/protocol.ts`, shared by relay and forwarder | Protocol shutdown/unknown-method/malformed-call regressions, existing relay/forwarder tests, and the secure tunnel smoke test |
| HTTP resource budgets | `src/electron/security/bounded-response.ts` and `src/electron/agent/tools/web-fetch-tools.ts` | Bounded-response and HTTP-tool tests cover dishonest or absent content length, gzip expansion, split UTF-8, cancellation, stalled bodies after headers, formatting, and credentials |
| Skill imports | `src/electron/agent/skill-registry.ts` and the bounded response reader | Registry tests cover a real compressed ZIP bomb, forged small metadata, cumulative expanded overflow, oversized downloads without content length, and ordinary ZIP/JSON/SKILL.md imports |

The Canvas desktop smoke uses hidden windows, an isolated temporary application
profile, and a local HTTP server. It exercises HTML images, inline scripts,
`canvas_eval`, and an interactive webview whose partition is forced by the main
process. It also checks offline rendering and snapshots, approved-origin access,
denied redirects/private DNS answers, missing owners, and unbound protocol access.
Temporary data is removed on completion.

## Recorded validation

The remediation run passed the following checks:

- **271 tests in 16 files**, including the six boundaries and nearby shell,
  browser, network policy, gateway authentication, Canvas, skill import, and
  tunnel behavior.
- Electron Canvas smoke and secure MCP tunnel smoke against the built runtime.
- Electron build, project type-check, syntax check of the desktop smoke,
  formatting on affected TypeScript files, and scoped `git diff --check`.
- Repository lint: **439 warnings, zero errors**; the async SQLite lint step also
  passed.
- Security harness execution and the confirmed-fix regression-corpus update. Its
  output contained **56 heuristic candidates and zero confirmed findings**.
  Candidate matches are review inputs, not proof of vulnerabilities or proof
  that the repository is secure.

### Reproduce the checks

Use the repository's Node.js requirement (24 or newer) and installed dependencies.
The HTTP/tunnel tests need localhost listener access. The Canvas smoke additionally
requires the Electron desktop runtime.

```sh
npx vitest run \
  src/electron/security/__tests__/bounded-response.test.ts \
  src/electron/security/__tests__/pinned-fetch.test.ts \
  src/electron/canvas/__tests__/canvas-network-policy.test.ts \
  src/electron/canvas/__tests__/canvas-checkpoint.test.ts \
  src/electron/agent/tools/__tests__/canvas-tools.test.ts \
  src/electron/agent/tools/__tests__/web-fetch-tools.test.ts \
  src/electron/agent/__tests__/skill-registry.test.ts \
  src/electron/gateway/__tests__/webhook-body-limits.test.ts \
  src/electron/gateway/__tests__/webhook-auth.test.ts \
  src/electron/gateway/__tests__/webhook-channel-utils.test.ts \
  src/electron/tunnels/__tests__/protocol.test.ts \
  src/electron/tunnels/__tests__/relay.test.ts \
  src/electron/tunnels/__tests__/McpTunnelForwarder.test.ts \
  tests/tools/shell-tools.test.ts \
  src/electron/agent/tools/__tests__/browser-tools.test.ts \
  src/electron/security/__tests__/network-policy.test.ts

npm run build:electron
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/qa/smoke-canvas-security.cjs
npm run tunnel-relay:test
npm run type-check
npm run lint
```

The checked-in guard for this remediation is in
`scripts/qa/eval-cases/security-harness-regressions.json`. The harness reports are
local artifacts under `artifacts/security-harness/`; they are separate from the
runtime tests above.

## Scope and remaining limits

This record covers the six identified findings, not a new exhaustive repository
audit. The original single-pass scan fully audited 45 of 3,856 tracked files;
other files were deferred. External provider authentication was checked through
local regressions, not live LINE/Teams/Google Chat/Feishu/WeCom accounts. No
production service or release was changed during remediation.
