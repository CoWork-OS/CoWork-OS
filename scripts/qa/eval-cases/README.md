# Eval Regression Cases

This folder stores file-backed regression cases for production incidents.

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
