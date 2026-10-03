# Browser and runtime security fixes — 2026-10-02

All nine findings from scan `a8cfb79b-8ff9-492c-b9ef-608a91d23449` were fixed
and verified locally: four medium-severity findings and five low-severity
findings. Two additional leads were addressed as hardening changes. The changes
are **Unreleased**, uncommitted, and not deployed. This document records the
issues, implementation, compatibility changes, and limits of verification.

The remediation verification used a working tree based on commit
`2eed0eedbb88ee66c3896c306201dc60a8ed0eca`, with package version `0.5.54` and Node
`24.14.1`. Unrelated local work was preserved. The package version does not
establish an affected published release range. Introduction dates, affected
release ranges, and the first fixed release were not verified.

The [earlier October 2 record](security-fixes-2026-10-02.md) covers five preceding
fixes; the [September 30 record](security-fixes-2026-09-30.md) covers another six.
Those records remain separate from this scan. Operational policy is described
in the [security guide](security-guide.md).

## Findings, fixes, and compatibility

### 1. Code execution bypassed administrator network restrictions — Medium

Finding: `csf_3ed7874156db28e99bab080a`.

**Issue and prerequisites.** A caller authorized to use `execute_code` could
request `allow_network: true` under workspace permissions while administrator
network restrictions were omitted from that decision. An arbitrary subprocess
cannot enforce hostname allowlists through a coarse network-enabled sandbox.
Unsandboxed execution was a related route that could not enforce network denial.

**Fix.** A shared subprocess policy permits network access only when the task
explicitly permits networking, networking is not disabled, there are no task
domain rules, and the administrator permits shell networking with a default
allow policy and no domain lists. `allow_network` must be a boolean. Code
execution and shell direct/fallback paths refuse network restrictions their
backend cannot enforce. Network denial requires a sandbox that can enforce it;
the existing filesystem and approval requirements still apply.

**Compatibility and coverage.** Offline sandboxed execution remains supported.
Environments without a usable OS sandbox cannot use direct or approved fallback
to run a network-denied subprocess. Tests cover Python, JavaScript, shell,
administrator restrictions, task restrictions, absent/false networking,
nonboolean input, and explicit unrestricted controls. No administrator settings
were broadened to make the tests pass.

**Implementation:** [shared policy](../src/electron/security/subprocess-network-policy.ts),
[code execution](../src/electron/agent/tools/code-exec-tools.ts),
[shell execution](../src/electron/agent/tools/shell-tools.ts).
**Regression coverage:** [policy tests](../src/electron/security/__tests__/subprocess-network-policy.test.ts),
[code tests](../src/electron/agent/tools/__tests__/code-exec-tools.test.ts),
[shell tests](../tests/tools/shell-tools.test.ts).

### 2. Visible pages loaded before browser guards existed — Medium

Finding: `csf_b4eae13785852aaef99037de`.

**Issue and prerequisites.** A visible browser guest could load a remote `src`
before lazy tool initialization installed request guards. A page's early requests
could therefore precede its task policy. Legacy content reads also bypassed the
current-page policy check.

**Fix.** Browser guests bootstrap at `about:blank`. The main process prepares
session interception before guest attachment, derives the effective policy from
the persisted task and workspace, and awaits transport installation during
registration. Unregistered requests and missing network policy deny remote
traffic, including requests without an attributable guest. Policy is retained
across unregister/re-registration. Legacy content access and navigation use
the guarded service boundary.

**Compatibility and coverage.** Exact registered local-preview capabilities and
workspace cookie sharing remain available. Tests cover pre-registration worker
requests, asynchronous registration timing, denied legacy content reads, and
disabled policy after re-registration. A hidden native Electron window also
refused remote navigation under disabled networking.

**Implementation:** [renderer bootstrap](../src/renderer/components/BrowserWorkbenchView.tsx),
[guest attachment](../src/electron/main.ts),
[session guards](../src/electron/browser/browser-session-manager.ts),
[workbench service](../src/electron/browser/browser-workbench-service.ts).
**Regression coverage:** [browser guard tests](../src/electron/browser/__tests__/browser-network-guards.test.ts).

