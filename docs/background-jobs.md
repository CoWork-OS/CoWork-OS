# Tracked background jobs

Two consecutive `process_output` reads with no new output on a running job enable
completion delivery when its native, interactive root session can receive a later
turn. The tool reports `notify_on_complete: true` and tells the agent to stop
polling. Final output is bounded and redacted, and delivery waits for stdio to close.
Completion notices retain the current task conversation and are not treated as
new instructions from a different bot. Finished notices wait durably while the session
is paused or blocked and retry admission after resume; they do not bypass an approval.
Cancellation and app shutdown suppress completion.
Promoted jobs remain owned while waiting for exit rather than being reaped solely
because polling stopped.
Scheduled, headless, CLI one-shot, child-agent, archived and external-runtime
sessions keep ordinary polling behavior. Running processes stop when the app exits. Already recorded completion notices remain
in the task journal and can be admitted on a later session lifecycle event.

On macOS/Linux a single unambiguous command ending in ` &` uses the existing tracked
background path. The original command still passes through authorization before
the final operator is removed. Chaining, redirects, substitutions, shell wrappers,
escapes and ambiguous programs are not automatically converted. Explicit
`background: true` remains the general background interface.
