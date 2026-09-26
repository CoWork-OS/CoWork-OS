interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1Result<T>>>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledController {
  scheduledTime: number;
}

interface Env {
  DB: D1Database;
  INSTALLATION_HMAC_SECRET: string;
  ADMIN_TOKEN: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const DAY_MS = 86_400_000;
const MAX_BODY_BYTES = 16_384;
const MAX_COUNT = 100_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNT;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function installationKey(id: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
  const value = JSON.parse(text) as unknown;
  if (!record(value)) throw new Error("invalid_json_object");
  return value;
}

export function validateEnrollment(body: Record<string, unknown>): string | null {
  if (!exactKeys(body, ["schemaVersion", "installationId", "deletionToken", "consentVersion"]))
    return "unknown_or_missing_field";
  if (body.schemaVersion !== 1) return "unsupported_schema";
  if (typeof body.installationId !== "string" || !UUID.test(body.installationId))
    return "invalid_installation_id";
  if (
    typeof body.deletionToken !== "string" ||
    body.deletionToken.length < 40 ||
    body.deletionToken.length > 64
  )
    return "invalid_deletion_token";
  if (body.consentVersion !== "2026-09-04") return "unsupported_consent";
  return null;
}

export function validateDaily(body: Record<string, unknown>): string | null {
  if (
    !exactKeys(body, [
      "schemaVersion",
      "packageId",
      "installationId",
      "period",
      "client",
      "activity",
      "tools",
      "reliability",
    ])
  )
    return "unknown_or_missing_field";
  if (body.schemaVersion !== 1) return "unsupported_schema";
  if (typeof body.packageId !== "string" || !SHA256.test(body.packageId))
    return "invalid_package_id";
  if (typeof body.installationId !== "string" || !UUID.test(body.installationId))
    return "invalid_installation_id";
  if (!record(body.period) || !exactKeys(body.period, ["start", "end"])) return "invalid_period";
  const start = Date.parse(String(body.period.start));
  const end = Date.parse(String(body.period.end));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end - start !== DAY_MS ||
    start % DAY_MS !== 0
  )
    return "invalid_period";
  if (end > Date.now() + 5 * 60_000) return "future_period";

  if (
    !record(body.client) ||
    !exactKeys(body.client, ["version", "platform", "architecture", "runtime"])
  )
    return "invalid_client";
  if (
    typeof body.client.version !== "string" ||
    !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(body.client.version)
  )
    return "invalid_version";
  if (!["macos", "windows", "linux", "other"].includes(String(body.client.platform)))
    return "invalid_platform";
  if (!["arm64", "x64", "other"].includes(String(body.client.architecture)))
    return "invalid_architecture";
  if (!["desktop", "daemon", "cli"].includes(String(body.client.runtime))) return "invalid_runtime";

  if (
    !record(body.activity) ||
    !exactKeys(body.activity, [
      "sessionsStarted",
      "tasksStarted",
      "tasksCompleted",
      "usefulTasks",
      "activeMinutesBucket",
    ])
  )
    return "invalid_activity";
  for (const key of ["sessionsStarted", "tasksStarted", "tasksCompleted", "usefulTasks"])
    if (!boundedCount(body.activity[key])) return `invalid_${key}`;
  if (!["0", "1-15", "16-60", "61-240", "240+"].includes(String(body.activity.activeMinutesBucket)))
    return "invalid_active_minutes_bucket";

  if (
    !record(body.tools) ||
    !exactKeys(body.tools, ["shell", "filesystem", "browser", "connector", "code", "other"])
  )
    return "invalid_tools";
  for (const key of ["shell", "filesystem", "browser", "connector", "code", "other"])
    if (!boundedCount(body.tools[key])) return `invalid_tool_${key}`;

  if (
    !record(body.reliability) ||
    !exactKeys(body.reliability, [
      "failedTasks",
      "cancelledTasks",
      "approvalRequests",
      "approvalDenials",
      "toolErrors",
      "llmErrors",
    ])
  )
    return "invalid_reliability";
  for (const key of [
    "failedTasks",
    "cancelledTasks",
    "approvalRequests",
    "approvalDenials",
    "toolErrors",
    "llmErrors",
  ])
    if (!boundedCount(body.reliability[key])) return `invalid_${key}`;
  return null;
}

