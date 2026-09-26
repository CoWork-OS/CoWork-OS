import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  DEFAULT_PULSE_ENDPOINT,
  PULSE_CONSENT_VERSION,
  PULSE_SCHEMA_VERSION,
  type PulseDailyPackage,
  type PulseMutationResult,
  type PulsePreviewState,
  type PulsePublicSettings,
  type PulseSendOutcome,
  type PulseSendResult,
  type PulseToolCounts,
} from "../../shared/pulse";
import { isBlockedInternalHost } from "../security/address-classes";
import { createLogger } from "../utils/logger";

const log = createLogger("PulseService");

/**
 * Deletion authority retained until the collector acknowledges deletion. It pins the
 * identity, credential and endpoint captured when the user asked for deletion, so a
 * later identity or endpoint change can neither redirect nor drop it.
 */
interface PulsePendingDeletion {
  installationId: string;
  deletionToken: string;
  endpoint: string;
  requestedAt: number;
  lastAttemptAt?: number;
  lastErrorCode?: string;
}

export interface PulsePrivateSettings {
  consentState: "unset" | "enabled" | "disabled";
  installationId?: string;
  deletionToken?: string;
  /** Configured endpoint override (still subject to https/non-internal validation). */
  endpoint?: string;
  enabledAt?: number;
  disabledAt?: number;
  lastSentAt?: number;
  lastAttemptAt?: number;
  lastErrorCode?: string;
  enrolled?: boolean;
  /**
   * Monotonic consent/identity revision. Every user decision increments it; every
   * asynchronous continuation compares its captured revision before writing.
   * Records written before this field existed read as revision 0.
   */
  revision?: number;
  /** When the current identity began. Consent days before this never count for it. */
  identityStartedAt?: number;
  /** Endpoint the current identity enrolls with; its credential never goes elsewhere. */
  identityEndpoint?: string;
  pendingDeletion?: PulsePendingDeletion;
}

/** Storage for the encrypted Pulse settings record. Injected in tests. */
export interface PulseSettingsStore {
  load(): PulsePrivateSettings | null | undefined;
  save(settings: PulsePrivateSettings): void;
}

interface PulseServiceOptions {
  version: string;
  runtime: "desktop" | "daemon" | "cli";
  fetch?: typeof fetch;
  now?: () => number;
  settingsStore?: PulseSettingsStore;
  /** Delivery-lease owner identity; one per service instance by default. */
  ownerId?: string;
  leaseMs?: number;
  requestTimeoutMs?: number;
}

/** Everything one delivery attempt captured, and must still match, before it writes. */
interface DeliveryContext {
  owner: string;
  revision: number;
  installationId: string;
  deletionToken: string;
  endpoint: string;
  enrolled: boolean;
  packageId: string;
  periodStart: string;
  payload: string;
}

const MAX_COUNT = 100_000;
const DAY_MS = 86_400_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_SETTLE_MS = 2_000;

const secureSettingsStore: PulseSettingsStore = {
  load: () => SecureSettingsRepository.getInstance().load<PulsePrivateSettings>("pulse"),
  save: (settings) => SecureSettingsRepository.getInstance().save("pulse", settings),
};

class PulseClosedError extends Error {
  constructor() {
    super("pulse_service_closed");
  }
}

function clampCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value || 0);
  return Math.max(0, Math.min(MAX_COUNT, Math.round(Number.isFinite(number) ? number : 0)));
}

function utcDayBounds(now: number): { start: number; end: number } {
  const endDate = new Date(now);
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return { start: end - DAY_MS, end };
}

/** Start of the first UTC day that begins at or after `timestamp`. */
function nextUtcDayStart(timestamp: number): number {
  return Math.ceil(timestamp / DAY_MS) * DAY_MS;
}

