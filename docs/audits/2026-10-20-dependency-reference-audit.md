# Dependency and reference audit — 2026-10-20

This is a dated audit receipt for the deep test, legacy-code, dependency and
reference cleanup based on commit `ff2e8e457e843b3d1e809b6405cc19e44423c4f1`.
It records local source and test evidence, not release or production certification.

## Removal decisions

| Removed material | Evidence and retained coverage |
| --- | --- |
| Per-app risk-profile and permission-manager implementations and nine tests | Commit `a6dccdb7a` explicitly removed the runtime flow. Tracked-inclusive caller scans found only the retired pair and their tests. Current access-profile, session and tool protections remain covered. |
| Notification-overlay diagnostic script | Commit `69362a86f` retired the production overlay. The hardcoded diagnostic had no active entry point. Current notification-center tests remain. |
| Dispatched-agents CSS and orphan snapshot | Commit `7d2fd551b` removed the component and its test. The remaining selectors and snapshot had no consumer. |
| Unused `CitationPanel` component body and two file-type regex exports | Caller scans found no consumers. The live `CitationBadge` and shared format helpers remain; citation rendering has regression coverage. |
| Root `qrcode-terminal`, `vite-plugin-electron`, `@types/pdf-parse` declarations | No active source, script, configuration or packaging consumer. QR rendering uses `qrcode`; Vite/Electron startup has its own maintained scripts; `pdf-parse` v2 ships its own types. Lockfile entries exclusive to these dependencies were removed. |
| Test-local gateway and canvas implementations | Tests now exercise the actual services and stores. The behavioral coverage mapping is preserved in the local QA evidence; these replacements exposed and fixed the gateway limit boundary bug. |

A missing direct caller alone was insufficient proof of retirement. Dormant gateway
and Build Mode orchestration, reflective daemon entry points, migration fixtures,
and unique historical human-battery scenarios remain. The unsafe legacy battery
entry point now fails before database changes, approvals or network hooks and
points to the maintained runner.

## Dependency ownership and bug fixes

All 24 npm manifests were inventoried, along with the checked-in lockfiles,
production/test imports, dynamic module references, configuration, build scripts,
CLI entry points, peers, overrides and native packaging paths. Python imports and
bootstrap/optional-dependency guards were reviewed across the tracked Python files.
All four lock graphs have no missing required edges or unreachable entries. The
1,162 installed root-lock nodes match their locked versions; 137 optional platform
nodes are absent on this host. Nested manifests without locks do not establish a
reproducible transitive version set, so they have no independent vulnerability verdict.

The audit corrected undeclared direct ownership of the AWS INI credential provider,
`form-data`, `undici`, `@electron/asar` and the ESLint preset `@eslint/js`. Existing
locked versions were retained; the previously absent ESLint preset was installed.
The finance-data, maps and home-assistant connector manifests now declare the Node
types required to compile independently of the root checkout.

`react-is` remains a Recharts peer, Twilio remains an independent test oracle, and
`node-fetch` remains an active alias with compatibility overrides. Native modules,
Electron, parser build tools and optional Python features retain their dependencies.
The pinned libsignal tarball is an intentional package alias; npm's installed-tree
name warning is recorded rather than resolved by substituting a crypto library.

The catalog authoring script now runs on the supported Node runtime without an
undeclared TypeScript runner. Container manifest-install layers explicitly disable
lifecycle scripts until source files exist; native addon preparation is explicit
for the Node or Electron ABI. A typo in `.dockerignore` was corrected so host
`node_modules`, including nested installs, cannot overwrite image dependencies.
Offline regression fixtures exercise the actual install and Node rebuild commands;
they do not replace a full image build.

## Documentation and reference coverage

The audit enumerated tracked files, including files hidden by broad ignore rules.
It checked 711 Markdown files, 1,985 local links, 255 section-link candidates,
literal code-path references,
relative source imports, bundled skill resources, script entry points and npm
commands. Moved MainContent paths, obsolete memory-store claims, stale security and
navigation descriptions, missing key-generation instructions, and two broken
section links were corrected. The generated browser capability matrix was refreshed.

Skill-creator guidance no longer invokes unshipped initialization/packaging helpers.
Unbroker distinguishes its unbundled upstream suite from four local hermetic CLI
smoke tests. Those tests verify consent gating, opaque isolated subject records and
ledger transitions using temporary synthetic data, without contacting brokers or
sending email. Source tests are excluded from installed skill packages.

Historical plans, changelogs, benchmark fixtures, illustrative paths and product
terminal URI fragments are retained with appropriate context. VitePress configuration
is retained as docs-site scaffolding; app CI dispatches website updates to a separate
repository, whose build environment is outside this checkout. External URL uptime
and every natural-language product claim were not certified by static link checks.

## Validation and remaining boundaries

The complete application build, type check, lint, formatting, documentation version
and generated-reference checks pass. The four dependency ownership tests, four
Unbroker CLI tests and strict TypeScript checks for the new test fixtures pass.
The Docker lifecycle/catalog/discovery focused run passes seven tests in three files.
The final `npm test` run passes 121 Node tests and 17,787 Vitest tests across 1,579
files, with zero failures and ten integration skips. The skips are one live Android,
four PACT reference-provider and five Docker filesystem cases. Android and PACT
passed separately in the earlier controlled runs; the final default run does not
recreate those external services. Docker remains unavailable for fresh verification.
The earlier audit also exercised the running Electron task-read/answer-state flow,
Numbat, a disposable Android emulator and the pinned PACT reference services.

Registry advisory results are an inventory, not proof of exploitability. The root
lock reports 43 package entries: two critical, 17 high, 20 moderate and four low.
All three connector locks report zero. The critical entries belong to `protobufjs`
(Baileys/libsignal and the PI AI/Google SDK path) and `proxy-addr` (Slack Bolt/Express).
Dependency ownership does not establish that the advisory trigger is reachable.
Unresolved advisories and their owning paths remain explicit in the local QA reports;
no blanket audit-fix, major upgrade or crypto-library substitution was used to suppress them.
Docker-dependent filesystem tests, full container-image acceptance and Harbor runtime
acceptance require an available Docker daemon. The earlier passing Docker cases do
not substitute for a fresh image or Harbor runtime result.

This work does not establish application-wide authorization: bot/global queries,
managed-session/work-context reads, input requests, live event broadcasts and other
transport identity scopes remain separate review boundaries.