async function enroll(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const error = validateEnrollment(body);
  if (error) return json({ error }, 400);
  const key = await installationKey(String(body.installationId), env.INSTALLATION_HMAC_SECRET);
  const deletionHash = await digest(String(body.deletionToken));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO pulse_installations
     (installation_key, deletion_token_hash, consent_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(installation_key) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(key, deletionHash, body.consentVersion, now, now)
    .run();
  return json({ accepted: true }, 202);
}

async function daily(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const error = validateDaily(body);
  if (error) return json({ error }, 400);
  const period = body.period as Record<string, unknown>;
  if ((await digest(`${body.installationId}:${period.start}`)) !== body.packageId) {
    return json({ error: "invalid_package_id" }, 400);
  }
  const key = await installationKey(String(body.installationId), env.INSTALLATION_HMAC_SECRET);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("PulseWrite ")) return json({ error: "unauthorized" }, 401);
  const installation = await env.DB.prepare(
    "SELECT installation_key, deletion_token_hash FROM pulse_installations WHERE installation_key = ?",
  )
    .bind(key)
    .first<{ installation_key: string; deletion_token_hash: string }>();
  if (!installation) return json({ error: "installation_not_enrolled" }, 409);
  if (
    (await digest(authorization.slice("PulseWrite ".length))) !== installation.deletion_token_hash
  )
    return json({ error: "unauthorized" }, 401);
  const client = body.client as Record<string, unknown>;
  const activity = body.activity as Record<string, number | string>;
  const tools = body.tools as Record<string, number>;
  const reliability = body.reliability as Record<string, number>;
  const date = String(period.start).slice(0, 10);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pulse_daily_usage (
        installation_key, usage_date, package_id, received_at, client_version, platform, architecture, runtime,
        sessions_started, tasks_started, tasks_completed, useful_tasks, active_minutes_bucket,
        tool_shell, tool_filesystem, tool_browser, tool_connector, tool_code, tool_other,
        failed_tasks, cancelled_tasks, approval_requests, approval_denials, tool_errors, llm_errors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_key, usage_date) DO NOTHING`,
    ).bind(
      key,
      date,
      body.packageId,
      now,
      client.version,
      client.platform,
      client.architecture,
      client.runtime,
      activity.sessionsStarted,
      activity.tasksStarted,
      activity.tasksCompleted,
      activity.usefulTasks,
      activity.activeMinutesBucket,
      tools.shell,
      tools.filesystem,
      tools.browser,
      tools.connector,
      tools.code,
      tools.other,
      reliability.failedTasks,
      reliability.cancelledTasks,
      reliability.approvalRequests,
      reliability.approvalDenials,
      reliability.toolErrors,
      reliability.llmErrors,
    ),
    env.DB.prepare(
      `UPDATE pulse_installations SET updated_at = ?,
       first_active_date = COALESCE(first_active_date, ?),
       first_value_date = CASE WHEN first_value_date IS NULL AND ? > 0 THEN ? ELSE first_value_date END
       WHERE installation_key = ?`,
    ).bind(now, date, activity.usefulTasks, date, key),
  ]);
  return json({ accepted: true }, 202);
}

async function removeInstallation(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!exactKeys(body, ["installationId"]) || typeof body.installationId !== "string")
    return json({ error: "invalid_installation_id" }, 400);
  const id = body.installationId;
  if (!UUID.test(id)) return json({ error: "invalid_installation_id" }, 400);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("PulseDeletion ")) return json({ error: "unauthorized" }, 401);
  const token = authorization.slice("PulseDeletion ".length);
  const key = await installationKey(id, env.INSTALLATION_HMAC_SECRET);
  const row = await env.DB.prepare(
    "SELECT deletion_token_hash FROM pulse_installations WHERE installation_key = ?",
  )
    .bind(key)
    .first<{ deletion_token_hash: string }>();
  if (!row) return json({ deleted: true });
  if ((await digest(token)) !== row.deletion_token_hash)
    return json({ error: "unauthorized" }, 401);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pulse_daily_usage WHERE installation_key = ?").bind(key),
    env.DB.prepare("DELETE FROM pulse_installations WHERE installation_key = ?").bind(key),
    env.DB.prepare(
      `INSERT INTO pulse_deletion_totals (deletion_date, deletion_count) VALUES (?, 1)
       ON CONFLICT(deletion_date) DO UPDATE SET deletion_count = deletion_count + 1`,
    ).bind(new Date().toISOString().slice(0, 10)),
  ]);
  return json({ deleted: true });
}

async function summary(request: Request, env: Env): Promise<Response> {
  // Reject when the secret is unset rather than comparing against the string
  // "Bearer undefined", which an unconfigured deployment would accept from
  // anyone sending exactly that header.
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) return json({ error: "unauthorized" }, 401);
  const presented = request.headers.get("authorization") || "";
  if (!presented.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  // Compare digests so the check does not short-circuit on the first differing
  // byte of the token.
  const [presentedDigest, expectedDigest] = await Promise.all([
    digest(presented.slice("Bearer ".length)),
    digest(adminToken),
  ]);
  if (presentedDigest !== expectedDigest) return json({ error: "unauthorized" }, 401);
  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS opted_in_installations,
       SUM(CASE WHEN first_value_date IS NOT NULL THEN 1 ELSE 0 END) AS reached_value_installations
     FROM pulse_installations`,
  ).first();
  const retention = await env.DB.prepare(
    `WITH value_cohorts AS (
       SELECT installation_key, first_value_date FROM pulse_installations WHERE first_value_date IS NOT NULL
     )
     SELECT
       COUNT(*) AS reached_value,
       SUM(CASE WHEN v.first_value_date <= date('now', '-7 day') THEN 1 ELSE 0 END) AS mature_7d,
       SUM(CASE WHEN v.first_value_date <= date('now', '-7 day') AND EXISTS (
         SELECT 1 FROM pulse_daily_usage d WHERE d.installation_key = v.installation_key
         AND d.useful_tasks > 0 AND julianday(d.usage_date) - julianday(v.first_value_date) BETWEEN 1 AND 7
       ) THEN 1 ELSE 0 END) AS returned_7d,
       SUM(CASE WHEN v.first_value_date <= date('now', '-30 day') THEN 1 ELSE 0 END) AS mature_30d,
       SUM(CASE WHEN v.first_value_date <= date('now', '-30 day') AND EXISTS (
         SELECT 1 FROM pulse_daily_usage d WHERE d.installation_key = v.installation_key
         AND d.useful_tasks > 0 AND julianday(d.usage_date) - julianday(v.first_value_date) BETWEEN 1 AND 30
       ) THEN 1 ELSE 0 END) AS returned_30d
     FROM value_cohorts v`,
  ).first();
  const recent = await env.DB.prepare(
    `SELECT usage_date, COUNT(*) AS active_installations,
       SUM(CASE WHEN useful_tasks > 0 THEN 1 ELSE 0 END) AS value_installations,
       SUM(useful_tasks) AS useful_tasks
     FROM pulse_daily_usage WHERE usage_date >= date('now', '-30 day')
     GROUP BY usage_date ORDER BY usage_date`,
  ).all();
  const updateChecks = await env.DB.prepare(
    `SELECT check_date, SUM(check_count) AS daily_update_checks
     FROM pulse_update_checks WHERE check_date >= date('now', '-30 day')
     GROUP BY check_date ORDER BY check_date`,
  ).all();
  return json({
    generatedAt: new Date().toISOString(),
    totals,
    retention,
    daily: recent.results || [],
    updateChecks: updateChecks.results || [],
  });
}

