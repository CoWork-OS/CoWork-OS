# Eval Regression Cases

This folder stores regression scenario specifications for production incidents.
These JSON files are not automatically loaded or executed by `run_eval_suite.cjs`;
that runner grades cases registered in SQLite, while `--fixtures-only` runs the
built-in replay fixtures. Category-specific assertions in these specifications
need an outcome grader before they can count as measured coverage.

`npm run qa:harness` runs executable runtime and evaluation regressions. Keep a
matching executable test when fixing a runtime issue; changing a specification
alone does not validate the fix.

Policy:

- If a PR fixes a production failure/incident, add or update at least one `*.json` file in this folder.
- CI enforces this policy through `scripts/qa/enforce_eval_regression_policy.cjs`.

Suggested file schema:

```json
{
  "id": "incident-2026-03-01-shell-timeout",
  "title": "Shell timeout loop in follow-up execution",
  "source": {
    "incident": "INC-1234",
    "taskId": "optional-task-id"
  },
  "assertions": {
    "expectedTerminalStatus": "ok"
  },
  "notes": "What failed before and what should now pass"
}
```

Files are local-only artifacts and should not contain secrets or PII.
