---
name: security-audit
description: "Answer security questions about code, review a file or change for vulnerabilities, or run a full multi-agent audit of a codebase with a coverage ledger and independently verified findings."
version: "2.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Security Audit

Two modes share one skill:

- **Advise** (the default). Security questions, a focused review of a named file, function or
  diff, or "is this safe?". Answer in the conversation. Write no files.
- **Full audit**. A complete audit or pen-test-style review of a codebase or a large part of it.
  Runs six phases with sub-agents and writes a findings file and a report.

Loading this skill never starts a full audit by itself.

`{baseDir}` is this skill's folder and `{artifactDir}` is the task's output folder. The skill
prompt gives both as real paths.

## Choose the mode

Run a **full audit** only when the user:

- asks to audit, pen test or "security review" a whole repository, service or package;
- asks for a full, deep or comprehensive security review; or
- asks for audit artifacts (a findings file, a report, a coverage ledger).

Everything else is **advise** mode. If the request could be either ("check this project for
security issues"), ask one short question: a quick answer now, or a full audit that runs
several agents and takes longer.

Use other skills when they fit better: `dependency-check` for known-vulnerable package versions,
`code-review` / `code-reviewer` for general PR review, and `architecture-design` when the user
wants a design document rather than bugs.

## Advise mode

1. Read the code the question is about, plus the callers and sinks needed to follow the data.
   Read at depth. A name or a comment is not evidence.
2. For larger scopes you may delegate one or two read-only helpers with `spawn_agent`
   (`worker_role: "researcher"`). Give each a narrow question and the paths to start from.
3. For each issue, state the invariant that breaks: who the attacker is, what they control,
   which control should stop them, the path from entry to sink with `file:line` references,
   and the smallest harmful effect.
4. Label every issue **confirmed** (the trace holds in the source you read) or **needs
   validation** (it depends on configuration, deployment or runtime behaviour you could not
   see, so say what would settle it). Drop anything you refuted.
5. Give a concrete fix for each confirmed issue. Severity only for confirmed issues.

## Full audit

Read the phase references as you reach each phase. Do not load them all up front.

| Phase | What happens | Reference |
| ----- | ------------ | --------- |
| 1. Map | Four parallel read-only agents map the product, actors, entry points and execution limits. You write `architecture.md` and seed `coverage-ledger.json`. | `{baseDir}/references/recon.md` |
| 2. Hunt | Hunter waves take ledger units, read the code and return candidates. A fresh coverage reviewer checks each wave for gaps. | `{baseDir}/references/hunting.md`, `{baseDir}/references/attack-classes.md` |
| 3. Challenge | Each candidate goes to a fresh verifier that did not find it and tries to refute it. Verdict: confirmed, needs_validation or rejected. | `{baseDir}/references/verification-and-report.md` |
| 4. Record | You write `findings.json` and run both checkers. | `{baseDir}/references/record-formats.md` |
| 5. Re-check | A second fresh verifier re-checks every confirmed and needs_validation record. | `{baseDir}/references/verification-and-report.md` |
| 6. Report | You write `REPORT.md` and, when needed, `NEEDS-VALIDATION.md`. | `{baseDir}/references/verification-and-report.md` |

### Setup

Before phase 1, settle these and record them in `run.json` (see
`{baseDir}/references/record-formats.md`):

- **Target and scope.** The repository root, plus any paths the user limited the audit to.
  Surfaces outside a scoped run become `out_of_scope` ledger units, never `covered`.
- **Depth.**
  - `quick`: coarse units, one hunter wave and one coverage review, and phase 5 is skipped.
    The report then says each finding was verified once.
  - `standard` (default): units per surface and boundary, coverage reviews until one finds no
    gaps, then phases 3 and 5 in full.
  - `deep`: units per subsystem and lifecycle step, a second hunting pass over covered units
    by a different hunter, and a re-check of every rejected candidate with high impact.
- **Budget.** A cap on sub-agent runs. Defaults: quick 15, standard 40, deep 90. Before each
  wave, keep enough in reserve for the coverage review and for one or two verifiers per
  candidate you expect. If the budget runs out, stop hunting, finish phases 3 to 6 for what
  you have, and mark the run `incomplete`.
- **Output folder.** `{artifactDir}`. Never write audit files into the audited repository.
- **Earlier runs.** Look for `artifacts/skills/*/security-audit/coverage-ledger.json` in the
  workspace, or use a folder the user names. Phase 1 explains how to reuse them.
- **Local execution.** Default is source-only. Run the target's code, tests or proof inputs
  only if the user agrees for this run. Then run them yourself with `run_command`: offline,
  no dependency installs, any test server bound to `127.0.0.1`, inputs and outputs under
  `{artifactDir}/scratch/`. Never probe a deployed system, staging included. Without that
  consent, leads that need execution stay `needs_validation`.

### How agents are used in CoWork

- **Delegation.** `orchestrate_agents` runs 2 to 8 tasks per call, three at a time. Use it for
  phase 1 and for hunter waves. Use `spawn_agent` with `wait: true` for a single reviewer or
  verifier.
- **Roles.** Mapping agents, hunters and coverage reviewers use `worker_role: "researcher"`.
  Challengers (phase 3) and re-checkers (phase 5) use `worker_role: "verifier"`. Both roles are
  read-only and have no shell. They read with `read_file`, `grep`, `glob` and `list_directory`,
  and they return their result as their final answer.
- **Model.** Do not pass `model_preference: "cheaper"` to hunters or verifiers.
- **One writer.** You, the parent, are the only agent that writes `run.json`,
  `architecture.md`, `coverage-ledger.json`, `findings.json` and the reports. Write with
  `write_file`. Run the matching checker with `run_command` after every write:

  ```bash
  node {baseDir}/scripts/check-ledger.mjs {artifactDir}/coverage-ledger.json
  node {baseDir}/scripts/check-findings.mjs {artifactDir}/findings.json --ledger {artifactDir}/coverage-ledger.json
  ```

  The first checks the ledger. The second checks findings (from phase 4 on) and cross-checks
  them against the ledger. Fix what they report and run them again. Never edit a checker to
  make a file pass.
- **Fresh context.** A verifier never sees the hunter's reasoning beyond the candidate record,
  nor another verifier's verdict. The agent that found something never verifies it.
- **Strict results.** Every child must answer with exactly one JSON object in the shape its
  prompt gives. If an answer is not valid JSON, or wraps the JSON in prose, discard it and
  give the same work to a new agent. Do not repair it yourself.

### Principles

- **Coverage before conclusions.** The ledger, not your memory, decides what has been looked
  at. A unit is `covered` only when a hunter reports the paths it read and the checks it ran.
- **Evidence over plausibility.** A finding needs a trace from an entry point an attacker can
  reach to a sink, through code you have read. "This pattern is often vulnerable" is not a
  finding.
- **Three verdicts, no guessing.** `confirmed` means the trace holds. `needs_validation` means
  it depends on something outside the source, and the record says what would settle it.
  `rejected` keeps refuted candidates on record so the next run does not hunt them again.
- **Severity is earned.** Only confirmed records get a severity. Score likelihood and impact
  separately, then the overall rating.
- **Secrets stay secret.** When you find a credential in code, history or config, record the
  file, line and type. Show at most the first four characters. Never copy a full secret into
  any output or prompt.
- **Honest endings.** A run ends either `complete` (the coverage review found no gaps, every
  candidate has a verdict, both checkers pass) or `incomplete` with the reason in `run.json`
  and at the top of `REPORT.md`.

### Mistakes to avoid

- Starting a full audit from a vague request without asking.
- Sending hunters a list of attack class names instead of the full class blocks.
- Marking a unit `covered` because a hunter "found nothing" without listing what it read.
- Letting a hunter's confidence stand in for the challenge phase.
- Rating severity for `needs_validation` or `rejected` records.
- Running the target's code, installing packages, or calling any network service without
  the user's consent for this run.
- Reporting a finding the checkers rejected, or a count that does not match `findings.json`.

## Finish

In the conversation, give the user:

- the run status and depth;
- counts by verdict and by severity;
- the confirmed findings, highest severity first, with the fix for each;
- what still needs validation, and how to settle it;
- the output folder path.

Do not paste the whole report.
