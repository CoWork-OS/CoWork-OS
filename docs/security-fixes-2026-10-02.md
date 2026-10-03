# Security fixes — 2026-10-02

Five findings from the October 1 security review are fixed in the working tree
and recorded under **Unreleased**: four medium-severity issues and one low-severity
issue. This record describes the source findings, implemented fixes, compatibility
changes, and local verification. No release or production deployment was performed.

The assessed source was a working tree based on commit
`ed64398c5df8c7cd4bfd02e3ff7ef82669f64d7e`, with package version `0.5.54` and
uncommitted changes. That package version does not establish which published
releases contain the vulnerable behavior. Introduction dates, affected release
ranges, and the first fixed release were not verified.

The [September 30 fix record](security-fixes-2026-09-30.md) covers the preceding
six fixes. This follow-up strengthens additional paths in HTTP tools, search,
Pulse, tunnels, and skill imports.

The subsequent [browser and runtime fix record](security-fixes-2026-10-02-browser-runtime.md)
documents nine further findings and two hardening changes from the October 2
scan, with separate compatibility and verification evidence.

## Findings, fixes, and compatibility

### HTTP redirects could disclose caller credentials — Medium

**Issue and prerequisites.** `http_request` accepts caller-supplied headers and
follows redirects by default. Its manual redirect loop checked the network policy
for each destination but retained the request headers. An attacker-controlled
redirect to another permitted origin could therefore receive raw authorization,
cookies, or an arbitrary custom credential header. Permission to contact a domain
does not authorize exporting another origin's credentials to it. Requests using a
protected credential already disabled redirect following; this finding concerned
raw caller-supplied headers. Credential-bearing request bodies were a related
cross-origin export path when the redirect preserved the body.

**Fix.** `fetchWithPolicyCheckedRedirects` compares complete URL origins, including
scheme and port. When the origin changes, it replaces all caller headers with
fixed public request defaults. It applies the redirect's method/body conversion
first, then rejects any cross-origin redirect whose request body would remain.
Destination network checks and protected-credential restrictions still apply.

**Compatibility.** Same-origin authenticated redirects retain caller headers and
preserve bodies when the redirect method requires them. Ordinary public redirects
remain supported. A POST converted to GET by
a 301/302/303 can continue without its body. Callers relying on custom headers at
another origin must issue a separate, explicitly addressed request. Cross-origin
redirects preserving a body are rejected, including PUT through 301/302 and
body-bearing requests through 307/308.

**Coverage.** Regression tests cover arbitrary token headers, authorization,
cookies, HTTPS downgrades, port changes, same-origin credentials, body rejection,
and a body-free POST-to-GET redirect. These use mocked transport; no remote
credential theft was demonstrated.

### A grep pattern could block the application process — Medium

**Issue and prerequisites.** A caller able to invoke the read-only `grep` tool
could supply a JavaScript regular expression that backtracks excessively against
an accessible text file. Matching ran synchronously in the application process
in content, files-only, and count modes. File-size and returned-output limits did
not bound matching time, and a timer on the same blocked event loop could not
interrupt it. Glob matching and combinatorial brace expansion were related
untrusted-input paths.

**Fix.** Content and glob matching run in a terminable worker with a **500 ms
per-job deadline** and a **32 MiB old-generation heap limit**. Timeout and worker
failure return a failed search; worker termination is awaited during cleanup.
Regex patterns are limited to **4,096 characters**. Globs are limited to **1,024
characters** and **128 expanded alternatives**. File selection remains subject
to workspace and project access checks before content is passed to the worker.

**Compatibility.** JavaScript regex syntax, case-insensitive search, match counts,
context lines, and normal glob behavior remain supported. Expensive legitimate
jobs can time out and overly large patterns are rejected. The deadline applies
to each matching job, not to the complete directory traversal.

**Coverage.** Tests exercise catastrophic patterns in all three output modes,
an alternate backtracking pattern, parent-loop responsiveness, worker cleanup,
and subsequent normal searches. Controls cover lookbehind, empty-match counting,
counts/context, existing permission checks, and glob expansion limits. Execution
used isolated Node workers, rather than a live Electron desktop session.

### Pulse checked request size after buffering the body — Medium

**Issue and prerequisites.** The public Pulse request reader checked an optional
`Content-Length`, then buffered the entire body before checking its actual byte
size. A sender omitting or understating the length could cause allocation beyond
the intended **16 KiB** limit before authentication or schema processing. The
impact is collector resource consumption, constrained by hosting ingress limits;
host compromise or production availability loss was not demonstrated.

**Fix.** Shared `readJson` reads byte chunks and cancels as soon as accumulated
input exceeds **16,384 bytes**. It releases the reader and decodes only the bounded
input. Enrollment, daily ingestion, and deletion share this helper. Oversized
requests retain the existing **HTTP 413** response.

**Compatibility.** Valid JSON objects at the byte limit remain accepted, including
Unicode split across chunks. The limit counts bytes rather than characters.
Existing schema validation remains intact.

**Coverage.** Tests cover missing and understated lengths, early cancellation
before consuming later chunks, oversized multibyte input, exact-boundary Unicode,
JSON-object validation, and the 413 response. The collector's existing enrollment
and daily schema tests also passed. No production Worker was tested or deployed.

### Read-only tunnels could invoke mutating connector tools — Medium

**Issue and prerequisites.** An authenticated tunnel caller could reach configured
connector tools despite a read-only policy. The policy used a blacklist of
write-like name tokens, which missed operations such as
`home-assistant.call_service`, `comfyui.submit_workflow`, and
`discord.add_reaction`. Dotted names could also evade token boundaries. Exploiting
this requires a valid caller token, an available target connector, and the
connector's own credentials/configuration. Actual remote connector mutations
were not executed during verification.

