# Record formats

All audit files live in `{artifactDir}`. The two checkers in `{baseDir}/scripts/` enforce the
ledger and findings formats exactly. Unknown fields are errors, so a typo fails loudly.

## run.json

Written at setup, updated when the status changes. Not machine-checked, but keep these fields:

```json
{
  "run_id": "2026-10-19-1",
  "repo": "/path/to/repo",
  "commit": "e9d6d9a9a",
  "dirty": false,
  "scope": ["src/server"],
  "depth": "standard",
  "budget": { "limit": 40, "used": 0 },
  "execution": "source-only",
  "earlier_runs": [],
  "status": "in_progress",
  "incomplete_reason": null,
  "started_at": "2026-10-19T10:00:00Z",
  "finished_at": null
}
```

`execution` is `source-only` or `local-approved`. `status` is `in_progress`, `complete` or
`incomplete`.

## coverage-ledger.json

```json
{
  "version": 1,
  "units": [
    {
      "id": "http-api::anonymous-to-user::auth-routes::access-control",
      "surface": "http-api",
      "boundary": "anonymous-to-user",
      "component": "auth-routes",
      "attack_class": "access-control",
      "start_paths": ["src/server/routes/auth.ts"],
      "status": "covered",
      "agent": "hunter-w1-02",
      "wave": 1,
      "read_paths": ["src/server/routes/auth.ts", "src/server/session.ts"],
      "checks": [
        {
          "invariant": "Password reset tokens are single use",
          "method": "source",
          "result": "Token deleted in the same transaction at session.ts:88"
        }
      ],
      "fingerprints": [],
      "reason": null,
      "attempts": []
    }
  ]
}
```

- `id` is `surface::boundary::component::attack_class`, with an optional fifth
  `::lifecycle` part in deep runs. Each part is a lowercase slug (`a-z`, `0-9`, `-`) and must
  match its field.
- `attack_class` is a heading slug from `attack-classes.md`.
- `method` is `source`, or `local` when the parent ran something with the user's consent.

What each `status` requires:

| status | agent | read_paths, checks | fingerprints | reason |
| ------ | ----- | ------------------ | ------------ | ------ |
| `planned` | empty | empty | empty | empty |
| `assigned` | set | empty | empty | empty |
| `covered` | set | non-empty | empty | empty |
| `candidate` | set | non-empty | non-empty | empty |
| `blocked` | any | any | empty | set |
| `deferred` | any | any | empty | set |
| `out_of_scope` | empty | empty | empty | set |
| `not_applicable` | empty | empty | empty | set |

"Empty" means `null`, `""` or `[]`. Every unit except `out_of_scope` and `not_applicable`
needs at least one `start_paths` entry. `attempts` holds earlier results for the unit, as
objects, oldest first.

Run with `--final` once hunting has ended: no unit may then be `planned` or `assigned`.

## findings.json

```json
{
  "version": 1,
  "depth": "standard",
  "findings": [
    {
      "fingerprint": "access-control/project-api/missing-owner-check-on-export",
      "verdict": "confirmed",
      "title": "Any signed-in user can export another user's project",
      "attack_class": "access-control",
      "coverage_ids": ["http-api::user-to-other-user::project-api::access-control"],
      "origin": "hunted",
      "found_by": "hunter-w1-03",
      "verification": { "challenge": "challenger-07", "recheck": "rechecker-02" },
      "location": { "path": "src/server/routes/projects.ts", "line": 141 },
      "attacker": "Any signed-in user who knows or guesses a project id",
      "trace": {
        "entry": "src/server/routes/projects.ts:138 GET /projects/:id/export",
        "steps": ["projects.ts:141 loads the project by id with no owner filter"],
        "sink": "projects.ts:150 streams the project archive to the caller"
      },
      "evidence": [{ "ref": "src/server/routes/projects.ts:141", "note": "findById(id) has no ownerId" }],
      "impact": "Read access to every project's files and history",
      "preconditions": ["Attacker has any account", "Project ids are sequential"],
      "reproduction": {
        "method": "source",
        "steps": ["Sign in as user A", "Request /projects/<B's id>/export"],
        "observed": null
      },
      "fix": { "summary": "Filter by ownerId or check membership before loading", "patch": null },
      "severity": { "likelihood": "high", "impact": "high", "overall": "high" },
      "confidence": "high"
    }
  ]
}
```

- `findings` is sorted by `fingerprint` and fingerprints are unique.
- `fingerprint` uses `a-z 0-9 . _ : / -` and starts with a letter or digit. It names the bug,
  not the run.
- `origin` is `hunted`, or `carried` for a record from an earlier run. A carried record has
  `found_by: "earlier-run"`.
- `verification.challenge` names the phase 3 verifier and `verification.recheck` the phase 5
  verifier. They must differ from each other and from `found_by`. `recheck` may be `null`
  only for `rejected` records and in `quick` runs.

Fields by verdict:

| field | confirmed | needs_validation | rejected |
| ----- | --------- | ---------------- | -------- |
| `fingerprint`, `verdict`, `title`, `attack_class`, `coverage_ids`, `origin`, `found_by`, `verification`, `location`, `trace`, `evidence` | required | required | required |
| `attacker`, `impact` | required | required | optional |
| `preconditions` | required (may be `[]`) | optional | not allowed |
| `reproduction` | required | not allowed | not allowed |
| `fix` | required | optional | not allowed |
| `severity`, `confidence` | required | not allowed | not allowed |
| `blockers`, `validation_plan` | not allowed | required, non-empty | not allowed |
| `reason` | not allowed | not allowed | required |

- `reproduction.method` is `source` or `local`. A `local` reproduction needs `observed`, the
  output you saw.
- `severity.likelihood` is `high`, `medium` or `low`. `severity.impact` and
  `severity.overall` are `critical`, `high`, `medium`, `low` or `informational`.
- `confidence` is `high` or `medium`. A confirmed finding with low confidence is really
  `needs_validation`.
- `blockers` lists what could not be seen. `validation_plan` lists steps that would settle it,
  each saying whether it needs local execution or access to a deployment.

When run with `--ledger`, the findings checker also checks that:

- every `coverage_ids` entry exists in the ledger;
- every fingerprint of every `candidate` unit has a record in `findings.json`;
- every `hunted` record's fingerprint is listed by at least one of its units.
