# CoWork Pulse

CoWork Pulse is an explicitly opt-in, content-free analytics stream for one product question:

> How many installations reach value, and how many return to do useful work again?

Pulse is disabled by default. The consent choice is available during onboarding and under
**Settings → CoWork Pulse**. The CLI provides the same controls:

```sh
cowork telemetry status
cowork telemetry show
cowork telemetry on
cowork telemetry off
cowork telemetry send
cowork telemetry reset --yes
cowork telemetry delete --yes
```

`show` prints a queued package or a preview for the previous UTC day. A preview does not mean
that day has sufficient consent to send. The collector stores at most one row per profile/day;
the client can submit the same day more than once. See the delivery limitations below.

The separate `/v1/latest-version` update request is identifier-free and cached by the client for 24
hours. It includes only version, platform, architecture, and surface. It is suppressed in CI and
is reported as **Daily Update Checks**, never as unique users. If the Pulse service is unavailable,
CoWork falls back to GitHub for update information without blocking updates.

Example request shape:

`GET /v1/latest-version?version=0.5.52&platform=macos&arch=arm64&surface=desktop`

## Identity and consent

- The installation ID is a random UUID generated only after opt-in. It is scoped to the active
  CoWork profile and is not derived from hardware, hostname, account, or `.cowork-machine-id`.
  Explicit identity reset also creates an ID, even while collection is off.
- The server immediately converts the UUID to an HMAC pseudonym and never stores the raw UUID.
- Turning Pulse off closes the consent window and discards queued packages. Future flushes check
  consent; an already running request is not aborted by the current implementation.
  Re-enabling retains the UUID.
- Rotating the ID starts a new measurement identity and discards the old local deletion token;
  it does **not** delete old server records. Delete remote data before rotating if you want the
  previous identity removed. Keep an identity stable for retention measurement.
- Deleting remote data authenticates with the separate local deletion token. On success it removes
  that identity and its daily rows, clears local Pulse state, and disables collection. On failure
  local identity/consent remain intact so deletion can be retried. A non-identifying daily deletion
  counter remains on the server.

## Included

- Coarse client version, operating-system family, CPU family, and runtime family.
- Daily counts of root sessions/tasks started, completed, failed, cancelled, and useful outcomes.
- A coarse active-minutes bucket.
- Daily tool-use counts reduced to six closed categories.
- Counts of approval requests/denials and tool/LLM failures.

## Never included

Prompts, responses, file names or contents, commands, URLs, workspace/task/session IDs, custom tool
names, model/provider routes, account data, hostnames, raw errors, or precise activity timestamps.

The collector source, closed validation schema, D1 migration, retention job, and deployment guide
live in [`services/pulse-worker`](../services/pulse-worker). Daily installation rows are retained for
24 months. `/v1/admin/summary` returns aggregate reached-value and mature 7/30-day return cohorts
and is protected by a server-side admin token.

Requests necessarily pass through Cloudflare's HTTP edge, which may transiently process a source
IP for abuse prevention under Cloudflare's platform controls. Pulse application code never reads,
stores, exports, or exposes that IP, and there is no IP column in D1.

## Destination and storage

| Lane             | Destination                                                      | Storage and control                                                                            |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Usage Insights   | Local profile database                                           | Detailed local usage; enabling the dashboard is not Pulse consent                              |
| Update discovery | `https://pulse.coworkosapp.com/v1/latest-version`                | D1 daily request counts by version/platform/architecture/surface; independent of Pulse consent |
| CoWork Pulse     | `https://pulse.coworkosapp.com/v1/installations` and `/v1/daily` | Dedicated `cowork-pulse` Cloudflare Worker and D1 database                                     |
| Operator OTLP    | Operator-configured `runtime.telemetry.otlpEndpoint`             | Separate opt-in admin policy; retention belongs to that endpoint's operator                    |

Local `SecureSettingsRepository` category `pulse` encrypts the UUID, deletion token, consent, and
delivery status. `pulse_consent_windows` and `pulse_outbox` are ordinary tables in the profile's
SQLite database, not whole-file encrypted storage. The outbox contains the UUID and aggregate
payload but not the deletion token. `pulse-update-check.json` contains a release cache and check
timestamp, not task content.

D1 stores an HMAC of the profile UUID, a SHA-256 deletion-token hash, consent version, daily
aggregates, package IDs, first-active/value dates, and server receipt/update timestamps. The
content-free promise excludes precise **client activity** timestamps; server receipt times and
UTC day boundaries still exist. This is pseudonymous longitudinal data, not anonymous data.

The daily cleanup runs at **03:17 UTC**. Usage rows and update-check rows older than 24 months
are deleted. Installation rows with no remaining usage and no update for 730 days are removed.
Active installation metadata and aggregate deletion counters do not have a blanket 24-month
expiry. Deletion applies to the live database; this implementation does not purge Cloudflare
recovery snapshots or separate operator backups. Verify backup policy before promising physical
erasure from every recovery medium.

## API contract

| Method and path            | Authentication                                 | Result                                                         |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `GET /v1/status`           | Public                                         | Service/schema liveness; does not query D1                     |
| `GET /v1/schema`           | Public                                         | Human-readable collection summary, not a machine JSON Schema   |
| `GET /v1/latest-version`   | Public                                         | GitHub release metadata; accepts version/platform/arch/surface |
| `POST /v1/installations`   | Body contains random deletion token            | Enrolls profile; `202`                                         |
| `POST /v1/daily`           | `Authorization: PulseWrite <deletionToken>`    | First accepted row per profile/day; `202`                      |
| `DELETE /v1/installations` | `Authorization: PulseDeletion <deletionToken>` | JSON body `{ "installationId": "<uuid>" }`; `200`              |
| `GET /v1/admin/summary`    | `Authorization: Bearer <ADMIN_TOKEN>`          | Aggregate SQL summary; `401` without valid token               |