**Fix.** The shared relay/forwarder policy now denies **every `tools/call` request
in read-only mode**, including allowlisted, apparently read-like, and unknown
names. Names and remote annotations do not establish that a tool has no side
effects. Protocol discovery, initialization, ping, and resource reads remain
available. Existing lifecycle and unknown-method denials remain in place.

**Compatibility.** Read-only tunnels can no longer expose tool calls. To expose
reviewed tools, operators must configure an explicit `allowedTools` list on a
write-enabled tunnel. An allowlist does not override read-only mode. See
[Secure MCP Tunnels](secure-mcp-tunnels.md) for the current policy behavior.

**Coverage.** Policy tests deny the omitted mutation names, dotted writes,
purported reads, and unknown tools even when allowlisted, while allowing the
same explicitly selected tools in write-enabled mode. Existing protocol,
forwarder, and real loopback relay tests passed.

### Git skill imports could copy files outside the clone — Low

**Issue and prerequisites.** A user importing an attacker-controlled Git skill
could select a manifest or support directory that was a symbolic link outside
the cloned checkout. Discovery and manifest reads followed links before staging
validation. Skipping symlink descendants during copying did not protect a
symlink root: enumeration could expose ordinary files in an external directory.
An attacker would need a suitable local target path. Import size limits and
scanning/quarantine constrain the resulting copy; automatic remote disclosure
or code execution was not demonstrated.

**Fix.** Git checkout contents are checked for symlinks before bundle discovery,
manifest reads, or copying. This covers `SKILL.md`, metadata, JSON manifests,
support roots, and intermediate `skills` directories. The shared staging
validator also rejects a symlink bundle root. The checkout's `.git` internals
are excluded from this content check and are not imported as skill content.

**Compatibility.** Git skill bundles containing symlinks are rejected. Ordinary
direct and nested bundles remain supported, along with existing import limits,
scanning, quarantine, and cleanup behavior.

**Coverage.** Import tests assert that rejection occurs before imported data is
read or copied. Real temporary filesystem fixtures cover external file and
directory links; controls accept ordinary directories and existing direct/nested
Git imports. Existing registry and ClawHub tests also pass. Git cloning itself
was mocked; no external repository was contacted.

## Implementation and regression map

| Area | Implementation | Regression coverage |
| --- | --- | --- |
| Redirects | `src/electron/agent/tools/web-fetch-tools.ts` | `src/electron/agent/tools/__tests__/web-fetch-tools.test.ts` |
| Grep and globs | `src/electron/agent/tools/grep-tools.ts`, `bounded-regex.ts` | `src/electron/agent/tools/__tests__/grep-tools.test.ts`, `bounded-regex.test.ts` |
| Pulse input | `services/pulse-worker/src/index.ts` | `tests/security/pulse-request-body.test.ts`, `services/pulse-worker/src/index.test.ts` |
| Tunnel tool policy | `src/electron/tunnels/protocol.ts`, called by relay and forwarder | `src/electron/tunnels/__tests__/protocol.test.ts`, `McpTunnelForwarder.test.ts`, `relay.test.ts` |
| Git imports | `src/electron/agent/skill-registry.ts` | `src/electron/agent/__tests__/skill-registry.test.ts` |

## Recorded validation

The October 2 remediation run passed:

- **221 tests across 9 files** covering the five boundaries and security harness
  behavior, plus **3 existing Pulse schema tests**: **224 tests in total**.
- Electron, daemon, and CLI TypeScript checks with `--noEmit`, and the root
  `npm run type-check`.
- Scoped Oxlint with zero warnings/errors, scoped Oxfmt checks, and
  `git diff --check`.
- The required confirmed-fix security harness run, updating
  `scripts/qa/eval-cases/security-harness-regressions.json` while preserving prior
  categories.
- An independent source review of the candidate patch, with no concrete bypass
  or regression identified.

The security harness emitted **15 heuristic candidates**, not confirmed
vulnerabilities. For example, its shell rule matches regex `.exec()` calls.
Harness output and a successful exit are separate from runtime exploit proof.

### Reproduce the focused checks

Use Node.js 24 or newer and installed repository dependencies. Relay tests need
permission to bind a temporary localhost listener.

```sh
npx vitest run \
  src/electron/agent/tools/__tests__/web-fetch-tools.test.ts \
  src/electron/agent/tools/__tests__/grep-tools.test.ts \
  src/electron/agent/tools/__tests__/bounded-regex.test.ts \
  src/electron/agent/__tests__/skill-registry.test.ts \
  src/electron/tunnels/__tests__ \
  tests/security/pulse-request-body.test.ts \
  tests/security/security-harness.test.ts

npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.daemon.json --noEmit
npx tsc -p tsconfig.cli.json --noEmit
npm run type-check
```

The root Vitest configuration excludes `services/`. The three existing Pulse
schema tests were run with a temporary configuration whose `test.include` was
`["services/pulse-worker/src/index.test.ts"]` and environment was `node`.

## Scope and verification limits

The original review was a partial single-pass source audit. Fixing these five
findings does not establish exhaustive repository coverage or the absence of
other vulnerabilities. The recorded local regressions verify the blocked inputs
and ordinary controls described above; they do not prove production exploit
reliability or deployment prevalence.

Live Electron acceptance, production Pulse behavior, remote connector mutations,
external Git cloning, and release/package validation were not performed. All
changes remain local and uncommitted; no published fixed version is claimed.
