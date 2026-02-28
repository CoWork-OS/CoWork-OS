# X Mention Triggers

Use X mentions to create CoWork OS tasks from allowlisted accounts with a configurable command prefix (default: `do:`).

## What Ships

- **Bridge mode**: Bird CLI mention poller that creates tasks via shared hook ingress.
- **Native mode**: First-class `x` gateway channel adapter with mention ingestion and optional outbound posting.
- **Idempotency**: Every mention uses `sessionKey = xmention:<tweetId>` so duplicate polls/restarts do not create duplicate tasks.
- **Safe default**: No automatic X posting unless outbound is explicitly enabled on the native `x` channel.

## Desktop Setup

1. Open **Settings > X**.
2. Enable **X integration**.
3. Enable **Mention Trigger**.
4. Set:
   - `Command Prefix` (for example `do:`)
   - `Allowed Authors` (comma-separated handles, required)
   - `Poll Interval` and `Fetch Count`
5. Save and use **Test Connection**.
6. Watch runtime state in **Mention Trigger Runtime**:
   - mode (`bridge` / `native` / `disabled`)
   - running
   - last poll/success/error
   - accepted/ignored counters
   - last task id

## Headless Setup

- Configure X settings in secure settings storage (same schema as desktop).
- Ensure Bird CLI is installed and authenticated in the daemon environment.
- Start `coworkd` or headless app mode.
- Mention trigger lifecycle starts after gateway/daemon initialization and stops on shutdown.

## Trigger Format

- Prefix match is case-insensitive.
- Prefix is customizable by the user.
- Mention is accepted only when:
  - author is allowlisted
  - prefix exists in the mention text
  - non-empty command exists after prefix

Example:

- Tweet: `@YourAgent do: summarize this thread and draft a launch plan`
- Result: one task created in a temporary workspace from the extracted command payload.

## Native vs Bridge

- Bridge mode and native mode share the same parser + ingress semantics.
- When native `x` channel is enabled, bridge mode automatically pauses to avoid double ingest.
- Both paths emit comparable runtime telemetry and use the same idempotent `sessionKey`.

## Security Notes

- **Allowlist required**: Mention trigger should only run with explicit allowed handles.
- **Credential handling**:
  - Browser cookie extraction or manual `auth_token` + `ct0` are stored in secure settings.
  - Do not share tokens/cookies in logs or prompts.
- **Workspace isolation**: mention-triggered tasks run in temporary workspaces by default.

## Troubleshooting

### Bird CLI Missing

- Install Bird:
  - `brew install steipete/tap/bird`
  - or `npm install -g @steipete/bird`

### Auth Failures / Challenges

- Re-run **Test Connection** in Settings > X.
- Refresh browser cookies or re-enter manual tokens.
- If X account is challenged/rate-limited, mention polling stays alive and keeps reporting last error.

### Rate Limits

- Increase poll interval and lower fetch count.
- Keep allowlist small and avoid aggressive polling.

### Duplicates

- Duplicates are prevented by `hook_sessions(session_key PRIMARY KEY)`.
- Service restarts and repeated mention windows should map to the same task id per tweet id.
