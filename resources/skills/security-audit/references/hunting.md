# Phase 2: Hunt

Goal: every `planned` ledger unit ends `covered`, `candidate`, `blocked` or `deferred`, with
evidence of what was read.

## 2.1 Plan a wave

Pick the next units in this order:

1. surfaces reachable without authentication;
2. boundaries into high-value assets (admin, payments, secrets, other tenants, code execution);
3. units for changed code and gaps from an earlier run;
4. attack classes that comparable software has had bugs in;
5. everything else, by `id`.

Give each hunter 1 to 4 units that share code, so it reads the shared files once. A wave is
one `orchestrate_agents` call with up to 8 hunters (`worker_role: "researcher"`). Set each
unit to `assigned` with the hunter's `agent` label, write the ledger, run `check-ledger.mjs`,
then launch.

## 2.2 Build each hunter prompt

Assemble these parts in this order. Paste the text itself, never a file name or a summary:

1. **Role.** "You are a security researcher reviewing source code you did not write. You
   are read-only: do not run anything and do not edit files. Your answer is one JSON object
   and nothing else."
2. **Architecture.** The full text of `architecture.md`.
3. **Your units.** Each unit's `id`, its four parts, and `start_paths`.
4. **Attack class blocks.** The full block from `attack-classes.md` for every class among the
   units, plus `chained-and-wildcard`.
5. **Method.** Section 2.3 below, word for word.
6. **Do not report.** Earlier rejected fingerprints, carried-forward findings, and units
   owned by other hunters in this wave, so they are not duplicated.
7. **Answer format.** Section 2.4 below, word for word.

## 2.3 Hunting method (paste into every hunter prompt)

> Read the code at depth. Open the entry points in your units and follow the data to every
> sink it can reach, across files. Read the validation and authorization code itself, not
> its name or comment.
>
> For each possible problem, write down the invariant before you call it a candidate:
> the attacker (which principal), what they control, the control that should stop them,
> the path from entry to sink as `file:line` steps, the smallest harmful effect, and the fix.
> If you cannot fill in every part from code you have read, it is not a candidate. Put it in
> `leads` with what is missing.
>
> Test the sad paths. Check what happens with empty, huge, negative, duplicated, unicode,
> encoded and concurrent input, and on error branches, retries and partial failures. Look for
> two components that disagree about the same value: a parser and a validator, a cache and its
> source, a check and the later use of the same data.
>
> Look for the control that is missing, not only the one that is wrong.
>
> A unit is `covered` only when you can list the files you read and at least one concrete
> check you made with its result. If you could not reach the code that matters, mark the unit
> `blocked` and say why.
>
> Never copy a full secret into your answer. Show at most its first four characters.

## 2.4 Answer format (paste into every hunter prompt)

> Answer with one JSON object, no prose before or after and no code fence:
>
> ```json
> {
>   "units": [
>     {
>       "id": "<unit id>",
>       "outcome": "covered | candidate | blocked",
>       "read_paths": ["src/a.ts", "src/b.ts"],
>       "checks": [
>         {
>           "invariant": "<what must hold>",
>           "method": "source",
>           "result": "<what you found, with file:line>"
>         }
>       ],
>       "fingerprints": ["<fingerprint of each candidate from this unit>"],
>       "blocked_reason": "<only when outcome is blocked>"
>     }
>   ],
>   "candidates": [
>     {
>       "fingerprint": "<attack-class>/<component>/<short-slug>",
>       "title": "<one line>",
>       "attack_class": "<class slug>",
>       "coverage_ids": ["<unit id>"],
>       "location": { "path": "src/a.ts", "line": 42 },
>       "attacker": "<principal and what they control>",
>       "trace": {
>         "entry": "<file:line and what arrives>",
>         "steps": ["<file:line: what happens>"],
>         "sink": "<file:line and the effect>"
>       },
>       "evidence": [{ "ref": "src/a.ts:42", "note": "<why it matters>" }],
>       "impact": "<smallest harmful effect>",
>       "preconditions": ["<what must be true>"],
>       "fix": "<concrete change>",
>       "proposed_verdict": "confirmed | needs_validation"
>     }
>   ],
>   "leads": [{ "unit": "<unit id>", "idea": "<what>", "missing": "<what you could not show>" }],
>   "hardening": [{ "ref": "src/a.ts:10", "note": "<defense in depth, not exploitable>" }]
> }
> ```
>
> A fingerprint uses lowercase letters, digits and `. _ : / -`. It names the bug, not the run:
> no line numbers, agent names, severities or verdicts. Two hunters who find the same bug
> should produce the same fingerprint.

## 2.5 Process the wave

For each hunter answer:

- If it is not exactly one valid JSON object of this shape, discard it, reset its units to
  `planned`, and assign them to a new hunter in the next wave.
- Otherwise update each unit:
  - `covered`: set `status`, `read_paths` and `checks`.
  - `candidate`: the same, plus `fingerprints`.
  - `blocked`: set `reason`.
- Before overwriting a unit that already had a result, move the earlier result into the
  unit's `attempts` list.
- Deduplicate candidates by fingerprint. When two hunters describe the same bug with different
  fingerprints, keep the clearer one and point both units at it.
- Keep `leads` and `hardening` in a working list for the report. A lead that names a specific
  gap may become a new unit.

Write the ledger and run `check-ledger.mjs`.

## 2.6 Coverage review

After every wave, launch one fresh coverage reviewer (`spawn_agent`, `worker_role:
"researcher"`, `wait: true`). It has not seen any hunter's reasoning. Give it
`architecture.md`, the full ledger, and the list of candidate fingerprints. Ask it:

> Find what this audit has not looked at yet. Check the code for entry points, boundaries,
> sinks or components that no unit covers. Find units marked `covered` whose `read_paths`
> or `checks` do not cover the unit's surface. Answer with one JSON object:
> `{"missing_units":[{"id":"","start_paths":[],"why":""}],"reopen":[{"id":"","why":""}],"stop":true}`.
> Set `stop` to true only if you found nothing to add or reopen.

Add each missing unit as `planned` and set each reopened unit back to `planned`, keeping the
old result in `attempts`. Then plan the next wave.

## 2.7 When hunting stops

- `quick`: after one wave and one coverage review.
- `standard`: when a coverage review returns `stop: true` with nothing to add.
- `deep`: as standard, then one more wave in which a different hunter takes each covered
  unit, and then a final coverage review that must also return `stop: true`.
- Any depth: when the budget reserve for phases 3 and 5 is reached. Set the remaining
  `planned` units to `deferred` with the reason `budget`, and mark the run `incomplete`.

No unit may stay `planned` or `assigned` when hunting ends.
