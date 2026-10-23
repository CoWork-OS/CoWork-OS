# Phases 3 to 6: challenge, record, re-check, report

## Phase 3: Challenge every candidate

Every unique candidate gets its own fresh challenger: `worker_role: "verifier"`, not the
agent that found it, and not shown any other challenger's verdict. Carried records from an
earlier run are challenged the same way. Run challengers in `orchestrate_agents` batches of up
to 8. Label each one (`challenger-01`, ...) for `verification.challenge`.

Give each challenger only:

- the candidate record, without `proposed_verdict`;
- the `checks` from its ledger units;
- the parts of `architecture.md` about the principals, boundaries and controls involved;
- the attack class block for its class;
- whether local execution is approved for this run (challengers still cannot run anything
  themselves);
- the answer format below.

Prompt:

> You did not write this candidate. Your job is to try to refute it. Read the code along the
> trace yourself, starting from the entry point. Look for a check, a type, a framework
> default, a configuration or a caller that blocks the attack. Confirm that the attacker
> described can really reach the entry point.
>
> Decide:
> - `confirmed`: you followed the whole trace in the source, nothing blocks it, and the
>   impact follows.
> - `needs_validation`: the trace depends on something the source does not show
>   (deployment settings, runtime behaviour, a service you cannot read). Name it.
> - `rejected`: something blocks it. Cite the `file:line`.
>
> Answer with one JSON object and nothing else:
> `{"verdict":"confirmed|needs_validation|rejected","record":{...}}`
> where `record` is the full finding in the format below, corrected where the candidate was
> wrong.

Paste the field table and the example from `record-formats.md` after the prompt.

Process the answers:

- Discard any answer that is not exactly one JSON object of that shape, and give the
  candidate to a new challenger.
- Fill in `origin`, `found_by` and `verification.challenge` yourself. Do not trust a child to
  set them.
- If the verdict is `confirmed` and local execution is approved, you may run one minimal,
  offline proof in `{artifactDir}/scratch/` (test servers on `127.0.0.1`, no installs, no
  network). Then set `reproduction.method` to `local` and put what you saw in `observed`. If
  the proof fails, the record becomes `needs_validation`, with the failure in `blockers`.

## Phase 4: Record

Write `{artifactDir}/findings.json` with every challenged record, sorted by fingerprint.
Assign severity to confirmed records using the guide below. Then run:

```bash
node {baseDir}/scripts/check-ledger.mjs --final {artifactDir}/coverage-ledger.json
node {baseDir}/scripts/check-findings.mjs {artifactDir}/findings.json --ledger {artifactDir}/coverage-ledger.json
```

Fix every error and run both again until they pass.

### Severity guide

Score likelihood and impact separately, from the attacker's point of view as written in the
record.

- **Likelihood.** `high`: an unauthenticated or ordinary user can do it with no special
  conditions. `medium`: it needs an account with some privilege, user interaction, or a
  plausible configuration. `low`: it needs an unusual configuration, an insider, or a narrow
  race.
- **Impact.**
  - `critical`: code execution on a server or a user's machine; takeover of any account;
    access to all tenants' data.
  - `high`: access to or change of other users' sensitive data; privilege escalation;
    secret disclosure.
  - `medium`: limited data exposure; actions as another user that need interaction; denial
    of service for many users.
  - `low`: small information leaks; self-only effects; denial of service that is hard to
    sustain.
  - `informational`: no direct security effect.
- **Overall.** Start from impact. Lower it one level for `low` likelihood. Never raise it
  above impact.

## Phase 5: Re-check

Skip this phase in `quick` runs. Otherwise give every `confirmed` and `needs_validation`
record to one more fresh verifier (`worker_role: "verifier"`). It must not be the hunter or
the challenger. Label each one (`rechecker-01`, ...) for `verification.recheck`.

In `deep` runs, also re-check every `rejected` record whose claimed impact would be high or
critical, in case the challenger missed something.

Give each re-checker the record and the same supporting material as phase 3. Prompt:

> Check this security finding against the source, line by line. Confirm that each `file:line`
> says what the record claims, that the trace connects, that the attacker can reach the
> entry, and that the verdict and severity follow from the evidence. Answer with one JSON
> object and nothing else: either `{"decision":"verified","fingerprint":"<fingerprint>"}` or
> `{"decision":"replace","reason":"<what is wrong>","record":{...}}`.

Process the answers:

- `verified`: set `verification.recheck` to the re-checker's label.
- `replace`: if the change is material (a stronger verdict, or a different root cause,
  trace, impact or severity), give the replacement to yet another fresh re-checker that has
  seen neither version. Keep the version that the last re-checker verified. A weaker verdict
  or wording fix can be applied directly.
- Discard malformed answers and use a new re-checker.

Run both checkers again after the last change.

## Phase 6: Report

Write `{artifactDir}/REPORT.md`:

1. **Status line.** `complete` or `incomplete` (with the reason), depth, commit, whether the
   tree was dirty, scope, and budget used out of the limit.
2. **Summary.** Two or three sentences on the overall security posture.
3. **Confirmed findings table.** Severity, title, location, fingerprint. Sort by severity,
   then likelihood.
4. **Confirmed finding details.** For each one: attacker, trace, evidence, impact,
   reproduction and fix.
5. **Needs validation table.** Title, what blocks it, and the validation plan. No severity.
6. **Hardening notes.** Defense-in-depth items from the hunters. These are not findings.
7. **Coverage.** Unit counts by status, which surfaces are covered, and every `blocked`,
   `deferred` and `out_of_scope` unit with its reason.
8. **Rejected candidates.** Count only, plus a pointer to `findings.json`.

If there are more than five `needs_validation` records, also write `NEEDS-VALIDATION.md`
with the full record for each, so someone with deployment access can work through them.

Rules for both files:

- Counts must match `findings.json` exactly. Take them from the checker's summary line.
- No instructions to probe live systems. Reproduction steps stay at the level of what the
  source shows, or what was run locally with consent.
- No full secrets.

Finally set `run.json` `status` to `complete`, or to `incomplete` with `incomplete_reason`,
and set `finished_at`.