### 3. Browser WebSockets bypassed domain restrictions — Medium

Finding: `csf_8d4736ce85b804203973a67e`.

**Issue and prerequisites.** A page able to execute script could open a
WebSocket outside interception limited to HTTP(S). A policy-approved page did
not make its socket destination policy-approved.

**Fix.** Electron visible-browser and Canvas guards explicitly block `ws:` and
`wss:`. Playwright contexts install a WebSocket close route before page creation,
block service workers, and refuse contexts with existing workers. External CDP
attachment is refused because pre-existing sockets and workers cannot be
retroactively contained by these routes. A failed attachment preserves the
managed browser session.

**Compatibility and coverage.** WebSockets are unavailable even for otherwise
allowed domains. Integrations requiring external CDP attachment are also
unavailable; managed browsers and dedicated profiles remain supported. Tests
cover both socket schemes and failed-attachment preservation. In a live Electron
test, a direct positive control established that the local upgrade server was
listening; the guarded page then produced **zero socket upgrade hits**.

**Implementation:** [browser service](../src/electron/agent/browser/browser-service.ts),
[session guards](../src/electron/browser/browser-session-manager.ts),
[Canvas policy](../src/electron/canvas/canvas-network-policy.ts),
[browser tools](../src/electron/agent/tools/browser-tools.ts).
**Regression coverage:** [Canvas tests](../src/electron/canvas/__tests__/canvas-network-policy.test.ts),
[browser service tests](../tests/electron/browser-service.test.ts),
[browser tool tests](../src/electron/agent/tools/__tests__/browser-tools.test.ts).

### 4. Running MCP tunnels retained revoked authority — Medium

Finding: `csf_d3976e2ea55d0cc2bfe9422b`.

**Issue and prerequisites.** Updating a running tunnel's permissions could leave
its existing client and forwarder using the old configuration. Reprovisioning a
relay record with the same ID also left its prior client session connected.
Administrative restriction changes could therefore fail to revoke old authority.

**Fix.** Start, stop, and update operations are serialized per tunnel. The old
connection stops before new configuration is persisted and restarted; IPC awaits
the update. An intentionally stopped client ignores subsequent messages and is
forcibly terminated if graceful closure does not finish. Relay reprovisioning
terminates the previous client and rejects its pending calls.

**Compatibility and coverage.** Already-authorized operations are not
retroactively rolled back. A failed restart remains stopped. Tests verify
stop-before-persist ordering, concurrent enable/disable updates without orphan
clients, real relay disconnection on reprovisioning, and ordinary MCP forwarding,
audit events, and heartbeat messages.

**Implementation:** [supervisor](../src/electron/tunnels/TunnelSupervisor.ts),
[client](../src/electron/tunnels/TunnelClient.ts),
[relay](../src/electron/tunnels/relay.ts),
[IPC](../src/electron/ipc/handlers.ts).
**Regression coverage:** [lifecycle tests](../src/electron/tunnels/__tests__/supervisor-policy-update.test.ts),
[relay tests](../src/electron/tunnels/__tests__/relay.test.ts).

### 5. Browser DNS validation did not bind the actual connection — Low

Finding: `csf_75639dc0f5b154a022e6f25f`.

**Issue and prerequisites.** An attacker controlling DNS for a permitted hostname
could supply a public address during validation and a private address during
Chromium's separate connection lookup. Native redirects and sockets were
additional paths requiring enforcement at the connection boundary.

**Fix.** A local proxy checks destinations and pins HTTP and HTTPS CONNECT sockets
to validated literal addresses. Chromium redirects also traverse that proxy;
loopback bypass, QUIC, HTTP/2, and non-proxied WebRTC UDP are disabled for managed
launches. CONNECT retains native browser TLS and SNI. Canvas HTTP uses strict
pinned fetch, and WebSockets are blocked. Environment-proxy fallback is refused
when strict pinning cannot be guaranteed. Explicit administrator internal-host
exceptions remain scoped and supported.