async function latestVersion(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const version = url.searchParams.get("version") || "";
  const platform = url.searchParams.get("platform") || "";
  const architecture = url.searchParams.get("arch") || "";
  const surface = url.searchParams.get("surface") || "";
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version))
    return json({ error: "invalid_version" }, 400);
  if (!["macos", "windows", "linux", "other"].includes(platform))
    return json({ error: "invalid_platform" }, 400);
  if (!["arm64", "x64", "other"].includes(architecture))
    return json({ error: "invalid_architecture" }, 400);
  if (!["desktop", "daemon", "cli"].includes(surface))
    return json({ error: "invalid_surface" }, 400);
  await env.DB.prepare(
    `INSERT INTO pulse_update_checks
     (check_date, client_version, platform, architecture, surface, check_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(check_date, client_version, platform, architecture, surface)
     DO UPDATE SET check_count = check_count + 1`,
  )
    .bind(new Date().toISOString().slice(0, 10), version, platform, architecture, surface)
    .run();

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request("https://pulse.coworkosapp.com/.internal/github-latest");
  let release = await cache.match(cacheKey);
  if (!release) {
    const upstream = await fetch(
      "https://api.github.com/repos/CoWork-OS/CoWork-OS/releases/latest",
      {
        headers: {
          accept: "application/vnd.github.v3+json",
          "user-agent": "CoWork-Pulse-Updater",
        },
      },
    );
    if (!upstream.ok) return json({ error: "upstream_unavailable" }, 503);
    release = new Response(await upstream.text(), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=900" },
    });
    await cache.put(cacheKey, release.clone());
  }
  const body = (await release.json()) as Record<string, unknown>;
  return json({
    tag_name: body.tag_name,
    name: body.name,
    body: body.body,
    html_url: body.html_url,
    published_at: body.published_at,
    assets: Array.isArray(body.assets)
      ? body.assets.map((asset) => {
          const value = asset as Record<string, unknown>;
          return {
            name: value.name,
            browser_download_url: value.browser_download_url,
            size: value.size,
          };
        })
      : [],
  });
}

