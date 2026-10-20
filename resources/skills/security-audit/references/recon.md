# Phase 1: Map

Goal: learn enough about the target to split it into ledger units that hunters can cover one
by one. Mapping agents report facts. They do not hunt for bugs.

## 1.1 Record the run

Write `{artifactDir}/run.json` with `status: "in_progress"` before any agent starts (see
`record-formats.md`). Record the commit with `git_status` or `git rev-parse HEAD`, and note
whether the working tree has uncommitted changes. Findings in uncommitted code are still
reported. The report says the tree was dirty.

## 1.2 Read earlier runs

If an earlier run exists for the same repository:

- Read its `coverage-ledger.json` and `findings.json`.
- Carry each earlier `confirmed` record forward as a phase 3 candidate whose `origin` is
  `carried`. It must be challenged again: the code may have changed.
- Turn each earlier `needs_validation`, `blocked` and `deferred` item into current work.
- Keep earlier `rejected` fingerprints in a list. Hunters receive it so they do not re-report
  them unless the code changed.
- Compare the earlier commit with the current one (`git diff --stat <old>..HEAD`). Changed
  files get new units even if the earlier run covered them.

## 1.3 Launch four mapping agents

One `orchestrate_agents` call with four tasks, each `worker_role: "researcher"`. Give every
agent the repository root, the scope, and this rule: "Report facts with `file:line` references.
Do not judge whether anything is vulnerable. Do not run anything. Answer with one JSON object."

**A. Product and stack**

- What the software is, who runs it, how it is deployed (CLI, server, desktop app, library,
  extension, mobile app, firmware).
- Languages, frameworks, runtimes, and the main dependencies that handle input (parsers,
  template engines, ORMs, HTTP clients, crypto libraries).
- Build and test commands, and whether they work offline.
- Two or three comparable public projects whose past vulnerabilities hint at what to check.

Answer shape: `{"product":"","deployment":[],"stack":[],"input_libraries":[],"build":[],"tests":[],"comparable":[],"notes":[]}`

**B. Actors and trust**

- Every kind of principal: anonymous users, signed-in users, admins, tenants, other services,
  plugins, local users, the operating system, AI models whose output is acted on.
- How each is identified and what each may do. Where the authentication and authorization
  checks live.
- Trust boundaries: places where data or control passes from a less trusted principal to a
  more trusted one.

Answer shape: `{"principals":[{"name":"","identified_by":"","may":[],"refs":[]}],"controls":[{"kind":"","where":"","refs":[]}],"boundaries":[{"from":"","to":"","via":"","refs":[]}]}`

**C. Entry points and sinks**

- Every way input arrives: HTTP routes, RPC handlers, CLI arguments, files read, environment,
  IPC channels, message queues, webhooks, deep links, clipboard, model output, plugin APIs.
- Where input is copied, cached or stored, then read again later.
- Dangerous sinks: shell and process spawn, SQL and other query builders, file system paths,
  dynamic code, deserializers, template rendering, outbound HTTP, redirects, HTML output,
  crypto calls, permission changes.

Answer shape: `{"entries":[{"kind":"","name":"","auth":"","refs":[]}],"stores":[{"what":"","refs":[]}],"sinks":[{"kind":"","refs":[]}]}`

**D. Execution and limits**

- Whether the code can be built and tested here without network access.
- What a local check would need: services, fixtures, credentials, hardware.
- Existing sandboxing, rate limits, size limits and timeouts in the code.
- Security tests that already exist, and what they cover.

Answer shape: `{"offline_build":true,"offline_tests":true,"needs":[],"limits":[{"what":"","refs":[]}],"security_tests":[],"notes":[]}`

If the target has several distinct deployment modes (for example a server and a desktop
client), add one more mapping agent per extra mode, with questions B and C scoped to it.

## 1.4 Write architecture.md

About 1,000 words, in `{artifactDir}/architecture.md`. Hunters receive it word for word, so
keep it factual and dense:

1. What the product is and how it is deployed.
2. Principals and what each may do.
3. Trust boundaries, each with its control and `file:line`.
4. Entry points grouped by surface, with authentication status.
5. Main sinks.
6. Comparable software and the bug classes it has had.
7. Gaps and changes since an earlier run.
8. Which attack class blocks apply, and which do not and why.

## 1.5 Seed the ledger

A unit is one **surface × boundary × component × attack class** combination worth a focused
look. Examples:

- `http-api::anonymous-to-user::auth-routes::access-control`
- `ipc::renderer-to-main::file-handlers::file-and-path`
- `cli::local-user-to-process::config-loader::injection`

Rules:

- Use lowercase slugs: letters, digits and `-` only. The unit `id` is the four slugs joined
  with `::`. In `deep` runs you may add a fifth `lifecycle` slug (for example `signup`,
  `export`, `delete`).
- Start from boundaries, not files. One boundary usually yields several units, one per
  relevant attack class from `attack-classes.md`.
- Skip a class that cannot apply and say why in `architecture.md`. Do not seed units for it.
- Seed `out_of_scope` units for surfaces the user excluded, and `not_applicable` units only
  when a reader would otherwise expect the unit.
- Give each unit `start_paths`: the files a hunter should open first.
- Size: quick runs aim for 8 to 20 units, standard for 20 to 60, deep for up to 150.

Write `{artifactDir}/coverage-ledger.json` and run `check-ledger.mjs`. Fix every error
before phase 2.
