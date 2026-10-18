# Editable queued inputs

Desktop shows editable inputs above the composer while an initial task or a human
follow-up is still queued. Editing uses the server's message identity and revision;
once incorporation starts, the edit is refused and the local edit remains available
to copy into a new message. Attachments and quoted context stay attached to the same
input. Follow-ups already serve as steering at the executor's next safe boundary.
Messages with prepared annotation context and messages from agents are not editable.
Follow-up edits are limited to 60,000 characters so the full text fits in the durable
recovery receipt; truncated receipt previews are not offered for editing.
These controls currently apply to local Desktop sessions.

The durable user-message receipt owns edited text. Recovery reconciles an older
runtime snapshot against that receipt only for complete, explicitly edited text. An
unedited or truncated timeline preview never replaces full checkpoint text. The renderer does not move text into the
main composer to edit it, so an unrelated unsent draft stays intact.

## Acceptance

`node scripts/qa/queued-input-runtime-acceptance.mjs` launches its own temporary `npm run dev`
profile and a fixture provider bound explicitly to `127.0.0.1`. It checks actual
Desktop IPC admission, stale-edit refusal, inline editing and the final provider
payload. Evidence is retained in the printed temporary profile folder. The runner
closes only its own test processes. Run it with desktop access and no other
development instance using the same Electron bundle.