**Compatibility and coverage.** Native cookies, POST bodies, permitted redirects,
and TLS remain available. A shared cookie partition requires **every active
owner's** policy to permit a destination, so a restrictive owner can block another
owner's requests. Plain HTTP proxy uploads are capped at **5 MiB**, decoded
responses at **50 MiB**, and requests at **30 seconds**. CONNECT traffic has a
**30-second idle timeout**; its encrypted payload is not subject to the plain
HTTP body caps. Tests cover mixed/public-private DNS answers, encoded internal
addresses, administrator exceptions, and environment-proxy refusal. Real Chromium
preserved a permitted redirect and refused a denied redirect with zero target
hits. Real CONNECT used one validated address; a later internal DNS answer was
refused.

**Implementation:** [connection proxy](../src/electron/security/browser-network-proxy.ts),
[pinned transport](../src/electron/security/pinned-fetch.ts),
[browser service](../src/electron/agent/browser/browser-service.ts),
[visible sessions](../src/electron/browser/browser-session-manager.ts).
**Regression coverage:** [proxy tests](../src/electron/security/__tests__/browser-network-proxy.test.ts),
[pinned-fetch tests](../src/electron/security/__tests__/pinned-fetch.test.ts).

### 6. Compressed document parts inflated without adequate bounds — Low

Finding: `csf_4ea2a0c10a4d3a9b377fe8ed`.

**Issue and prerequisites.** Opening a crafted DOCX, ODT, or PPTX could inflate
ZIP parts before expanded-size limits were enforced, consuming excessive host
memory during parsing or preview. XLSX consumers shared the same archive risk.

**Fix.** The shared archive boundary limits input to **50 MiB**, actual directory
entries to **2,048**, each expanded part to **16 MiB**, cumulative expansion to
**64 MiB**, and expansion time to **10 seconds**. Central-directory preflight
precedes JSZip's entry map; streamed expansion counts actual bytes rather than
trusting declared sizes. Unsupported layouts, including ZIP64 and multi-disk
archives, are rejected. Parsing, preview, mailbox, document-block, spreadsheet,
and writer paths validate the same input buffer before consumer use. Writers do
not silently replace an invalid existing document with a fresh document.

**Compatibility and coverage.** Large parts and unsupported ZIP layouts now
fail explicitly. Ordinary document previews, editing, and spreadsheets passed.
Tests reject actual per-part and aggregate expansion, forged sizes/counts, and
excessive entries. These archive budgets do not establish a comprehensive CPU
limit for every downstream parser.

**Implementation:** [archive boundary](../src/electron/security/document-archive.ts),
[analysis pipeline](../src/electron/agent/document-analysis-pipeline.ts),
[document parsing](../src/electron/agent/tools/document-parser-tools.ts),
[document preview](../src/electron/utils/document-preview.ts),
[document writer](../src/electron/utils/document-writer.ts),
[spreadsheet preview](../src/electron/utils/spreadsheet-preview.ts).
**Regression coverage:** [archive tests](../src/electron/security/__tests__/document-archive.test.ts),
[preview tests](../src/electron/utils/__tests__/document-preview.test.ts),
[writer tests](../src/electron/utils/__tests__/document-writer.test.ts),
[spreadsheet tests](../src/electron/utils/__tests__/spreadsheet-preview.test.ts).

### 7. A small PPTX table could allocate enormous arrays — Low

Finding: `csf_7d8a7f5f6e2ff1270cb580b0`.

**Issue and prerequisites.** A crafted table span caused synchronous array
expansion based on an unbounded numeric value. A small slide could therefore
cause disproportionate host memory allocation.

**Fix.** Parsed spans must be safe positive integers no larger than **256**.
Table expansion checks **2,048 source rows**, **256 columns**, and **65,536
expanded cells**, including final rectangular padding, before allocation.

