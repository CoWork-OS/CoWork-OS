import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  DEFAULT_PULSE_ENDPOINT,
  PULSE_CONSENT_VERSION,
  PULSE_SCHEMA_VERSION,
  type PulseDailyPackage,
  type PulseMutationResult,
  type PulsePublicSettings,
  type PulseToolCounts,
} from "../../shared/pulse";
import { isBlockedInternalHost } from "../security/address-classes";
import { createLogger } from "../utils/logger";

const log = createLogger("PulseService");

interface PulsePrivateSettings {
  consentState: "unset" | "enabled" | "disabled";
  installationId?: string;
  deletionToken?: string;
  endpoint?: string;
  enabledAt?: number;
  disabledAt?: number;
  lastSentAt?: number;
  lastAttemptAt?: number;
  lastErrorCode?: string;
  enrolled?: boolean;
}

interface PulseServiceOptions {
  version: string;
  runtime: "desktop" | "daemon" | "cli";
  fetch?: typeof fetch;
  now?: () => number;
}

const MAX_COUNT = 100_000;
const DAY_MS = 86_400_000;

function clampCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value || 0);
  return Math.max(0, Math.min(MAX_COUNT, Math.round(Number.isFinite(number) ? number : 0)));
}

function utcDayBounds(now: number): { start: number; end: number } {
  const endDate = new Date(now);
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return { start: end - DAY_MS, end };
}

function platform(): PulseDailyPackage["client"]["platform"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "other";
}

function architecture(): PulseDailyPackage["client"]["architecture"] {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return "other";
}

function activeMinutesBucket(
  milliseconds: number,
): PulseDailyPackage["activity"]["activeMinutesBucket"] {
  const minutes = milliseconds / 60_000;
  if (minutes <= 0) return "0";
  if (minutes <= 15) return "1-15";
  if (minutes <= 60) return "16-60";
  if (minutes <= 240) return "61-240";
  return "240+";
}

/**
 * Whether the user has explicitly opted into Pulse.
 *
 * Exported separately from the service because callers outside the telemetry
 * path need the consent answer without a Database handle — notably the updater,
 * which must not contact the Pulse collector for a user who declined. Any code
 * that talks to a Pulse endpoint has to pass this gate first.
 *
 * Fails closed: an uninitialized settings repository or an unreadable record
 * counts as "no consent".
 */
export function isPulseConsentGranted(): boolean {
  try {
    return (
      SecureSettingsRepository.getInstance().load<PulsePrivateSettings>("pulse")?.consentState ===
      "enabled"
    );
  } catch {
    return false;
  }
}

export function categorizePulseTool(name: string): keyof PulseToolCounts {
  const value = name.toLowerCase();
  if (/shell|exec|terminal|command/.test(value)) return "shell";
  if (/file|read|write|patch|directory|glob|search_files/.test(value)) return "filesystem";
  if (/browser|playwright|web_|navigate|screenshot/.test(value)) return "browser";
  if (/connector|mcp|slack|linear|github|gmail|drive|notion/.test(value)) return "connector";
  if (/code|git|test|lint|build/.test(value)) return "code";
  return "other";
}

