# CoWork Pulse collector

Dedicated Cloudflare Worker and D1 database for the explicitly opt-in, content-free Pulse stream.
It is intentionally separate from the `coworkosapp.com` website Worker and website analytics.

## Production deployment record

Deployed on **2026-09-06**. These identifiers describe that deployment; recheck live state before
maintenance. No application secret values belong in this repository.

| Resource                | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| Host                    | `https://pulse.coworkosapp.com`                        |
| Cloudflare account      | `def4882e76a023b7f9a194207024bf8e`                     |
| Zone                    | `coworkosapp.com` (`774e3cb3ab00d796d7a9d655ff1e4bac`) |
| DNS                     | Proxied CNAME `pulse` → `coworkosapp.com`, Auto TTL    |
| Worker / route          | `cowork-pulse` / `pulse.coworkosapp.com/*`             |
| D1 / binding            | `cowork-pulse` / `DB`                                  |
| D1 ID / creation region | `6ecad471-3b8b-4d85-9ba0-24689188d295` / EEUR          |
| Worker version          | `dc487b84-0629-4c90-b758-81a7f20f66cd`                 |
| Applied migrations      | `0001_pulse.sql`, `0002_update_checks.sql`             |
| Retention schedule      | `17 3 * * *` (03:17 UTC daily)                         |
| Worker observability    | Disabled in configuration                              |

Production verification on 2026-09-06 returned:

- `/v1/status`: HTTP 200, `{ "ok": true, "service": "cowork-pulse", "schemaVersion": 1 }`.
- `/v1/schema`: HTTP 200 with the collection summary.
- `/v1/admin/summary`: HTTP 401 without credentials; HTTP 200 with the admin token and an
  empty database summary. This check exercises D1; `/v1/status` alone does not.

Earlier HTTP 522 responses came from the DNS record existing before Worker deployment. OAuth
expired while the Mac was locked; a fresh Wrangler login completed the deployment. Do not repeat
database creation or regenerate the HMAC secret when resuming an interrupted deployment.

The application implementation has not been published as a client release by this deployment.
The live enrollment/daily/deletion sequence, scheduled cleanup, and update proxy were not exercised
by this production verification. Local smoke checks covered enrollment, daily ingestion, admin
summary, and deletion before deployment. No synthetic usage was inserted into production.

## First-time deployment to a new environment

For the existing production environment, use **Redeploy** below. For a new environment, use a
distinct Worker/database/hostname and inspect existing resources before creating any.

```sh
cd services/pulse-worker
npx wrangler whoami
# If signed out: npx wrangler login, complete browser authorization, then recheck whoami.
npx wrangler d1 list
npx wrangler d1 create cowork-pulse
cp wrangler.example.jsonc wrangler.jsonc
# Put the returned database_id in wrangler.jsonc.
npx wrangler secret put INSTALLATION_HMAC_SECRET --config wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
npx wrangler d1 migrations apply cowork-pulse --remote --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
curl https://pulse.coworkosapp.com/v1/status
curl https://pulse.coworkosapp.com/v1/schema
```

Before deploying the route, add a proxied DNS record for `pulse.coworkosapp.com` in the
`coworkosapp.com` Cloudflare zone (a CNAME to the apex is sufficient for a Worker route). The
existing `cowork-os-web` website Worker and this Worker remain separate services. Wrangler OAuth
may permit zone reads/Worker routes without DNS record editing; use the authenticated Cloudflare
DNS dashboard if DNS API permission is unavailable. Inspect the exact hostname before adding it.

Generate both secrets with a password generator (at least 32 random bytes). Never reuse either
secret. `INSTALLATION_HMAC_SECRET` pseudonymizes installation UUIDs before D1 storage;
`ADMIN_TOKEN` protects `/v1/admin/summary`.

Cloudflare rate limiting should be attached to both POST endpoints. Recommended starting limits are
10 requests per minute per IP for enrollment and 30 requests per minute per IP for daily packages.
The Worker independently enforces a 16 KiB body limit, strict schemas, bounded counts, idempotent
daily rows, a 24-month retention job, and authenticated self-deletion.

The recommended Cloudflare rate-limit rules were **not configured or verified** during this
deployment. Application validation does not authenticate software provenance: fabricated
installations and bounded fabricated counts remain possible. Account/plan limits and abuse
controls need review before broad client rollout.

## Credentials and recovery

- `INSTALLATION_HMAC_SECRET`: stable pseudonymization key. Changing it disconnects existing
  profiles from their rows and breaks their ability to delete those rows using the old identity.
  Preserve it through normal deployments; rotation requires a designed migration.
