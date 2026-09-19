# Local-model execution profile

The optional `local-balanced-v1` profile is a versioned, backend-independent
runtime tuning contract for local inference. It can be used with Atomic Chat,
Ollama, MLX, or another compatible local server without changing CoWork's
agent loop or permission model.

The profile is opt-in through `COWORK_LOCAL_MODEL_PROFILE=local-balanced-v1`.
When enabled, the runtime records the profile ID/version alongside the resolved
output budget so a task can be compared with the legacy path. The profile does
not install, start, stop, or configure a local model server.

The initial profile is intentionally conservative:

- bounded action and final output budgets;
- one active local generation per serving resource;
- small safe-read parallelism remains a tool-scheduler concern;
- full-request token accounting is recorded for system, tools, history, evidence,
  attachments, memory, output, and safety margin;
- existing permission filtering, context compaction, and tool-result truncation
  remain the source of truth for tool visibility and evidence reduction.

This first slice changes local output reservations, records the accounting
trace, and limits inference concurrency. It does not silently replace the
existing tool/evidence/compaction policies; those remain separate qualification
work for later profile versions.

## Current profile contract

`local-balanced-v1` currently reserves these bounded defaults:

- action output: 1,536 tokens;
- tool follow-up output: 2,048 tokens;
- final output: 3,072 tokens;
- typical tool result: 1,024 tokens;
- injected tool evidence: 4,096 tokens;
- memory: 768 tokens; and
- safety margin: 256 tokens.

The profile exposes at most 10 visible tools, permits one active generation per
local serving resource, and allows up to three safe reads in parallel. The
visible tool list must already be permission-filtered; profile selection can
reduce that list but never grants a new capability.

Model capabilities are recorded as `verified`, `unsupported`, or `unknown` and
are keyed by endpoint, exact model ID, backend, and optional backend version or
template. This prevents an observation about one local model from being treated
as a guarantee for every model served by the same application.

The profile is not a claim that every local model is faster or more capable.
Qualification must use the same model, fixtures, workspace, and permission
policy as the baseline, and must fail closed on unauthorized tools,
duplicate mutations, cancellation followed by completion, or held-out
regressions.

The Atomic Chat route has been checked for local model discovery and typed
connection failures. Full-generation performance and capability qualification
remain endpoint/model-specific and are not established by this profile alone.
