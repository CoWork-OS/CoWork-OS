# Security Harness

The security harness is the first local implementation of the CoWork OS security-discovery loop:

`prepare -> scan -> validate/debate -> dedup -> prove -> eval coverage`

It is intentionally deterministic and CI-friendly. The harness does not try to replace human security
review or the `security-auditor` role. It gives changed high-risk files a repeatable first pass and
produces artifacts that Mission Control/Core Harness can surface.

## Command

```bash
npm run qa:security:harness
```

Useful flags:

- `--base <ref>` and `--head <ref>` scan changed files in a git range. Defaults to `HEAD~1...HEAD`.
- `--files <comma-separated>` scans explicit paths.
- `--all` scans every tracked file.
- `--out <path>` writes the full JSON report. Default: `artifacts/security-harness/security-harness-report.json`.
- `--mission-control-out <path>` writes the Mission Control card payload. Default: `artifacts/security-harness/mission-control-findings.json`.
- `--db <path> --profile-id <id>` also writes a `regression_eval` core trace and deduped failure records for Mission Control.
- `--confirmed-fix --fix-id <id> --fix-summary <text>` creates or updates `scripts/qa/eval-cases/security-harness-regressions.json`.
- `--fail-on-findings` makes high/critical findings fail the process. The default is advisory so the harness does not make ordinary task verification or agent execution stricter.

## Targeting

The prepare stage only scans changed files that touch high-risk boundaries:

- tool policy and security manager code
- access-profile resolution, path evaluation, and permission-settings code
- agent tools and runtime policy code
- sandbox and process execution code
- Browser Workbench automation surfaces
- Electron IPC/preload/main-process boundaries
- connector source code
- regression policy and the harness itself

This keeps routine documentation, renderer-only styling, and unrelated product changes out of the
security queue unless they cross a sensitive boundary.

## Validation And Debate

Every scanner candidate must pass a deterministic verifier/debater stage before it becomes a finding.
A candidate is confirmed only when it has concrete line evidence and the file is in a configured
high-risk boundary. The report records:

- verifier requirement and verdict
- debater counterargument
- proof requirement
- suggested proof or regression shape

That mirrors the rule for human review: a security issue should graduate with evidence and a path to
proof, not just a suspicious pattern.

## Mission Control

The harness always writes a Mission Control payload:

```text
artifacts/security-harness/mission-control-findings.json
```

When `--db` and `--profile-id` are provided, it also creates a Core Harness trace using
`trace_kind = regression_eval` and inserts deduped `core_failure_records`. The DB mode is optional so
CI and local development can run without needing an app profile.

The harness is not part of the ordinary task verifier path. It does not alter `verified` mode,
agent step completion, task-list verification, approval policy, or final-answer gates.

When access-profile code changes, pair the harness with the focused profile tests from
[Access Profiles](../access-profiles.md#implementation-map). The harness can identify a
changed high-risk boundary; it does not replace tests for profile inheritance, stale-profile
fail-closed behavior, path canonicalization, or backend representability.

## Eval Coverage

For confirmed security or production-policy fixes, run:

```bash
npm run qa:security:harness -- --confirmed-fix --fix-id <incident-or-pr-id> --fix-summary "Short fix summary"
```

This updates `scripts/qa/eval-cases/security-harness-regressions.json` with one category per confirmed
finding, or a production-policy placeholder when the fix removes the original finding. The existing
regression policy can then enforce that production/security fixes leave durable eval coverage.