- `ADMIN_TOKEN`: bearer access to aggregate reports. Rotate independently after exposure or
  operator-access changes. Never put it in a browser URL, renderer, distributed app, or git.
- Client deletion tokens are unrelated to these server secrets; they authenticate an individual
  profile's writes and deletion. D1 stores their hashes.

Deployment generated fresh 32-byte random secrets, uploaded both to Cloudflare, and retained a
JSON recovery copy at `$HOME/.config/cowork-pulse/production-secrets.json` on the deploying Mac
(`/Users/almarionai/.config/cowork-pulse/production-secrets.json` in this setup). Directory mode is
`0700`, file mode `0600`; this is permission-protected plaintext, not Keychain encryption. Keep
an encrypted operator backup/password-manager copy. Do not paste its contents into chat or docs.
The interrupted secret from the earlier deployment attempt was not reused.

The machine-specific `wrangler.jsonc` is gitignored. Reconstruct it from `wrangler.example.jsonc`
using the existing D1 ID above when recovering this checkout. Wrangler OAuth credentials are
managed by Wrangler separately; use `wrangler login` for renewal rather than manually consuming
or copying refresh tokens.

## Redeploy and verify

From `services/pulse-worker`, with the existing local config and valid authorization:

```sh
npx wrangler whoami
npx wrangler secret list --config wrangler.jsonc
npx wrangler d1 migrations list cowork-pulse --remote --config wrangler.jsonc
npx wrangler deploy --dry-run --config wrangler.jsonc
# Apply only pending migrations, after reviewing them and the recovery plan.
npx wrangler d1 migrations apply cowork-pulse --remote --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
curl --fail-with-body --max-time 20 https://pulse.coworkosapp.com/v1/status
curl --fail-with-body --max-time 20 https://pulse.coworkosapp.com/v1/schema
```

Verify the expected service/schema body, not only HTTP 200. Confirm the displayed Worker route
and D1 binding. List secrets by name only; do not overwrite them on every deploy.

To read the production summary using the local recovery file without printing the token:

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const { ADMIN_TOKEN } = JSON.parse(readFileSync(
  join(homedir(), '.config/cowork-pulse/production-secrets.json'), 'utf8'));
const response = await fetch('https://pulse.coworkosapp.com/v1/admin/summary', {
  headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Pulse HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
JS
```

This is an API report, not a browser dashboard. Use the [metric definitions](../../docs/cowork-pulse.md#measurement-definitions)
when interpreting results. Zero rows can produce SQL `null` sums. Do not count reporting rows
as useful-work users or update requests as unique installations.

## Maintenance and troubleshooting

| Symptom                       | Check / action                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| HTTP 522                      | Confirm proxied DNS and the exact Worker route; an origin response may mean no matching Worker route         |
| Status 200, admin 500         | Verify D1 binding, applied migrations, and deployed code; status does not test storage                       |
| Admin 401                     | Load the correct admin token, not a client deletion token                                                    |
| Daily 409                     | Profile is not enrolled under the current HMAC key; client marks enrollment for retry                        |
| Daily 401                     | Check the profile's write token; do not rotate the HMAC secret as a troubleshooting shortcut                 |
| No usage after opting in      | Wait for a fully consented UTC day and flush; inspect CLI status/show, profile selection, and client version |
| OAuth timeout / invalid grant | Run a fresh Wrangler login with the Mac unlocked and finish the current browser flow                         |

Use `npx wrangler deployments list --config wrangler.jsonc` to inspect deployments. Before a
rollback, identify a known-good version and check database compatibility; Worker rollback does
not reverse migrations. Preserve the HMAC key together with an encrypted D1 backup. A database
restore can resurrect deleted rows; deletion reconciliation must be planned before restoring
production. No automatic backup/export or deletion-reconciliation workflow was added here.

Daily row retention is 24 months; active installation metadata and deletion totals follow the
different rules documented in [CoWork Pulse](../../docs/cowork-pulse.md#destination-and-storage).
Cloudflare recovery snapshots are not explicitly purged by application deletion.

For future code changes, run the focused collector/client tests from the repository root:

```sh
npx vitest run src/electron/telemetry/__tests__/pulse-service.test.ts src/electron/telemetry/__tests__/pulse-worker-schema.test.ts src/electron/telemetry/__tests__/task-event-exporter.test.ts src/electron/updater/__tests__/update-manager-platform.test.ts
```

The existing 11-test focused pass covers schema/category/export/updater behavior; it does not
establish crash-safe daily latching, concurrency-safe consent, offline backfill, or complete
retention correctness. See the [known limitations](../../docs/cowork-pulse.md#delivery-behavior-and-known-limitations)
before treating these numbers as investor-grade evidence.