Enrollment body keys are `schemaVersion`, `installationId`, `deletionToken`, and `consentVersion`.
Schema version is `1`; consent version is `2026-09-04`. Daily payload fields are defined in
[`src/shared/pulse.ts`](../src/shared/pulse.ts), with independent server validation in
[`services/pulse-worker/src/index.ts`](../services/pulse-worker/src/index.ts). Unknown/missing
fields are rejected. Counters are integers in `0..100000`; request bodies are capped at 16 KiB.
Package IDs are SHA-256 of `<installationId>:<period.start>`. Never put tokens in URLs.

## Measurement definitions

| Metric                       | Current meaning                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Opted-in installations       | Enrolled profile identities still in D1, not all downloads, people, or devices; enrollment waits for an eligible flush                  |
| Sessions/tasks started       | Distinct local session keys and root task rows created during the UTC day; eval tasks excluded when the schema supplies the eval marker |
| Useful tasks                 | Completed root tasks whose terminal status is null, `ok`, or `partial_success`; a completion proxy, not user-confirmed value            |
| Active-minutes bucket        | Sum of completed root tasks' `last_run_duration_ms`, bucketed as `0`, `1-15`, `16-60`, `61-240`, `240+`; not foreground human time      |
| Reached value                | Server identity has a first accepted package with `usefulTasks > 0`                                                                     |
| 7/30-day return              | Any useful day 1–7 or 1–30 after first value, among identities old enough for that window; not exact day-7/day-30 retention             |
| `daily.active_installations` | Count of submitted daily rows, including zero-work days; label this **reporting profiles** in reports                                   |
| Daily Update Checks          | Requests counted by the update endpoint, not unique installations                                                                       |

Return rate is `returned_7d / mature_7d` (or the 30-day equivalents). Report an unavailable rate
for zero denominator. Empty-table SQL sums currently return `null`; do not present them as a
measured percentage. The summary includes recent daily rows and update counts for 30 days.
It returns counts, not an investor dashboard or a user listing.

Opt-in bias, older clients, offline use, deletion, multiple profiles, profile cloning, identity
rotation, and missing daily packages affect coverage. No opt-in count provides a denominator for
all installations. Public GitHub/npm adoption signals remain a separate measure. No dedicated
event currently measures how often consent was offered or declined.

## Delivery behavior and known limitations

- Desktop/daemon service checks after 30–300 seconds and every six hours; enabling requests a
  flush too. CLI `send` makes an explicit flush. A continuous consent window must cover the whole
  previous UTC day; first enrollment can therefore be delayed by more than a day.
- Each flush creates the previous-day package if absent and tries the oldest queued package.
  Requests time out after 10 seconds. Failed packages retain an attempt count for later retry.
  There is no historical backfill for days when no flush ran, nor a queue age/size cap.
- Success deletes the outbox row. A later flush can recreate and resend that day; D1 keeps the
  first row. There is no durable sent-day latch. Preview selects the newest queued row while
  transmission selects the oldest, so they can differ with a backlog.
- Consent changes and asynchronous delivery do not currently have a shared transaction or
  cancellation fence. Concurrent instances and disable/delete during delivery need regression
  coverage before claiming race-free immediate opt-out.
- First-active/value dates use first arrival, not the earliest date across late packages.
  Duplicate daily submissions still update installation metadata. Do not treat cohorts as
  audit-grade measurements until replay and out-of-order handling are hardened.
- LLM error counts query the whole profile's `llm_call_events`; they do not apply the root/eval
  task filter used for task counts. Tool classification is heuristic and uses closed categories.
- Update discovery skips Pulse in CI/tests and caches release metadata for 24 hours, with GitHub
  fallback after failure. The current update fetch has no explicit timeout. The Pulse aggregate
  service itself has no CI/test guard; keep test profiles opted out or use a local collector.
- `COWORK_PULSE_ENDPOINT` overrides enrollment/daily/deletion destinations, not the updater URL.
  It can send the profile identity and token to the configured destination; use only trusted
  collectors and disposable profiles for local tests.

Operator OTLP still sends allowlisted event names, exact event timestamps, and hashed task/event
correlation IDs. It excludes raw IDs, payload values, and payload keys. Those OTLP timestamps
are separate from Pulse's daily aggregate contract.

## Implementation map and release gate

- Client collection/storage: `src/electron/telemetry/pulse-service.ts`.
- Shared types: `src/shared/pulse.ts`; IPC wiring: `src/shared/types.ts`, preload and IPC handlers.
- Consent controls: `PulseSettingsPanel.tsx`, onboarding, `src/cli/main.ts` and `direct-run.ts`.
- Startup: Electron and daemon entrypoints; updater: `src/electron/updater/update-manager.ts`.
- Server/schema: `services/pulse-worker/src/index.ts` and `migrations/`.
- Separate operator export: `src/electron/telemetry/task-event-exporter.ts`.

The collector was deployed and verified on 2026-09-06. This does not mean a Pulse-enabled desktop
or npm release was published. Existing installations need that client version and explicit
consent. See the [production runbook](../services/pulse-worker/README.md) for deployment evidence,
admin access, maintenance, and checks still outstanding.