**Compatibility and coverage.** Oversized or invalid tables are rejected.
Billion-sized, exponent-form, and unsafe-integer inputs fail; ordinary text and
merged-table extraction remain supported.

**Implementation:** [PPTX extractor](../src/electron/utils/pptx-extractor.ts).
**Regression coverage:** [PPTX tests](../tests/electron/pptx-extractor.test.ts).

### 8. Cron webhooks retained oversized input before authentication — Low

Finding: `csf_75e0842e039e86ba54c28c87`.

**Issue and prerequisites.** When the optional cron webhook server was enabled
and reachable, unauthenticated input was buffered before credential checking.
The nominal size cap did not stop further accumulation. This was a resource
consumption path, not proof of unauthorized job execution.

**Fix.** Header authentication precedes body reading. The incremental shared
reader stops retaining bytes beyond **1 MiB**; authenticated oversized input
receives HTTP **413**. JSON must be an object, job identifiers must be strings,
and `force`, when present, must be a boolean.

**Compatibility and coverage.** A secret in the JSON body does not authorize a
request. Missing configured credentials retain the fail-closed HTTP **503**
behavior. Tests received HTTP **401** while an unauthenticated stream remained
open, HTTP **413** for authenticated chunked overflow, HTTP **400** for scalar
JSON, and HTTP **200** with exactly one trigger for a valid fictional job.

**Implementation:** [cron webhook](../src/electron/cron/webhook.ts).
**Regression coverage:** [webhook tests](../src/electron/cron/__tests__/webhook-limits.test.ts).

### 9. Authenticated JSON null could crash the standalone relay — Low

Finding: `csf_a32ac12b90c6e920faf8c053`.

**Issue and prerequisites.** A client with valid tunnel credentials could send
valid JSON `null`, which was dereferenced outside an exception boundary and
could terminate the standalone relay process.

**Fix.** Object-shape checks and a per-client exception boundary close the
offending socket with code **1008**. Frames are capped at **25 MiB plus a 16 KiB
envelope**; MCP response payloads also respect the current session's
`maxResponseBytes` policy. Responses and error shapes are validated while
legitimate hello, audit, and pong messages remain accepted.

**Compatibility and coverage.** Malformed client traffic disconnects that client.
Tests send null, arrays, and invalid response shapes, then confirm that relay
provisioning remains available. Ordinary forwarding, audit, and heartbeat controls
passed. The finding required a valid client token; broader unauthenticated impact
was not demonstrated.

**Implementation:** [relay](../src/electron/tunnels/relay.ts).
**Regression coverage:** [relay tests](../src/electron/tunnels/__tests__/relay.test.ts).

## Additional hardening

These two leads were not validated as exploitable vulnerabilities and are not
included in the nine-finding count.

**Repository Git hooks.** Browser Git operations sanitize inherited Git
configuration environment variables and set `core.fsmonitor=false` for read and
mutation operations. A real repository test confirmed that status/diff did not
create the configured hook's marker while ordinary diff output remained intact.
The earlier lead did not establish attacker control of the relevant repository
configuration. See [implementation](../src/host/services/browser-git-methods.ts)
and [tests](../src/host/services/__tests__/browser-git-methods.test.ts).

**Updater quit behavior.** The updater sets `autoInstallOnAppQuit=false` before
downloading. Installation remains an explicit Install & Restart action after
verification. Tests retain the disabled setting after artifact verification
failure and confirm no installation call. The embedded signing-key configuration
was not changed; a bypass involving an actual published signed artifact was not
demonstrated. See [implementation](../src/electron/updater/update-manager.ts)
and [tests](../src/electron/updater/__tests__/update-manager-platform.test.ts).

## Recorded verification

The remediation run passed **223 tests in 30 files**. The original trigger
classes and alternate malicious inputs no longer reproduced at the tested
boundaries. Legitimate controls covered browser cookies, POST bodies and
redirects, document/spreadsheet previews and writes, merged tables, Git diff,
offline sandboxed code, and MCP forwarding/audit/heartbeats.

