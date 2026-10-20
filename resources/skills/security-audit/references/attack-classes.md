# Attack class blocks

Each `##` section below is one block. Paste a whole block into the prompt of every hunter
whose units use that class, and always paste `chained-and-wildcard`. The heading slug is the
`attack_class` value used in unit ids and fingerprints.

Choose classes by the boundary and sinks a unit touches, not by the language or the
dependencies the project happens to use.

## injection

- **Look for:** input that reaches an interpreter: shell commands and process arguments,
  SQL/NoSQL/ORM raw queries, LDAP, XPath, GraphQL resolvers that build queries, template
  engines, regular expressions built from input, HTTP headers, log lines, CSV/spreadsheet
  formulas, email headers.
- **Prove:** which part of the final command or query the attacker controls, and that no
  quoting, parameter binding or allowlist runs between entry and sink. Quote the exact call.
- **Sad paths:** argument injection through a leading `-`; newline and NUL bytes; values
  that are escaped once but decoded again later; identifiers (table, column, sort field) that
  cannot be bound as parameters; second-order input that is stored first and used later.
- **Not a finding:** parameterized queries; `execFile`/`spawn` with an argument array and no
  shell, unless the program itself interprets an argument as code.

## access-control

- **Look for:** handlers that read or change data without checking who is asking; object
  ids taken from the request (IDOR); tenant or workspace ids trusted from the client; admin
  routes protected only in the UI; checks done on one path but not on its twin (bulk, export,
  GraphQL, websocket, legacy versions); authentication flows (session fixation, token reuse,
  password reset, MFA bypass, OAuth `state`/`redirect_uri`, JWT `alg` and audience checks).
- **Prove:** the principal, the object they should not reach, and the code path that reaches
  it with no check, or with a check on the wrong value.
- **Sad paths:** a check before a lookup that uses a different id; role changes while a
  session is live; deleted or disabled users; case and unicode differences in usernames and
  emails; a default-allow branch when the policy lookup fails.
- **Not a finding:** data that is public by design. Read the product's intent in
  `architecture.md` before you report it.

## file-and-path

- **Look for:** paths built from input (traversal through `..`, absolute paths, drive
  letters, URL-encoded separators); symlink and hard-link following; archive extraction
  (zip slip, unbounded size); uploads stored under a name or type the client chose; temp files
  with predictable names; permission modes on created files; checks done on a path before the
  file is used (TOCTOU).
- **Prove:** the input that escapes the intended directory, or the file that ends up readable
  or writable by the wrong principal, and the line that does the access.
- **Sad paths:** normalization done before decoding; checking `startsWith` without a trailing
  separator; Windows paths on a POSIX check and the reverse; a symlink created between the
  check and the use.
- **Not a finding:** a path the user themselves chose in a local tool that runs with their own
  rights, unless a less trusted source can choose it.

## request-forgery

- **Look for:** outbound requests to URLs or hosts that input can influence (SSRF): webhooks,
  link previews, importers, image fetchers, PDF renderers, OAuth discovery; redirects that
  follow to internal addresses; URL parsers that disagree with the HTTP client.
- **Prove:** what the attacker can make the server request, and what that reaches (cloud
  metadata, loopback admin ports, internal services) or leaks back to them.
- **Sad paths:** DNS rebinding between check and connect; IPv6 and decimal or octal IPv4
  forms; redirects after an allowlist check; userinfo `@` tricks; non-HTTP schemes.
- **Not a finding:** fetching a fixed, hard-coded host.

## web-client

- **Look for:** HTML or script built from input (XSS: reflected, stored, DOM); unsafe
  `innerHTML`, `dangerouslySetInnerHTML`, markdown renderers without sanitizing; CSRF on
  state-changing requests that use cookies; CORS that reflects any origin with credentials;
  open redirects; `postMessage` without an origin check; clickjacking on sensitive actions;
  cookies without `HttpOnly`, `Secure`, `SameSite` where they matter.
- **Prove:** the input, the rendering point, and the context it lands in (HTML body,
  attribute, URL, script, style), plus why the encoding used is wrong for that context.
- **Sad paths:** sanitizers configured to allow `style`, `svg` or `iframe`; `javascript:`
  URLs; mutation after sanitizing; templates that disable auto-escaping.
- **Not a finding:** a missing header with no attack it would stop. Put that in hardening.

## parsing-and-deserialization

- **Look for:** deserializers that build arbitrary types (pickle, Java/.NET serialization,
  YAML with tags, `eval`-based JSON); XML with external entities; prototype pollution through
  deep merge or path setters; regular expressions with catastrophic backtracking on input;
  parsers for formats with length fields (images, archives, fonts, protocols).
- **Prove:** that attacker-controlled bytes reach the parser, and what the parser then does
  (code execution, file read, property injection that changes a later check, CPU hang).
- **Sad paths:** nested and recursive structures; duplicate keys; `__proto__`,
  `constructor`, `prototype` keys; length fields larger than the data.
- **Not a finding:** a safe-load API, or a parser fed only trusted, bundled data.

## crypto-and-secrets

- **Look for:** hard-coded credentials, keys and tokens (search for `password`, `secret`,
  `token`, `Bearer`, `BEGIN ... PRIVATE KEY`, names ending in `_KEY`, and high-entropy
  strings, including in tests, fixtures and git history); weak or misused crypto (ECB,
  static IV or nonce, MD5 or SHA-1 for passwords, non-constant-time comparison of secrets,
  `Math.random` for tokens);
  disabled TLS verification; secrets written to logs, URLs or plaintext storage.