export class PulseService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Short-lived memo for the preview package. buildPackage runs a
   * `PRAGMA table_info` plus aggregates over tasks, task_events and
   * llm_call_events; getSettings is called on every settings render and on
   * onboarding mount, and none of those need a freshly recomputed preview.
   */
  private previewCache: {
    builtAt: number;
    installationId: string;
    value: PulseDailyPackage;
  } | null = null;
  private static readonly PREVIEW_TTL_MS = 60_000;

  constructor(
    private readonly db: Database.Database,
    private readonly options: PulseServiceOptions,
  ) {
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || Date.now;
    this.ensureSchema();
  }

  start(): void {
    const jitter = 30_000 + Math.floor(Math.random() * 270_000);
    // Tracked so stop() can cancel it: an untracked first flush keeps firing
    // after shutdown and runs against a database that may already be closing.
    this.firstFlushTimer = setTimeout(() => {
      this.firstFlushTimer = null;
      void this.flushSafely();
    }, jitter);
    this.firstFlushTimer.unref?.();
    this.timer = setInterval(() => void this.flushSafely(), 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstFlushTimer) clearTimeout(this.firstFlushTimer);
    this.firstFlushTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSettings(): PulsePublicSettings {
    const settings = this.loadSettings();
    return this.toPublic(settings);
  }

  getPreview(): PulseDailyPackage | null {
    const settings = this.loadSettings();
    if (settings.consentState !== "enabled" || !settings.installationId) return null;
    return this.buildPackage(settings.installationId);
  }

  async setEnabled(enabled: boolean): Promise<PulseMutationResult> {
    const settings = this.loadSettings();
    if ((settings.consentState === "enabled") === enabled && settings.consentState !== "unset") {
      return { success: true, settings: this.toPublic(settings) };
    }
    const now = this.now();
    if (enabled) {
      settings.consentState = "enabled";
      settings.installationId ||= randomUUID();
      settings.deletionToken ||= randomBytes(32).toString("base64url");
      settings.enabledAt = now;
      settings.disabledAt = undefined;
      this.db.prepare("INSERT INTO pulse_consent_windows (started_at) VALUES (?)").run(now);
    } else {
      settings.consentState = "disabled";
      settings.disabledAt = now;
      this.db
        .prepare("UPDATE pulse_consent_windows SET ended_at = ? WHERE ended_at IS NULL")
        .run(now);
      // Disabling is an immediate stop: do not retain an unsent package for a
      // later re-enable decision.
      this.db.prepare("DELETE FROM pulse_outbox").run();
    }
    this.previewCache = null;
    this.saveSettings(settings);
    if (enabled) void this.flushSafely();
    return { success: true, settings: this.toPublic(settings) };
  }

  async resetIdentity(): Promise<PulseMutationResult> {
    const settings = this.loadSettings();
    settings.installationId = randomUUID();
    settings.deletionToken = randomBytes(32).toString("base64url");
    settings.enrolled = false;
    settings.lastSentAt = undefined;
    settings.lastAttemptAt = undefined;
    settings.lastErrorCode = undefined;
    this.db.prepare("DELETE FROM pulse_outbox").run();
    this.previewCache = null;
    this.saveSettings(settings);
    return { success: true, settings: this.toPublic(settings) };
  }

  async deleteRemoteData(): Promise<PulseMutationResult> {
    const settings = this.loadSettings();
    if (settings.installationId && settings.deletionToken) {
      try {
        const response = await this.fetchImpl(`${this.endpoint(settings)}/v1/installations`, {
          method: "DELETE",
          headers: {
            Authorization: `PulseDeletion ${settings.deletionToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ installationId: settings.installationId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`http_${response.status}`);
        }
      } catch (error) {
        return { success: false, settings: this.toPublic(settings), error: this.errorCode(error) };
      }
    }
    this.db.prepare("DELETE FROM pulse_outbox").run();
    this.db.prepare("DELETE FROM pulse_consent_windows").run();
    this.previewCache = null;
    const cleared: PulsePrivateSettings = { consentState: "disabled", disabledAt: this.now() };
    this.saveSettings(cleared);
    return { success: true, settings: this.toPublic(cleared) };
  }

  /**
   * Timer-driven flush. `flush` can throw before its own try/catch (loading
   * settings, building the package, writing the outbox) — e.g. against a
   * database that is closing during shutdown — and a bare `void this.flush()`
   * would surface that as an unhandled rejection.
   */
  private async flushSafely(): Promise<void> {
    try {
      await this.flush();
    } catch (error) {
      log.warn(`Scheduled flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async flush(): Promise<void> {
    const settings = this.loadSettings();
    if (settings.consentState !== "enabled" || !settings.installationId || !settings.deletionToken)
      return;
    if (!this.hasFullDayConsent()) return;
    const pulsePackage = this.buildPackage(settings.installationId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pulse_outbox
       (package_id, period_start, payload_json, created_at, attempt_count)
       VALUES (?, ?, ?, ?, 0)`,
      )
      .run(
        pulsePackage.packageId,
        pulsePackage.period.start,
        JSON.stringify(pulsePackage),
        this.now(),
      );
    const pending = this.db
      .prepare("SELECT package_id, payload_json FROM pulse_outbox ORDER BY period_start LIMIT 1")
      .get() as { package_id: string; payload_json: string };
    const pendingPackage = JSON.parse(pending.payload_json) as PulseDailyPackage;

    try {
      if (!settings.enrolled) {
        const enrolled = await this.fetchImpl(`${this.endpoint(settings)}/v1/installations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: PULSE_SCHEMA_VERSION,
            installationId: settings.installationId,
            deletionToken: settings.deletionToken,
            consentVersion: PULSE_CONSENT_VERSION,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!enrolled.ok && enrolled.status !== 409) throw new Error(`http_${enrolled.status}`);
        settings.enrolled = true;
      }
      const response = await this.fetchImpl(`${this.endpoint(settings)}/v1/daily`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `PulseWrite ${settings.deletionToken}`,
        },
        body: JSON.stringify(pendingPackage),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      settings.lastSentAt = this.now();
      settings.lastErrorCode = undefined;
      this.db.prepare("DELETE FROM pulse_outbox WHERE package_id = ?").run(pending.package_id);
    } catch (error) {
      settings.lastErrorCode = this.errorCode(error);
      if (settings.lastErrorCode === "http_409") settings.enrolled = false;
      this.db
        .prepare("UPDATE pulse_outbox SET attempt_count = attempt_count + 1 WHERE package_id = ?")
        .run(pending.package_id);
    }
    settings.lastAttemptAt = this.now();
    this.saveSettings(settings);
  }

  private buildPackage(installationId: string): PulseDailyPackage {
    const { start, end } = utcDayBounds(this.now());
    const taskColumns = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const rootClause = taskColumns.has("parent_task_id") ? "AND parent_task_id IS NULL" : "";
    const evalClause = taskColumns.has("eval_case_id") ? "AND eval_case_id IS NULL" : "";
    const sessionExpr = taskColumns.has("session_id") ? "COALESCE(session_id, id)" : "id";
    const created = this.db
      .prepare(
        `SELECT COUNT(*) AS tasks_started, COUNT(DISTINCT ${sessionExpr}) AS sessions_started
       FROM tasks WHERE created_at >= ? AND created_at < ? ${rootClause} ${evalClause}`,
      )
      .get(start, end) as Record<string, number>;
    const terminal = this.db
      .prepare(
        `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS tasks_completed,
         SUM(CASE WHEN status = 'completed' AND (terminal_status IS NULL OR terminal_status IN ('ok','partial_success')) THEN 1 ELSE 0 END) AS useful_tasks,
         SUM(CASE WHEN status = 'failed' OR terminal_status = 'failed' THEN 1 ELSE 0 END) AS failed_tasks,
         SUM(CASE WHEN status = 'cancelled' OR terminal_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_tasks,
         SUM(CASE WHEN status = 'completed' THEN COALESCE(last_run_duration_ms, 0) ELSE 0 END) AS active_ms
       FROM tasks WHERE completed_at >= ? AND completed_at < ? ${rootClause} ${evalClause}`,
      )
      .get(start, end) as Record<string, number>;

    const tools: PulseToolCounts = {
      shell: 0,
      filesystem: 0,
      browser: 0,
      connector: 0,
      code: 0,
      other: 0,
    };
    const eventRows = this.db
      .prepare(
        `SELECT e.type, e.legacy_type, e.payload FROM task_events e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.timestamp >= ? AND e.timestamp < ?
       ${taskColumns.has("parent_task_id") ? "AND (t.parent_task_id IS NULL OR t.id IS NULL)" : ""}
       ${taskColumns.has("eval_case_id") ? "AND (t.eval_case_id IS NULL OR t.id IS NULL)" : ""}
       AND COALESCE(e.type, e.legacy_type) IN ('tool_call','tool_error','approval_requested','approval_denied')`,
      )
      .all(start, end) as Array<{ type: string; legacy_type?: string; payload: string }>;
    let toolErrors = 0;
    let approvalRequests = 0;
    let approvalDenials = 0;
    for (const row of eventRows) {
      const type = row.type || row.legacy_type;
      if (type === "tool_error") toolErrors++;
      if (type === "approval_requested") approvalRequests++;
      if (type === "approval_denied") approvalDenials++;
      if (type !== "tool_call") continue;
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const name = String(
          payload.toolName || payload.tool_name || payload.tool || payload.name || "",
        );
        tools[categorizePulseTool(name)]++;
      } catch {
        tools.other++;
      }
    }
    const llm = this.db
      .prepare(
        "SELECT COUNT(*) AS errors FROM llm_call_events WHERE timestamp >= ? AND timestamp < ? AND success = 0",
      )
      .get(start, end) as { errors: number };
    for (const key of Object.keys(tools) as Array<keyof PulseToolCounts>)
      tools[key] = clampCount(tools[key]);

    const startIso = new Date(start).toISOString();
    return {
      schemaVersion: PULSE_SCHEMA_VERSION,
      packageId: createHash("sha256").update(`${installationId}:${startIso}`).digest("hex"),
      installationId,
      period: { start: startIso, end: new Date(end).toISOString() },
      client: {
        version: this.options.version,
        platform: platform(),
        architecture: architecture(),
        runtime: this.options.runtime,
      },
      activity: {
        sessionsStarted: clampCount(created.sessions_started),
        tasksStarted: clampCount(created.tasks_started),
        tasksCompleted: clampCount(terminal.tasks_completed),
        usefulTasks: clampCount(terminal.useful_tasks),
        activeMinutesBucket: activeMinutesBucket(Number(terminal.active_ms || 0)),
      },
      tools,
      reliability: {
        failedTasks: clampCount(terminal.failed_tasks),
        cancelledTasks: clampCount(terminal.cancelled_tasks),
        approvalRequests: clampCount(approvalRequests),
        approvalDenials: clampCount(approvalDenials),
        toolErrors: clampCount(toolErrors),
        llmErrors: clampCount(llm.errors),
      },
    };
  }

  private hasFullDayConsent(): boolean {
    const { start, end } = utcDayBounds(this.now());
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pulse_consent_windows WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1",
        )
        .get(start, end),
    );
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pulse_consent_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pulse_outbox (
        package_id TEXT PRIMARY KEY,
        period_start TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private loadSettings(): PulsePrivateSettings {
    return (
      SecureSettingsRepository.getInstance().load<PulsePrivateSettings>("pulse") || {
        consentState: "unset",
      }
    );
  }

  private saveSettings(settings: PulsePrivateSettings): void {
    SecureSettingsRepository.getInstance().save("pulse", settings);
  }

  /**
   * Accept an endpoint override only when it is https and resolves to a
   * non-internal host.
   *
   * Every request this service makes carries `Authorization: PulseWrite
   * <deletionToken>`, and the enrollment body carries the same token in clear.
   * An unvalidated override therefore hands both the usage package and a
   * credential that can delete the installation's data to an arbitrary
   * listener — over plaintext http if the override says so.
   */
  private resolveEndpointCandidate(candidate: string | undefined, source: string): string | null {
    if (!candidate || !candidate.trim()) return null;
    let parsed: URL;
    try {
      parsed = new URL(candidate.trim());
    } catch {
      log.warn(`Ignoring ${source} Pulse endpoint: not a valid URL.`);
      return null;
    }
    if (parsed.protocol !== "https:") {
      log.warn(`Ignoring ${source} Pulse endpoint: only https is permitted.`);
      return null;
    }
    if (isBlockedInternalHost(parsed.hostname)) {
      log.warn(`Ignoring ${source} Pulse endpoint: host is an internal address.`);
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  }

  private endpoint(settings: PulsePrivateSettings): string {
    return (
      this.resolveEndpointCandidate(process.env.COWORK_PULSE_ENDPOINT, "COWORK_PULSE_ENDPOINT") ||
      this.resolveEndpointCandidate(settings.endpoint, "configured") ||
      DEFAULT_PULSE_ENDPOINT.replace(/\/$/, "")
    );
  }

  private toPublic(settings: PulsePrivateSettings): PulsePublicSettings {
    const pending = this.db
      .prepare("SELECT payload_json FROM pulse_outbox ORDER BY created_at DESC LIMIT 1")
      .get() as { payload_json: string } | undefined;
    return {
      consentState: settings.consentState,
      enabled: settings.consentState === "enabled",
      consentVersion: PULSE_CONSENT_VERSION,
      installationId: settings.installationId || null,
      endpoint: this.endpoint(settings),
      enabledAt: settings.enabledAt || null,
      disabledAt: settings.disabledAt || null,
      lastSentAt: settings.lastSentAt || null,
      lastAttemptAt: settings.lastAttemptAt || null,
      lastErrorCode: settings.lastErrorCode || null,
      pendingPackage: pending
        ? (JSON.parse(pending.payload_json) as PulseDailyPackage)
        : this.getPreviewWithoutRecursion(settings),
    };
  }

  private getPreviewWithoutRecursion(settings: PulsePrivateSettings): PulseDailyPackage | null {
    if (settings.consentState !== "enabled" || !settings.installationId) return null;
    const installationId = settings.installationId;
    const cached = this.previewCache;
    if (
      cached &&
      cached.installationId === installationId &&
      this.now() - cached.builtAt < PulseService.PREVIEW_TTL_MS
    ) {
      return cached.value;
    }
    const value = this.buildPackage(installationId);
    this.previewCache = { builtAt: this.now(), installationId, value };
    return value;
  }

  private errorCode(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    if (/http_\d{3}/.test(value)) return value.match(/http_\d{3}/)?.[0] || "http_error";
    if (/timeout|abort/i.test(value)) return "timeout";
    return "network_error";
  }
}