function packageIdFor(installationId: string, periodStartIso: string): string {
  return createHash("sha256").update(`${installationId}:${periodStartIso}`).digest("hex");
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
 * Exported separately from the service for callers that need the consent answer
 * without a Database handle. Fails closed: an uninitialized settings repository, an
 * unreadable record, or an unresolved deletion counts as "no consent".
 */
export function isPulseConsentGranted(): boolean {
  try {
    const settings = SecureSettingsRepository.getInstance().load<PulsePrivateSettings>("pulse");
    return settings?.consentState === "enabled" && !settings.pendingDeletion;
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

/**
 * CoWork Pulse lifecycle.
 *
 * Consent is the user's latest decision and must never move backward because an
 * asynchronous response arrived late. The rules:
 *
 * - Every user decision (enable, disable, delete, reset) runs in one short IMMEDIATE
 *   transaction over the encrypted settings, consent windows and outbox, and increments
 *   `revision`. It never waits for network work.
 * - A delivery attempt captures revision, identity, endpoint and a delivery lease, and
 *   re-checks all of them in a fresh transaction before each network stage and before
 *   persisting any result. It writes individual fields onto the latest record; it never
 *   saves a pre-request snapshot.
 * - The `pulse_delivery_lease` row keeps two processes sharing one profile database
 *   from delivering concurrently. Expired owners can neither persist nor proceed.
 * - No database transaction is ever held across an HTTP request.
 *
 * Remote deletion is reported as the collector's acknowledgement. A request the server
 * already accepted before deletion cannot be retracted by this client; see
 * docs/cowork-pulse.md.
 */
export class PulseService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly store: PulseSettingsStore;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly requestTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<PulseSendResult> | null = null;
  private activeDeletion: Promise<PulseMutationResult> | null = null;
  private activeAbort: AbortController | null = null;
  private stopping = false;
  private closed = false;
  private lastPublic: PulsePublicSettings | null = null;
  /**
   * Memo for the candidate preview. buildPackage runs a `PRAGMA table_info` plus
   * aggregates over tasks, task_events and llm_call_events; getSettings is called on
   * every settings render. Keyed by identity, revision and UTC period so a decision or
   * a UTC rollover always rebuilds it.
   */
  private previewCache: {
    builtAt: number;
    installationId: string;
    revision: number;
    periodStart: string;
    value: PulseDailyPackage;
  } | null = null;
  private static readonly PREVIEW_TTL_MS = 60_000;

  constructor(
    private readonly db: Database.Database,
    private readonly options: PulseServiceOptions,
  ) {
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || Date.now;
    this.store = options.settingsStore || secureSettingsStore;
    this.ownerId = options.ownerId || randomUUID();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.ensureSchema();
  }

  start(): void {
    if (this.stopping || this.closed) return;
    // Idempotent: a repeated start must not leave an orphaned timer behind.
    this.stop();
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

  /**
   * Stop accepting delivery work, cancel both timers, abort in-flight requests and wait
   * (bounded) for them to settle. After this resolves the service never touches the
   * database again, so it is safe to close the database.
   */
  async shutdown(settleMs = DEFAULT_SHUTDOWN_SETTLE_MS): Promise<void> {
    this.stopping = true;
    this.stop();
    this.activeAbort?.abort();
    const pending = [this.activeFlush, this.activeDeletion].filter(
      (value): value is Promise<PulseSendResult> | Promise<PulseMutationResult> => Boolean(value),
    );
    if (pending.length) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, settleMs);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.closed = true;
  }

  getSettings(): PulsePublicSettings {
    return this.toPublic(this.readState());
  }

  getPreview(): PulseDailyPackage | null {
    const preview = this.computePreview(this.readState());
    return preview.state === "queued" || preview.state === "candidate" ? preview.package : null;
  }

  async setEnabled(enabled: boolean): Promise<PulseMutationResult> {
    const outcome = this.transact(() => {
      const settings = this.loadState();
      if (enabled && settings.pendingDeletion) return "deletion_pending" as const;
      if ((settings.consentState === "enabled") === enabled && settings.consentState !== "unset") {
        return "unchanged" as const;
      }
      const now = this.now();
      if (enabled) {
        settings.consentState = "enabled";
        if (!settings.installationId || !settings.deletionToken) this.createIdentity(settings, now);
        settings.enabledAt = now;
        settings.disabledAt = undefined;
        this.closeConsentWindows(now);
        this.db.prepare("INSERT INTO pulse_consent_windows (started_at) VALUES (?)").run(now);
      } else {
        settings.consentState = "disabled";
        settings.disabledAt = now;
        this.closeConsentWindows(now);
        // Disabling is an immediate stop: do not retain an unsent package for a
        // later re-enable decision.
        this.db.prepare("DELETE FROM pulse_outbox").run();
      }
      this.commitDecision(settings);
      return "changed" as const;
    });
    if (!enabled) this.abortActiveDelivery();
    this.previewCache = null;
    if (outcome === "deletion_pending") {
      return { success: false, settings: this.getSettings(), error: "deletion_pending" };
    }
    if (outcome === "changed" && enabled) void this.flushSafely();
    return { success: true, settings: this.getSettings() };
  }

  async resetIdentity(): Promise<PulseMutationResult> {
    const outcome = this.transact(() => {
      const settings = this.loadState();
      if (settings.pendingDeletion) return "deletion_pending" as const;
      const now = this.now();
      this.createIdentity(settings, now);
      settings.lastSentAt = undefined;
      settings.lastAttemptAt = undefined;
      settings.lastErrorCode = undefined;
      this.db.prepare("DELETE FROM pulse_outbox").run();
      // A new identity starts its own consent window: days consented under the old
      // identity must never be reported under the new one.
      this.closeConsentWindows(now);
      if (settings.consentState === "enabled") {
        this.db.prepare("INSERT INTO pulse_consent_windows (started_at) VALUES (?)").run(now);
      }
      this.commitDecision(settings);
      return "changed" as const;
    });
    this.abortActiveDelivery();
    this.previewCache = null;
    if (outcome === "deletion_pending") {
      return { success: false, settings: this.getSettings(), error: "deletion_pending" };
    }
    return { success: true, settings: this.getSettings() };
  }

  /**
   * Turn reporting off and ask the collector to delete this installation's data.
   * Reporting is off before any request is made. If the request fails, the deletion
   * target and credential are kept so the user can retry, including after a restart;
   * calling this again retries the same target. A retry is explicitly requested
   * maintenance, never an opt-in to usage reporting.
   */
  deleteRemoteData(): Promise<PulseMutationResult> {
    if (this.activeDeletion) return this.activeDeletion;
    const run = this.runDeletion().finally(() => {
      if (this.activeDeletion === run) this.activeDeletion = null;
    });
    this.activeDeletion = run;
    return run;
  }

  /**
   * Timer-driven flush. `flush` can throw before it has a delivery context — e.g.
   * against a database that is closing during shutdown — and a bare
   * `void this.flush()` would surface that as an unhandled rejection.
   */
  private async flushSafely(): Promise<void> {
    try {
      await this.flush();
    } catch (error) {
      if (error instanceof PulseClosedError) return;
      log.warn(`Scheduled flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Attempt to deliver the oldest queued eligible day. Concurrent calls in one process
   * share one attempt; another process holding the delivery lease yields `busy`.
   */
  flush(): Promise<PulseSendResult> {
    if (this.activeFlush) return this.activeFlush;
    if (this.stopping || this.closed) {
      return Promise.resolve(this.sendResult("cancelled_by_state_change"));
    }
    const run = this.runFlush().finally(() => {
      if (this.activeFlush === run) this.activeFlush = null;
    });
    this.activeFlush = run;
    return run;
  }

  private async runFlush(): Promise<PulseSendResult> {
    const controller = new AbortController();
    this.activeAbort = controller;
    let context: DeliveryContext | null = null;
    try {
      const prepared = this.transact(() => this.prepareDelivery());
      if (typeof prepared === "string") return this.sendResult(prepared);
      context = prepared;

      if (!context.enrolled) {
        if (!this.authorizeStage(context)) return this.sendResult("cancelled_by_state_change");
        const enrolled = await this.request(
          `${context.endpoint}/v1/installations`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: PULSE_SCHEMA_VERSION,
              installationId: context.installationId,
              deletionToken: context.deletionToken,
              consentVersion: PULSE_CONSENT_VERSION,
            }),
          },
          controller.signal,
        );
        if (!enrolled.ok && enrolled.status !== 409) throw new Error(`http_${enrolled.status}`);
        const recorded = this.commitIfCurrent(context, (settings) => {
          settings.enrolled = true;
        });
        if (!recorded) return this.sendResult("cancelled_by_state_change");
      }

      if (!this.authorizeStage(context)) return this.sendResult("cancelled_by_state_change");
      const response = await this.request(
        `${context.endpoint}/v1/daily`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `PulseWrite ${context.deletionToken}`,
          },
          // The queued bytes, unmodified: a retry resubmits the same package ID and body.
          body: context.payload,
        },
        controller.signal,
      );
      if (!response.ok) throw new Error(`http_${response.status}`);
      const delivered = context;
      const recorded = this.commitIfCurrent(delivered, (settings) => {
        const now = this.now();
        this.db
          .prepare(
            `INSERT OR IGNORE INTO pulse_sent_days
             (package_id, installation_id, period_start, acknowledged_at) VALUES (?, ?, ?, ?)`,
          )
          .run(delivered.packageId, delivered.installationId, delivered.periodStart, now);
        this.db.prepare("DELETE FROM pulse_outbox WHERE package_id = ?").run(delivered.packageId);
        settings.lastSentAt = now;
        settings.lastAttemptAt = now;
        settings.lastErrorCode = undefined;
      });
      return this.sendResult(recorded ? "sent" : "cancelled_by_state_change");
    } catch (error) {
      if (!context) throw error;
      // Aborted by a decision or by shutdown: the outcome belongs to that change.
      if (controller.signal.aborted) return this.sendResult("cancelled_by_state_change");
      const code = this.errorCode(error);
      const failed = context;
      // An ambiguous failure (e.g. a timeout after the server committed) keeps the
      // package queued; the collector deduplicates the identical retry.
      const recorded = this.commitIfCurrent(failed, (settings) => {
        settings.lastErrorCode = code;
        settings.lastAttemptAt = this.now();
        if (code === "http_409") settings.enrolled = false;
        this.db
          .prepare("UPDATE pulse_outbox SET attempt_count = attempt_count + 1 WHERE package_id = ?")
          .run(failed.packageId);
      });
      return recorded
        ? this.sendResult("error", code)
        : this.sendResult("cancelled_by_state_change");
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
      if (context) this.releaseLease();
    }
  }

  /** Runs inside a transaction. Queues the eligible day and claims the delivery lease. */
  private prepareDelivery(): DeliveryContext | PulseSendOutcome {
    const settings = this.loadState();
    if (
      settings.pendingDeletion ||
      settings.consentState !== "enabled" ||
      !settings.installationId ||
      !settings.deletionToken
    ) {
      return "no_eligible_day";
    }
    const installationId = settings.installationId;
    const day = utcDayBounds(this.now());
    const periodStart = new Date(day.start).toISOString();
    const dayPackageId = packageIdFor(installationId, periodStart);

    // Rows from another identity, or already acknowledged, are never sendable.
    this.db
      .prepare(
        `DELETE FROM pulse_outbox WHERE installation_id IS NOT ?
         OR package_id IN (SELECT package_id FROM pulse_sent_days)`,
      )
      .run(installationId);
    if (!this.receiptFor(dayPackageId) && this.hasFullDayConsent(settings, day)) {
      const pulsePackage = this.buildPackage(installationId);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pulse_outbox
           (package_id, installation_id, period_start, payload_json, created_at, attempt_count)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(
          pulsePackage.packageId,
          installationId,
          pulsePackage.period.start,
          JSON.stringify(pulsePackage),
          this.now(),
        );
    }
    const head = this.queueHead(installationId);
    if (!head) return this.receiptFor(dayPackageId) ? "already_sent" : "no_eligible_day";

    const now = this.now();
    const lease = this.db
      .prepare("SELECT owner, expires_at FROM pulse_delivery_lease WHERE id = 1")
      .get() as { owner: string; expires_at: number } | undefined;
    if (lease && lease.owner !== this.ownerId && lease.expires_at > now) return "busy";
    this.db
      .prepare(
        `INSERT INTO pulse_delivery_lease (id, owner, revision, expires_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, revision = excluded.revision,
         expires_at = excluded.expires_at`,
      )
      .run(this.ownerId, settings.revision ?? 0, now + this.leaseMs);

    return {
      owner: this.ownerId,
      revision: settings.revision ?? 0,
      installationId,
      deletionToken: settings.deletionToken,
      endpoint: this.identityEndpoint(settings),
      enrolled: Boolean(settings.enrolled),
      packageId: head.package_id,
      periodStart: head.period_start,
      payload: head.payload_json,
    };
  }

  /** Whether the latest state still authorizes this delivery; renews the lease if so. */
  private authorizeStage(context: DeliveryContext): boolean {
    if (this.stopping || this.closed) return false;
    try {
      return this.transact(() => {
        if (!this.stillAuthorized(context)) return false;
        this.db
          .prepare("UPDATE pulse_delivery_lease SET expires_at = ? WHERE id = 1 AND owner = ?")
          .run(this.now() + this.leaseMs, context.owner);
        return true;
      });
    } catch (error) {
      if (error instanceof PulseClosedError) return false;
      throw error;
    }
  }

  /**
   * Apply a delivery result to the latest settings, but only while the captured state
   * still holds and this owner's lease is live. Returns false (writing nothing) when the
   * user changed their decision, the identity rotated, or the service closed.
   */
  private commitIfCurrent(
    context: DeliveryContext,
    apply: (settings: PulsePrivateSettings) => void,
  ): boolean {
    if (this.stopping || this.closed) return false;
    try {
      return this.transact(() => {
        if (!this.stillAuthorized(context)) return false;
        const settings = this.loadState();
        apply(settings);
        this.store.save(settings);
        return true;
      });
    } catch (error) {
      if (error instanceof PulseClosedError) return false;
      throw error;
    }
  }

  /** Runs inside a transaction. */
  private stillAuthorized(context: DeliveryContext): boolean {
    const settings = this.loadState();
    if (
      settings.consentState !== "enabled" ||
      settings.pendingDeletion ||
      (settings.revision ?? 0) !== context.revision ||
      settings.installationId !== context.installationId ||
      settings.deletionToken !== context.deletionToken ||
      this.identityEndpoint(settings) !== context.endpoint
    ) {
      return false;
    }
    const lease = this.db
      .prepare("SELECT owner, expires_at FROM pulse_delivery_lease WHERE id = 1")
      .get() as { owner: string; expires_at: number } | undefined;
    return Boolean(lease && lease.owner === context.owner && lease.expires_at > this.now());
  }

  private releaseLease(): void {
    if (this.closed) return;
    try {
      this.db.prepare("DELETE FROM pulse_delivery_lease WHERE owner = ?").run(this.ownerId);
    } catch (error) {
      log.debug(`Could not release Pulse delivery lease: ${this.errorCode(error)}`);
    }
  }

  private async runDeletion(): Promise<PulseMutationResult> {
    if (this.stopping || this.closed) {
      return { success: false, settings: this.safePublic(), error: "shutting_down" };
    }
    const target = this.transact(() => {
      const settings = this.loadState();
      const now = this.now();
      const captured: PulsePendingDeletion | null =
        settings.pendingDeletion ||
        (settings.installationId && settings.deletionToken
          ? {
              installationId: settings.installationId,
              deletionToken: settings.deletionToken,
              endpoint: this.identityEndpoint(settings),
              requestedAt: now,
            }
          : null);
      if (settings.consentState === "enabled" || settings.consentState === "unset") {
        settings.disabledAt = now;
      }
      settings.consentState = "disabled";
      this.closeConsentWindows(now);
      this.db.prepare("DELETE FROM pulse_outbox").run();
      if (captured) settings.pendingDeletion = captured;
      this.commitDecision(settings);
      return captured;
    });
    this.abortActiveDelivery();
    this.previewCache = null;
    if (!target) {
      this.transact(() => {
        this.db.prepare("DELETE FROM pulse_consent_windows").run();
      });
      return { success: true, settings: this.getSettings() };
    }

    try {
      const response = await this.request(`${target.endpoint}/v1/installations`, {
        method: "DELETE",
        headers: {
          Authorization: `PulseDeletion ${target.deletionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ installationId: target.installationId }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`http_${response.status}`);
    } catch (error) {
      const code = this.errorCode(error);
      if (this.closed) return { success: false, settings: this.safePublic(), error: code };
      this.transact(() => {
        const settings = this.loadState();
        if (settings.pendingDeletion?.installationId !== target.installationId) return;
        settings.pendingDeletion.lastAttemptAt = this.now();
        settings.pendingDeletion.lastErrorCode = code;
        this.store.save(settings);
      });
      return { success: false, settings: this.getSettings(), error: code };
    }

    if (this.closed) return { success: true, settings: this.safePublic() };
    this.transact(() => {
      const settings = this.loadState();
      if (settings.pendingDeletion?.installationId === target.installationId) {
        delete settings.pendingDeletion;
      }
      // A stale acknowledgement must never clear a newer, unrelated identity.
      if (settings.installationId === target.installationId) {
        delete settings.installationId;
        delete settings.deletionToken;
        delete settings.enrolled;
        delete settings.identityStartedAt;
        delete settings.identityEndpoint;
        delete settings.enabledAt;
        delete settings.lastSentAt;
        delete settings.lastAttemptAt;
        delete settings.lastErrorCode;
        this.db.prepare("DELETE FROM pulse_consent_windows").run();
      }
      this.db
        .prepare("DELETE FROM pulse_sent_days WHERE installation_id = ?")
        .run(target.installationId);
      this.commitDecision(settings);
    });
    return { success: true, settings: this.getSettings() };
  }

  /** Runs inside a transaction: rotate to a fresh identity pinned to today's endpoint. */
  private createIdentity(settings: PulsePrivateSettings, now: number): void {
    settings.installationId = randomUUID();
    settings.deletionToken = randomBytes(32).toString("base64url");
    settings.enrolled = false;
    settings.identityStartedAt = now;
    settings.identityEndpoint = this.configuredEndpoint(settings);
    this.db
      .prepare("DELETE FROM pulse_sent_days WHERE installation_id <> ?")
      .run(settings.installationId);
  }

  private closeConsentWindows(now: number): void {
    this.db
      .prepare("UPDATE pulse_consent_windows SET ended_at = ? WHERE ended_at IS NULL")
      .run(now);
  }

  /** Runs inside a transaction: record a user decision. */
  private commitDecision(settings: PulsePrivateSettings): void {
    settings.revision = (settings.revision ?? 0) + 1;
    this.store.save(settings);
  }

  private abortActiveDelivery(): void {
    // Best effort: an already admitted request may still complete, but its result
    // is discarded by the revision fence.
    this.activeAbort?.abort();
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return this.fetchImpl(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  private transact<T>(fn: () => T): T {
    if (this.closed) throw new PulseClosedError();
    return this.db.transaction(fn).immediate();
  }

  /**
   * Read the stored settings. Records from before revisions existed are upgraded once:
   * revision defaults to 0 and, because the start of the current identity's consent
   * cannot be established, its eligibility starts conservatively at upgrade time.
   */
  private readState(): PulsePrivateSettings {
    const settings = this.rawSettings();
    if (!this.needsUpgrade(settings)) return settings;
    return this.transact(() => this.loadState());
  }

  /** Runs inside a transaction; persists the one-time upgrade if needed. */
  private loadState(): PulsePrivateSettings {
    const settings = this.rawSettings();
    if (!this.needsUpgrade(settings)) return settings;
    settings.revision ??= 0;
    if (settings.installationId) {
      settings.identityStartedAt ??= this.now();
      settings.identityEndpoint ??= this.configuredEndpoint(settings);
    }
    this.store.save(settings);
    return settings;
  }

  private rawSettings(): PulsePrivateSettings {
    const stored = this.store.load();
    return stored ? { ...stored } : { consentState: "unset" };
  }

  private needsUpgrade(settings: PulsePrivateSettings): boolean {
    if (settings.consentState === "unset" && !settings.installationId) return false;
    return (
      settings.revision === undefined ||
      Boolean(
        settings.installationId && (!settings.identityStartedAt || !settings.identityEndpoint),
      )
    );
  }

  private identityEndpoint(settings: PulsePrivateSettings): string {
    return settings.identityEndpoint || this.configuredEndpoint(settings);
  }

  private queueHead(
    installationId: string,
  ): { package_id: string; period_start: string; payload_json: string } | undefined {
    // One selector for sending and for the preview: oldest eligible queued day first.
    return this.db
      .prepare(
        `SELECT package_id, period_start, payload_json FROM pulse_outbox
         WHERE installation_id = ?
         AND package_id NOT IN (SELECT package_id FROM pulse_sent_days)
         ORDER BY period_start, created_at LIMIT 1`,
      )
      .get(installationId) as
      | { package_id: string; period_start: string; payload_json: string }
      | undefined;
  }

  private receiptFor(packageId: string): { acknowledged_at: number } | undefined {
    return this.db
      .prepare("SELECT acknowledged_at FROM pulse_sent_days WHERE package_id = ?")
      .get(packageId) as { acknowledged_at: number } | undefined;
  }

  private computePreview(settings: PulsePrivateSettings): PulsePreviewState {
    if (settings.pendingDeletion) return { state: "ineligible", reason: "deletion_pending" };
    if (settings.consentState !== "enabled" || !settings.installationId) {
      return { state: "ineligible", reason: "disabled" };
    }
    const installationId = settings.installationId;
    const head = this.queueHead(installationId);
    if (head) {
      return { state: "queued", package: JSON.parse(head.payload_json) as PulseDailyPackage };
    }
    const day = utcDayBounds(this.now());
    const periodStart = new Date(day.start).toISOString();
    const receipt = this.receiptFor(packageIdFor(installationId, periodStart));
    if (receipt) {
      return { state: "already_sent", periodStart, acknowledgedAt: receipt.acknowledged_at };
    }
    if (!this.hasFullDayConsent(settings, day)) {
      return {
        state: "ineligible",
        reason: "incomplete_consent_day",
        eligibleFrom: this.eligibleFrom(settings),
      };
    }
    const revision = settings.revision ?? 0;
    const cached = this.previewCache;
    if (
      cached &&
      cached.installationId === installationId &&
      cached.revision === revision &&
      cached.periodStart === periodStart &&
      this.now() - cached.builtAt < PulseService.PREVIEW_TTL_MS
    ) {
      return { state: "candidate", package: cached.value };
    }
    const value = this.buildPackage(installationId);
    this.previewCache = { builtAt: this.now(), installationId, revision, periodStart, value };
    return { state: "candidate", package: value };
  }

  private toPublic(settings: PulsePrivateSettings): PulsePublicSettings {
    const preview = this.computePreview(settings);
    const deletion = settings.pendingDeletion;
    const value: PulsePublicSettings = {
      consentState: settings.consentState,
      enabled: settings.consentState === "enabled",
      consentVersion: PULSE_CONSENT_VERSION,
      installationId: settings.installationId || deletion?.installationId || null,
      endpoint: deletion?.endpoint || this.identityEndpoint(settings),
      enabledAt: settings.enabledAt || null,
      disabledAt: settings.disabledAt || null,
      lastSentAt: settings.lastSentAt || null,
      lastAttemptAt: settings.lastAttemptAt || null,
      lastErrorCode: settings.lastErrorCode || null,
      revision: settings.revision ?? 0,
      deletion: deletion
        ? {
            state: "pending",
            requestedAt: deletion.requestedAt,
            lastAttemptAt: deletion.lastAttemptAt ?? null,
            lastErrorCode: deletion.lastErrorCode ?? null,
          }
        : { state: "none", requestedAt: null, lastAttemptAt: null, lastErrorCode: null },
      preview,
      pendingPackage:
        preview.state === "queued" || preview.state === "candidate" ? preview.package : null,
    };
    this.lastPublic = value;
    return value;
  }

  /** Public settings without touching a database that may already be closed. */
  private safePublic(): PulsePublicSettings {
    if (!this.closed) {
      try {
        return this.getSettings();
      } catch {
        // Fall through to the last known projection.
      }
    }
    return (
      this.lastPublic || {
        consentState: "unset",
        enabled: false,
        consentVersion: PULSE_CONSENT_VERSION,
        installationId: null,
        endpoint: DEFAULT_PULSE_ENDPOINT.replace(/\/$/, ""),
        enabledAt: null,
        disabledAt: null,
        lastSentAt: null,
        lastAttemptAt: null,
        lastErrorCode: null,
        revision: 0,
        deletion: { state: "none", requestedAt: null, lastAttemptAt: null, lastErrorCode: null },
        preview: { state: "ineligible", reason: "disabled" },
        pendingPackage: null,
      }
    );
  }

  private sendResult(outcome: PulseSendOutcome, error?: string): PulseSendResult {
    return { outcome, settings: this.safePublic(), ...(error ? { error } : {}) };
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
    const sampleClause = taskColumns.has("source")
      ? "AND COALESCE(source, 'manual') <> 'sample'"
      : "";
    const sessionExpr = taskColumns.has("session_id") ? "COALESCE(session_id, id)" : "id";
    const created = this.db
      .prepare(
        `SELECT COUNT(*) AS tasks_started, COUNT(DISTINCT ${sessionExpr}) AS sessions_started
       FROM tasks WHERE created_at >= ? AND created_at < ? ${rootClause} ${evalClause} ${sampleClause}`,
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
       FROM tasks WHERE completed_at >= ? AND completed_at < ? ${rootClause} ${evalClause} ${sampleClause}`,
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
       ${taskColumns.has("source") ? "AND (t.source IS NULL OR t.source <> 'sample')" : ""}
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
        `SELECT COUNT(*) AS errors FROM llm_call_events l
         LEFT JOIN tasks t ON t.id = l.task_id
         WHERE l.timestamp >= ? AND l.timestamp < ? AND l.success = 0
         ${taskColumns.has("source") ? "AND (t.source IS NULL OR t.source <> 'sample')" : ""}`,
      )
      .get(start, end) as { errors: number };
    for (const key of Object.keys(tools) as Array<keyof PulseToolCounts>)
      tools[key] = clampCount(tools[key]);

    const startIso = new Date(start).toISOString();
    return {
      schemaVersion: PULSE_SCHEMA_VERSION,
      packageId: packageIdFor(installationId, startIso),
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

  private hasFullDayConsent(
    settings: PulsePrivateSettings,
    day: { start: number; end: number },
  ): boolean {
    // Consent given under an older identity never counts for the current one.
    if (!settings.identityStartedAt || settings.identityStartedAt > day.start) return false;
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pulse_consent_windows WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1",
        )
        .get(day.start, day.end),
    );
  }

  /** First UTC day that will be fully consented for the current identity, if known. */
  private eligibleFrom(settings: PulsePrivateSettings): string | null {
    const open = this.db
      .prepare(
        "SELECT MAX(started_at) AS started_at FROM pulse_consent_windows WHERE ended_at IS NULL",
      )
      .get() as { started_at: number | null } | undefined;
    if (!open?.started_at || !settings.identityStartedAt) return null;
    const from = nextUtcDayStart(Math.max(open.started_at, settings.identityStartedAt));
    return new Date(from).toISOString();
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
      CREATE TABLE IF NOT EXISTS pulse_sent_days (
        package_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_delivery_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const outboxColumns = new Set(
      (this.db.prepare("PRAGMA table_info(pulse_outbox)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!outboxColumns.has("installation_id")) {
      this.db.exec("ALTER TABLE pulse_outbox ADD COLUMN installation_id TEXT");
      // Queued rows from older builds carry their identity only inside the payload.
      this.db
        .prepare(
          "UPDATE pulse_outbox SET installation_id = json_extract(payload_json, '$.installationId') WHERE installation_id IS NULL",
        )
        .run();
    }
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

  private configuredEndpoint(settings: PulsePrivateSettings): string {
    return (
      this.resolveEndpointCandidate(process.env.COWORK_PULSE_ENDPOINT, "COWORK_PULSE_ENDPOINT") ||
      this.resolveEndpointCandidate(settings.endpoint, "configured") ||
      DEFAULT_PULSE_ENDPOINT.replace(/\/$/, "")
    );
  }

  private errorCode(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    if (/http_\d{3}/.test(value)) return value.match(/http_\d{3}/)?.[0] || "http_error";
    if (/timeout|abort/i.test(value)) return "timeout";
    return "network_error";
  }
}