A live hidden Electron window returned the fictional title `TEST DATA POST`,
retained both test cookies, reported zero WebSocket upgrade hits, and refused
disabled remote navigation with `ERR_BLOCKED_BY_CLIENT`. Chromium and CONNECT
tests used controlled local servers; no external victim or production service
was exercised.

The recorded quality checks passed: `npm run type-check`, `npm run build:electron`,
`npm run build:daemon`, `npm run build:cli`, scoped Oxfmt checks on 46 source/test
files, and `git diff --check`. Focused Oxlint reported zero warnings/errors.
Full `npm run lint` exited successfully with **439 existing warnings and zero
errors**.

The scoped security harness exited successfully and registered
`standard-a8cfb79b-20261002` in the
[security regression corpus](../scripts/qa/eval-cases/security-harness-regressions.json).
Its report contained **60 unverified heuristic candidates**, including the known
regex `.exec()` classifier behavior. It did not use `--fail-on-findings`; its exit
status is not a clean-scan result. `npm run qa:eval:enforce-regressions` reported
the expected local skip because the run was not a `pull_request` event.

### Reproduce the focused suite

Run from the repository root with Node.js 24 or newer. This is the exact final
focused test command from the remediation run; documentation edits did not rerun
the implementation suite.

```sh
npx vitest run \
  src/electron/security/__tests__/pinned-fetch.test.ts \
  src/electron/security/__tests__/browser-network-proxy.test.ts \
  src/electron/security/__tests__/document-archive.test.ts \
  src/electron/security/__tests__/subprocess-network-policy.test.ts \
  src/electron/browser/__tests__/browser-network-guards.test.ts \
  src/electron/cron/__tests__/webhook-limits.test.ts \
  src/electron/tunnels/__tests__/relay.test.ts \
  src/electron/tunnels/__tests__/supervisor-policy-update.test.ts \
  src/electron/tunnels/__tests__/McpTunnelForwarder.test.ts \
  src/electron/tunnels/__tests__/protocol.test.ts \
  src/electron/updater/__tests__/update-manager-platform.test.ts \
  src/electron/agent/tools/__tests__/code-exec-tools.test.ts \
  src/electron/canvas/__tests__/canvas-network-policy.test.ts \
  src/host/services/__tests__/browser-git-methods.test.ts \
  tests/electron/pptx-extractor.test.ts \
  tests/tools/shell-tools.test.ts \
  src/electron/utils/__tests__/document-preview.test.ts \
  src/electron/utils/__tests__/document-writer.test.ts \
  src/electron/documents/__tests__/docx-blocks.test.ts \
  src/electron/utils/__tests__/spreadsheet-preview.test.ts \
  src/electron/agent/tools/__tests__/document-parser-tools.test.ts \
  src/electron/agent/__tests__/document-analysis-pipeline.test.ts \
  src/electron/agent/skills/__tests__/spreadsheet.test.ts \
  tests/electron/browser-service.test.ts \
  src/electron/agent/tools/__tests__/browser-tools.test.ts \
  src/electron/security/__tests__/network-policy.test.ts \
  src/electron/security/__tests__/network-policy-internal-hosts.test.ts \
  src/electron/updater/__tests__/update-manager-release-check.test.ts \
  src/renderer/components/__tests__/browser-workbench-navigation.test.ts \
  src/renderer/components/__tests__/browser-workbench-styles.test.ts
```

### Verification limits and delivery status

No full repository rescan, full test suite, packaged-release validation,
Windows/Linux desktop acceptance, production deployment, or real signed-in
provider acceptance was performed. External CDP support was deliberately refused
and was not accepted as a supported workflow. The local fixes and positive
controls do not establish exhaustive repository security or published-release
protection. No secrets or permission configuration were broadened. Release and
platform acceptance remain separate delivery gates.