const schema = {
  name: "CoWork Pulse",
  version: 1,
  cadence:
    "One daily aggregate record per installation per fully consented UTC day; retried deliveries of the same package are deduplicated",
  anonymousUpdateCheck: "Version, platform, architecture, and surface; no identifier",
  identity: "Random profile-scoped UUID; server stores only an HMAC pseudonym",
  includes: [
    "coarse client dimensions",
    "task/session outcome counts",
    "bounded tool categories",
    "reliability counts",
  ],
  excludes: [
    "prompts",
    "responses",
    "file names or contents",
    "commands",
    "URLs",
    "workspace/task/session IDs",
    "custom tool names",
    "model/provider routes",
    "account data",
    "hostnames",
    "raw errors",
  ],
  retention: "Daily installation rows: 24 months",
  deletion: "Self-service authenticated deletion from the app or CLI",
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/status")
    return json({ ok: true, service: "cowork-pulse", schemaVersion: 1 });
  if (request.method === "GET" && url.pathname === "/v1/schema") return json(schema);
  if (request.method === "GET" && url.pathname === "/v1/latest-version")
    return latestVersion(request, env);
  if (request.method === "GET" && url.pathname === "/v1/admin/summary")
    return summary(request, env);
  if (request.method === "POST" && url.pathname === "/v1/installations")
    return enroll(request, env);
  if (request.method === "POST" && url.pathname === "/v1/daily") return daily(request, env);
  if (request.method === "DELETE" && url.pathname === "/v1/installations")
    return removeInstallation(request, env);
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      if (code === "body_too_large") return json({ error: code }, 413);
      if (code.startsWith("invalid_") || error instanceof SyntaxError)
        return json({ error: "invalid_json" }, 400);
      return json({ error: "internal_error" }, 500);
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare(
          "DELETE FROM pulse_daily_usage WHERE usage_date < date('now', '-24 months')",
        ),
        env.DB.prepare(
          "DELETE FROM pulse_update_checks WHERE check_date < date('now', '-24 months')",
        ),
        env.DB.prepare(
          "DELETE FROM pulse_installations WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM pulse_daily_usage d WHERE d.installation_key = pulse_installations.installation_key)",
        ).bind(Date.now() - 730 * DAY_MS),
      ]).then(() => undefined),
    );
  },
};