- **Prove:** where the secret or weak primitive is, what it protects, and who can reach it.
  For a leaked secret, show where it is exposed, not just that it exists.
- **Sad paths:** a test key that is also used in production config; a key derived from a
  predictable value; tokens that never expire or are not bound to a user.
- **Not a finding:** obvious placeholders (`changeme`, `xxx`) that the code refuses to use in
  production. Never paste a full secret anywhere.

## business-logic

- **Look for:** state machines that can be driven out of order (pay after ship, approve own
  request); races on balances, quotas, coupons, invitations and one-time tokens; numeric
  overflow, negative quantities, rounding; replay of signed requests; limits enforced on the
  client only.
- **Prove:** the sequence of legitimate requests that ends in a state the product forbids,
  and the missing lock, transaction or check.
- **Sad paths:** two requests at once; retries after a timeout; cancel and refund paths;
  currency and unit conversions.
- **Not a finding:** a race whose window cannot be reached by an attacker, or whose result
  the product already reconciles.

## resource-exhaustion

- **Look for:** input sizes, counts, depths and durations with no limit; amplification (one
  small request causes much work or many outbound requests); unbounded queues, caches and
  retries; decompression without a limit; expensive operations reachable without
  authentication.
- **Prove:** the input, the unbounded loop or allocation, and that a single attacker can cause
  it at a cost far lower than the damage.
- **Sad paths:** limits checked after the data is read into memory; per-request limits with
  no per-user limit.
- **Not a finding:** load that only a trusted admin can trigger.

## data-exposure

- **Look for:** responses that return more fields than the caller may see; error messages
  and stack traces that reveal internals; logs, analytics and crash reports carrying personal
  data or secrets; caches shared between users; data kept after deletion; debug endpoints.
- **Prove:** which principal receives which data they should not, and through which path.
- **Sad paths:** serializers that include every model field; deleted records still returned
  by search or export.
- **Not a finding:** data the principal is entitled to.

## supply-chain-and-build

- **Look for:** CI workflows that run untrusted pull request code with secrets
  (`pull_request_target`, self-hosted runners); script injection through issue titles or
  branch names in workflow expressions; install scripts; dependencies fetched without a
  lockfile or integrity check; release artifacts built or signed from unprotected steps;
  update channels without signature checks.
- **Prove:** who can trigger the step, what they control, and what secret or artifact they
  reach.
- **Sad paths:** reusable workflows and composite actions; caches shared between trusted and
  untrusted jobs.
- **Not a finding:** a dependency merely being old. Use the `dependency-check` skill for
  known-vulnerable versions.

## config-and-deploy

- **Look for:** infrastructure as code and deployment files: public storage buckets, broad
  IAM roles, open security groups, containers running as root or privileged, mounted
  sockets, debug flags and default credentials, secrets in images or environment files
  committed to the repository.
- **Prove:** the resource, the access it grants, and who gets it.
- **Sad paths:** different settings per environment where only production is safe.
- **Not a finding:** a setting you cannot see deployed. Mark it `needs_validation` and say
  which deployment fact would settle it.

## memory-safety

- **Look for:** in C, C++, unsafe Rust, FFI, native addons and JITs: buffer overflows,
  out-of-bounds reads, use after free, double free, integer overflow in size math,
  uninitialized memory, format strings, type confusion.
- **Prove:** the input that reaches the bad access, the size arithmetic involved, and the
  reachable memory effect.
- **Sad paths:** length fields from the input; signed and unsigned mixing; error paths that
  free and then continue.
- **Not a finding:** a pattern in code that only processes trusted, fixed-size data.

## ai-and-agents

- **Look for:** model output that reaches a sink (shell, SQL, file writes, HTML, tool calls)
  without the same checks as user input; untrusted content (web pages, emails, documents,
  tool results, retrieved chunks) that can steer a model that holds tools or secrets (prompt
  injection); tool and MCP permission checks that the model's arguments can bypass; memory or
  retrieval stores shared across users; system prompts or keys sent to third parties.
- **Prove:** the untrusted source, the tool or sink it can reach through the model, and the
  check that is missing or that runs on the wrong value.
- **Sad paths:** instructions hidden in file names, alt text, metadata or encoded text;
  multi-step chains where each step looks safe alone; approvals shown with a summary that
  differs from the real action.
- **Not a finding:** a model saying something wrong with no action attached.

## local-ipc-and-desktop

- **Look for:** Electron and other desktop apps: IPC handlers that trust renderer input,
  preload scripts that expose powerful APIs, `nodeIntegration`, missing `contextIsolation`,
  `shell.openExternal` and `openPath` on input, custom protocol and deep-link handlers, local
  HTTP or websocket servers without authentication or origin checks, Unix sockets, XPC, D-Bus
  and named pipes, files and settings other local users or apps can write.
- **Prove:** which less-trusted party (web content, another local user or app, a link a user
  clicks) can send what, and the privileged action it reaches.
- **Sad paths:** servers bound to `0.0.0.0` instead of loopback; DNS rebinding against a local
  server; navigation of the main window to remote content.
- **Not a finding:** an action the local user can already do with their own rights.

## chained-and-wildcard

- **Look for:** two or more low findings that combine into a serious one (an open redirect
  plus an OAuth flow, a file write plus a config reload, an XSS plus a privileged IPC call);
  anything surprising that fits no other class; interesting commits in history (reverted
  security fixes, removed checks, "temporary" bypasses).
- **Prove:** each link in the chain separately, then the combined effect.
- **Not a finding:** a chain where any link is only hypothetical.
