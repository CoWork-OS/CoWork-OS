# Tracked background jobs

Two consecutive `process_output` reads with no new output on a running job enable
completion delivery. The tool reports `notify_on_complete: true` and tells the agent to stop
polling. Final output is bounded and redacted, and delivery waits for stdio to close.
Completion notices retain the current task conversation, reach the model as a
`RUNTIME NOTICE` rather than a user update, and are not treated as new instructions from a
different bot. Finished notices wait durably while the session is paused, blocked or
interrupted and retry admission after resume; they do not bypass an approval.
Promoted jobs remain owned while waiting for exit rather than being reaped solely
because polling stopped.

Every session that is still running takes the notice at its next loop iteration: Desktop,
gateway, bot, headless daemon (`COWORK_HEADLESS=1`), scheduled and child-agent sessions
alike. After its turn finishes, a root conversation (Desktop, gateway, bot or a headless
client) takes the notice as a new turn. A child agent, an automation run and a CLI one-shot
run end with their turn, so their `process_output` note tells the agent to keep waiting
rather than finish. A notice for a task that has ended (completed child or automation run,
failed, cancelled) is recorded on the task's event log with the reason it was not
delivered, then dropped. Archived and external-runtime sessions and app shutdown get no
delivery. Running processes stop when the app exits. Already recorded completion notices
remain in the task journal and can be admitted on a later session lifecycle event.

## Child agent results

A child started with `spawn_agent` reports back the same way. When its orchestration node
reaches a terminal state, the parent receives an `agent_output` follow-up with the child's
task ID, status, a one-line error when it failed, and its bounded result summary. The parent
does not poll: `wait_for_agent` returns at once with `running` while the child works, and
waits only when given an explicit `timeout_seconds`, capped at 15 seconds. Because the parent
never blocks on the child, a user follow-up queued meanwhile is injected at the parent's next
iteration instead of waiting for the child to finish.
`spawn_agent` with `wait: true` still returns the result from the tool call and pushes no
event; children of `orchestrate_agents` are returned by that tool.

On macOS/Linux a single unambiguous command ending in ` &` uses the existing tracked
background path. The original command still passes through authorization before
the final operator is removed. Chaining, redirects, substitutions, shell wrappers,
escapes and ambiguous programs are not automatically converted. Explicit
`background: true` remains the general background interface.
