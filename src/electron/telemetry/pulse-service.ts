import { serviceStatements } from "../database/service-statements";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SecureSettingsRepository,
  SecureSettingsWriteRefusedError,
} from "../database/SecureSettingsRepository";
import type { SecureSettingsRecord } from "../database/secure-settings-sql";
import { settingsCommitClientFor } from "../database/secure-settings-commit-route";
import {
  ensurePulseSchema,
  pulseClaim,
  type PulseClaimRequest,
  type PulseClaimResult,
  pulseCommit,
  type PulseCommitRequest,
  type PulseCommitResult,
  type PulseOp,
} from "./pulse-store-sql";
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

/**
 * The Pulse settings record: read and encoded on the host (DB5). Commits go through the
 * service's backend, together with the consent windows and outbox, under the
 * settings row revision the read returned. Injected in tests.
 */
export interface PulseSettingsStore {
  /** The stored settings and the settings row revision they were read at. */
  read(): {
    settings: PulsePrivateSettings | null | undefined;
    revision: number | null;
    /** Set when the stored row exists but cannot be read; a write backs it up. */
    unreadableStatus?: string;
  };
  /** Encrypt settings for storage. Throws PulseSettingsWriteRefusedError when refused. */
  encode(settings: PulsePrivateSettings): SecureSettingsRecord;
  /** Whether saves are currently refused, so a send is not attempted it cannot record. */
  refusesWrites?(): boolean;
}

interface PulseServiceOptions {
  version: string;
  runtime: "desktop" | "daemon" | "cli";
  fetch?: typeof fetch;
  now?: () => number;
  settingsStore?: PulseSettingsStore;
}

/** Everything one delivery attempt captured, and must still match, before it writes. */
interface DeliveryContext {
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
const SETTINGS_WRITE_REFUSED = "settings_write_refused";
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_SETTLE_MS = 2_000;

class PulseClosedError extends Error {
  constructor() {
    super("pulse_service_closed");
  }
}

/**
 * The encrypted settings store refused the write (the OS keychain key changed). Saving
 * silently would let a decision look persisted when it was not, so this aborts the
 * transaction and is reported to the caller instead.
 */
export class PulseSettingsWriteRefusedError extends Error {
  readonly code = SETTINGS_WRITE_REFUSED;
  constructor() {
    super(SETTINGS_WRITE_REFUSED);
  }
}

const secureSettingsStore: PulseSettingsStore = {
  read: () => {
    const record = SecureSettingsRepository.getInstance().readRecord<PulsePrivateSettings>("pulse");
    return {
      settings: record.data,
      revision: record.revision,
      ...(record.status !== "success" && record.status !== "not_found"
        ? { unreadableStatus: record.status }
        : {}),
    };
  },
  encode: (settings) => {
    try {
      return SecureSettingsRepository.getInstance().encryptRecord(settings);
    } catch (error) {
      if (error instanceof SecureSettingsWriteRefusedError) {
        throw new PulseSettingsWriteRefusedError();
      }
      throw error;
    }
  },
  refusesWrites: () => {
    try {
      return SecureSettingsRepository.getInstance().refusesWrites();
    } catch {
      return false;
    }
  },
};

/** The settings and table state one decision was read from. */
interface PulseRead {
  settings: PulsePrivateSettings;
  revision: number | null;
  /** The read applied the one-time upgrade in memory; it still has to be persisted. */
  upgraded: boolean;
  unreadableStatus?: string;
}

/** What a decision wants to change: new settings, table ops, and whether it is a decision. */
interface PulseDecision<T> {
  outcome: T;
  next?: PulsePrivateSettings;
  ops?: PulseOp[];
  /** A user decision: increments the consent revision. */
  bump?: boolean;
}

const MAX_COMMIT_ATTEMPTS = 5;
const SETTINGS_CONFLICT = "settings_conflict";

/** A decision that could not run: settings refused the write, or kept conflicting. */
interface SettingsFailure {
  settingsFailure: string;
}

function isSettingsFailure(value: unknown): value is SettingsFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SettingsFailure).settingsFailure === "string"
  );
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
 * - A delivery attempt captures revision, identity and endpoint, and re-checks them in a
 *   fresh transaction before persisting any result, including a decision made in another
 *   process sharing the profile. It writes individual fields onto the latest record; it
 *   never saves a pre-request snapshot.
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

  getSettings(): Promise<PulsePublicSettings> {
    return this.toPublic(this.readState());
  }

  async setEnabled(enabled: boolean): Promise<PulseMutationResult> {
    const outcome = await this.decide((settings, now) => {
      if (enabled && settings.pendingDeletion) return { outcome: "deletion_pending" as const };
      if ((settings.consentState === "enabled") === enabled && settings.consentState !== "unset") {
        return { outcome: "unchanged" as const };
      }
      const ops: PulseOp[] = [{ kind: "closeConsentWindows", now }];
      if (enabled) {
        settings.consentState = "enabled";
        if (!settings.installationId || !settings.deletionToken) {
          ops.push(this.createIdentity(settings, now));
        }
        settings.enabledAt = now;
        settings.disabledAt = undefined;
        ops.push({ kind: "openConsentWindow", now });
      } else {
        settings.consentState = "disabled";
        settings.disabledAt = now;
        // Disabling is an immediate stop: do not retain an unsent package for a
        // later re-enable decision.
        ops.push({ kind: "clearOutbox" });
      }
      return { outcome: "changed" as const, next: settings, ops, bump: true };
    });
    if (isSettingsFailure(outcome)) {
      return { success: false, settings: await this.safePublic(), error: outcome.settingsFailure };
    }
    if (!enabled) this.abortActiveDelivery();
    this.previewCache = null;
    if (outcome === "deletion_pending") {
      return { success: false, settings: await this.getSettings(), error: "deletion_pending" };
    }
    if (outcome === "changed" && enabled) void this.flushSafely();
    return { success: true, settings: await this.getSettings() };
  }

  async resetIdentity(): Promise<PulseMutationResult> {
    const outcome = await this.decide((settings, now) => {
      if (settings.pendingDeletion) return { outcome: "deletion_pending" as const };
      const ops: PulseOp[] = [this.createIdentity(settings, now), { kind: "clearOutbox" }];
      settings.lastSentAt = undefined;
      settings.lastAttemptAt = undefined;
      settings.lastErrorCode = undefined;
      // A new identity starts its own consent window: days consented under the old
      // identity must never be reported under the new one.
      ops.push({ kind: "closeConsentWindows", now });
      if (settings.consentState === "enabled") ops.push({ kind: "openConsentWindow", now });
      return { outcome: "changed" as const, next: settings, ops, bump: true };
    });
    if (isSettingsFailure(outcome)) {
      return { success: false, settings: await this.safePublic(), error: outcome.settingsFailure };
    }
    this.abortActiveDelivery();
    this.previewCache = null;
    if (outcome === "deletion_pending") {
      return { success: false, settings: await this.getSettings(), error: "deletion_pending" };
    }
    return { success: true, settings: await this.getSettings() };
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
   * share one attempt. Another process sharing the profile may send the same queued
   * bytes; the collector keeps one record per package ID.
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
    // If results cannot be persisted, a send would leave no receipt and repeat forever.
    if (this.store.refusesWrites?.()) return this.sendResult("error", SETTINGS_WRITE_REFUSED);
    const controller = new AbortController();
    this.activeAbort = controller;
    let context: DeliveryContext | null = null;
    try {
      const prepared = await this.prepareDelivery();
      if (isSettingsFailure(prepared)) {
        return await this.sendResult("error", prepared.settingsFailure);
      }
      if (typeof prepared === "string") return await this.sendResult(prepared);
      context = prepared;

      if (!context.enrolled) {
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
        const recorded = await this.commitIfCurrent(context, (settings) => {
          settings.enrolled = true;
        });
        if (!recorded) return await this.sendResult("cancelled_by_state_change");
      }

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
      const recorded = await this.commitIfCurrent(delivered, (settings) => {
        const now = this.now();
        settings.lastSentAt = now;
        settings.lastAttemptAt = now;
        settings.lastErrorCode = undefined;
        return [
          {
            kind: "recordDelivered",
            packageId: delivered.packageId,
            installationId: delivered.installationId,
            periodStart: delivered.periodStart,
            now,
          },
        ];
      });
      return await this.sendResult(recorded ? "sent" : "cancelled_by_state_change");
    } catch (error) {
      if (!context) throw error;
      // Aborted by a decision or by shutdown: the outcome belongs to that change.
      if (controller.signal.aborted) return await this.sendResult("cancelled_by_state_change");
      const code = this.errorCode(error);
      const failed = context;
      // An ambiguous failure (e.g. a timeout after the server committed) keeps the
      // package queued; the collector deduplicates the identical retry.
      const recorded = await this.commitIfCurrent(failed, (settings) => {
        settings.lastErrorCode = code;
        settings.lastAttemptAt = this.now();
        if (code === "http_409") settings.enrolled = false;
        return [{ kind: "incrementAttempt", packageId: failed.packageId }];
      });
      return recorded
        ? await this.sendResult("error", code)
        : await this.sendResult("cancelled_by_state_change");
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null;
    }
  }

  /**
   * Queue the eligible day and capture what to send. The package is built from the
   * profile's aggregates before the claim, outside any transaction; the claim queues it
   * only if the day is still unsent and the settings are unchanged since they were read.
   */
  private async prepareDelivery(): Promise<DeliveryContext | PulseSendOutcome | SettingsFailure> {
    try {
      return await this.claimDelivery();
    } catch (error) {
      if (error instanceof PulseSettingsWriteRefusedError) return { settingsFailure: error.code };
      throw error;
    }
  }

  private async claimDelivery(): Promise<DeliveryContext | PulseSendOutcome | SettingsFailure> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const read = this.readPulse();
      if (read.upgraded) {
        // Persist the one-time upgrade first, then decide from the stored record.
        const persisted = await this.commitRead(read, read.settings, []);
        if (isSettingsFailure(persisted)) return persisted;
        continue;
      }
      const settings = read.settings;
      if (
        settings.pendingDeletion ||
        settings.consentState !== "enabled" ||
        !settings.installationId ||
        !settings.deletionToken
      ) {
        return "no_eligible_day";
      }
      const installationId = settings.installationId;
      const now = this.now();
      const day = utcDayBounds(now);
      const periodStart = new Date(day.start).toISOString();
      const dayPackageId = packageIdFor(installationId, periodStart);
      let candidate: PulseClaimRequest["candidate"];
      if (
        !(await this.reports().unit("pulseReport_receiptFor", [dayPackageId])) &&
        (await this.hasFullDayConsent(settings, day))
      ) {
        const pulsePackage = await this.buildPackage(installationId);
        candidate = {
          packageId: pulsePackage.packageId,
          periodStart: pulsePackage.period.start,
          payloadJson: JSON.stringify(pulsePackage),
          createdAt: now,
        };
      }
      const claimed = await this.backendClaim({
        expectedRevision: read.revision,
        installationId,
        candidate,
        dayPackageId,
      });
      if (claimed.status === "conflict") continue;
      if (claimed.status !== "claimed") return claimed.status;
      return {
        revision: settings.revision ?? 0,
        installationId,
        deletionToken: settings.deletionToken,
        endpoint: this.identityEndpoint(settings),
        enrolled: Boolean(settings.enrolled),
        packageId: claimed.head.package_id,
        periodStart: claimed.head.period_start,
        payload: claimed.head.payload_json,
      };
    }
    return { settingsFailure: SETTINGS_CONFLICT };
  }

  /**
   * Apply a delivery result to the latest settings, but only while the captured state
   * still holds. Returns false (writing nothing) when the user changed their decision,
   * the identity rotated, or the service closed. `apply`
   * edits fields on a fresh copy and returns the table changes to commit with them.
   */
  private async commitIfCurrent(
    context: DeliveryContext,
    apply: (settings: PulsePrivateSettings) => PulseOp[] | void,
  ): Promise<boolean> {
    if (this.stopping || this.closed) return false;
    try {
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const read = this.readPulse();
        if (!this.stillAuthorized(read.settings, context)) return false;
        const settings = read.settings;
        const ops = apply(settings) ?? [];
        const result = await this.backendCommit({
          expectedRevision: read.revision,
          record: this.store.encode(settings),
          ops,
          ...(read.unreadableStatus ? { backupUnreadableAs: read.unreadableStatus } : {}),
        });
        if (result.status === "committed") return true;
      }
      return false;
    } catch (error) {
      if (error instanceof PulseClosedError || error instanceof PulseSettingsWriteRefusedError) {
        return false;
      }
      throw error;
    }
  }

  /** Whether `settings` still describe the delivery `context` captured. */
  private stillAuthorized(settings: PulsePrivateSettings, context: DeliveryContext): boolean {
    return !(
      settings.consentState !== "enabled" ||
      settings.pendingDeletion ||
      (settings.revision ?? 0) !== context.revision ||
      settings.installationId !== context.installationId ||
      settings.deletionToken !== context.deletionToken ||
      this.identityEndpoint(settings) !== context.endpoint
    );
  }

  private async runDeletion(): Promise<PulseMutationResult> {
    if (this.stopping || this.closed) {
      return { success: false, settings: await this.safePublic(), error: "shutting_down" };
    }
    const target = await this.decide((settings, now) => {
      const captured: PulsePendingDeletion | null =
        settings.pendingDeletion ||
        (settings.installationId && settings.deletionToken
          ? {
              installationId: settings.installationId,
              deletionToken: settings.deletionToken,
              endpoint: this.identityEndpoint(settings),
            }
          : null);
      if (settings.consentState === "enabled" || settings.consentState === "unset") {
        settings.disabledAt = now;
      }
      settings.consentState = "disabled";
      if (captured) settings.pendingDeletion = captured;
      const ops: PulseOp[] = [{ kind: "closeConsentWindows", now }, { kind: "clearOutbox" }];
      // Without an identity there is nothing remote to delete, only local consent history.
      if (!captured) ops.push({ kind: "deleteConsentWindows" });
      return { outcome: captured, next: settings, ops, bump: true };
    });
    if (isSettingsFailure(target)) {
      return { success: false, settings: await this.safePublic(), error: target.settingsFailure };
    }
    this.abortActiveDelivery();
    this.previewCache = null;
    if (!target) return { success: true, settings: await this.getSettings() };

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
      if (this.closed) return { success: false, settings: await this.safePublic(), error: code };
      await this.decide((settings) => {
        if (settings.pendingDeletion?.installationId !== target.installationId) {
          return { outcome: null };
        }
        settings.pendingDeletion.lastErrorCode = code;
        return { outcome: null, next: settings };
      });
      return { success: false, settings: await this.getSettings(), error: code };
    }

    if (this.closed) return { success: true, settings: await this.safePublic() };
    const finalized = await this.decide((settings) => {
      const ops: PulseOp[] = [];
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
        ops.push({ kind: "deleteConsentWindows" });
      }
      ops.push({ kind: "deleteSentDaysFor", installationId: target.installationId });
      return { outcome: null, next: settings, ops, bump: true };
    });
    if (isSettingsFailure(finalized)) {
      // The server deleted the data, but the local record could not be updated; keep
      // reporting off and deletion pending so a retry (404/200) completes it later.
      return {
        success: false,
        settings: await this.safePublic(),
        error: finalized.settingsFailure,
      };
    }
    return { success: true, settings: await this.getSettings() };
  }

  /**
   * Rotate to a fresh identity pinned to today's endpoint. Returns the table change that
   * must commit with it: sent-day receipts of other identities are dropped.
   */
  private createIdentity(settings: PulsePrivateSettings, now: number): PulseOp {
    settings.installationId = randomUUID();
    settings.deletionToken = randomBytes(32).toString("base64url");
    settings.enrolled = false;
    settings.identityStartedAt = now;
    settings.identityEndpoint = this.configuredEndpoint(settings);
    return { kind: "deleteSentDaysExcept", installationId: settings.installationId };
  }

  private abortActiveDelivery(): void {
    // Best effort: an already admitted request may still complete, but its result
    // is discarded by the revision fence.
    this.activeAbort?.abort();
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return this.fetchImpl(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  /**
   * Run one decision: read the settings (decrypting on the host), let `plan` edit a
   * private copy and name its table changes, encrypt, and commit it all under the
   * settings row revision that was read. If another writer (any process) changed the
   * row meanwhile, the decision is re-planned from the newer state. No transaction ever
   * waits on the keychain or the network. A refused or conflicting write becomes a
   * value instead of a throw.
   */
  private async decide<T>(
    plan: (settings: PulsePrivateSettings, now: number) => PulseDecision<T>,
  ): Promise<T | SettingsFailure> {
    try {
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const read = this.readPulse();
        const decision = plan(read.settings, this.now());
        const next = decision.next ?? (read.upgraded ? read.settings : undefined);
        if (!next && !decision.ops?.length) return decision.outcome;
        if (next && decision.bump) next.revision = (next.revision ?? 0) + 1;
        const committed = await this.commitRead(read, next, decision.ops ?? []);
        if (isSettingsFailure(committed)) return committed;
        if (committed) return decision.outcome;
      }
      return { settingsFailure: SETTINGS_CONFLICT };
    } catch (error) {
      if (error instanceof PulseSettingsWriteRefusedError) {
        return { settingsFailure: error.code };
      }
      throw error;
    }
  }

  /**
   * Commit `next` (when given) and `ops` against the revision `read` saw. Returns true
   * when committed, false on a revision conflict, or a settings failure.
   */
  private async commitRead(
    read: PulseRead,
    next: PulsePrivateSettings | undefined,
    ops: PulseOp[],
  ): Promise<boolean | SettingsFailure> {
    try {
      const result = await this.backendCommit({
        expectedRevision: read.revision,
        record: next ? this.store.encode(next) : null,
        ops,
        ...(next && read.unreadableStatus ? { backupUnreadableAs: read.unreadableStatus } : {}),
      });
      return result.status === "committed";
    } catch (error) {
      if (error instanceof PulseSettingsWriteRefusedError) {
        return { settingsFailure: error.code };
      }
      throw error;
    }
  }

  /**
   * Commit through the database worker when this run routes settings there (DB5),
   * otherwise in one IMMEDIATE transaction on this connection.
   */
  private async backendCommit(request: PulseCommitRequest): Promise<PulseCommitResult> {
    this.assertCommittable();
    const client = settingsCommitClientFor(this.db);
    if (client) return client.execute("pulse.commit", request);
    return this.db.transaction(() => pulseCommit(this.db, request)).immediate();
  }

  private async backendClaim(request: PulseClaimRequest): Promise<PulseClaimResult> {
    this.assertCommittable();
    const client = settingsCommitClientFor(this.db);
    if (client) return client.execute("pulse.claim", request);
    return this.db.transaction(() => pulseClaim(this.db, request)).immediate();
  }

  private assertCommittable(): void {
    if (this.closed) throw new PulseClosedError();
  }

  /**
   * Read the settings for display. A record from before revisions existed is upgraded
   * once: revision defaults to 0 and, because the start of the current identity's
   * consent cannot be established, its eligibility starts conservatively at upgrade
   * time. The upgrade is shown only once it is stored; until then (refused writes, or
   * a worker commit still in flight) the record is described as stored.
   */
  private readState(): PulsePrivateSettings {
    let read: PulseRead;
    try {
      read = this.readPulse();
    } catch (error) {
      // Unreadable here (another process's keychain): no consent this process can see.
      if (error instanceof PulseSettingsWriteRefusedError) {
        return { consentState: "unset", revision: 0 };
      }
      throw error;
    }
    if (!read.upgraded) return read.settings;
    const stored = this.store.read().settings;
    const unchanged: PulsePrivateSettings = stored
      ? structuredClone(stored)
      : { consentState: "unset" };
    unchanged.revision ??= 0;
    if (this.store.refusesWrites?.()) return unchanged;
    if (settingsCommitClientFor(this.db)) {
      // Worker commits land asynchronously; the next read shows the upgrade.
      void this.commitRead(read, read.settings, []).catch((error: unknown) => {
        if (!(error instanceof PulseClosedError)) {
          log.debug(`Could not persist the Pulse settings upgrade: ${this.errorCode(error)}`);
        }
      });
      return unchanged;
    }
    try {
      this.assertCommittable();
      const record = this.store.encode(read.settings);
      const result = this.db
        .transaction(() =>
          pulseCommit(this.db, {
            expectedRevision: read.revision,
            record,
            ops: [],
            ...(read.unreadableStatus ? { backupUnreadableAs: read.unreadableStatus } : {}),
          }),
        )
        .immediate();
      return result.status === "committed" ? read.settings : unchanged;
    } catch (error) {
      if (error instanceof PulseSettingsWriteRefusedError || error instanceof PulseClosedError) {
        return unchanged;
      }
      throw error;
    }
  }

  /**
   * The stored settings as a private copy, with the one-time upgrade applied in memory.
   * A record encrypted with an OS keychain this process cannot use (the daemon or CLI
   * beside the desktop app) is never replaced from here: writes are refused.
   */
  private readPulse(): PulseRead {
    const stored = this.store.read();
    if (stored.unreadableStatus === "os_encryption_unavailable") {
      throw new PulseSettingsWriteRefusedError();
    }
    const settings: PulsePrivateSettings = stored.settings
      ? structuredClone(stored.settings)
      : { consentState: "unset" };
    let upgraded = false;
    if (this.needsUpgrade(settings)) {
      settings.revision ??= 0;
      if (settings.installationId) {
        settings.identityStartedAt ??= this.now();
        settings.identityEndpoint ??= this.configuredEndpoint(settings);
      }
      upgraded = true;
    }
    return {
      settings,
      revision: stored.revision,
      upgraded,
      ...(stored.unreadableStatus ? { unreadableStatus: stored.unreadableStatus } : {}),
    };
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

  /** Pulse reads as services-domain units (DB6). */
  private reports() {
    return serviceStatements(this.db);
  }

  private async computePreview(settings: PulsePrivateSettings): Promise<PulsePreviewState> {
    if (settings.pendingDeletion) return { state: "ineligible", reason: "deletion_pending" };
    if (settings.consentState !== "enabled" || !settings.installationId) {
      return { state: "ineligible", reason: "disabled" };
    }
    const installationId = settings.installationId;
    const head = await this.reports().unit("pulseReport_queueHead", [installationId]);
    if (head) {
      return { state: "queued", package: JSON.parse(head.payload_json) as PulseDailyPackage };
    }
    const day = utcDayBounds(this.now());
    const periodStart = new Date(day.start).toISOString();
    const receipt = await this.reports().unit("pulseReport_receiptFor", [
      packageIdFor(installationId, periodStart),
    ]);
    if (receipt) {
      return { state: "already_sent", periodStart, acknowledgedAt: receipt.acknowledged_at };
    }
    if (!(await this.hasFullDayConsent(settings, day))) {
      return {
        state: "ineligible",
        reason: "incomplete_consent_day",
        eligibleFrom: await this.eligibleFrom(settings),
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
    const value = await this.buildPackage(installationId);
    this.previewCache = { builtAt: this.now(), installationId, revision, periodStart, value };
    return { state: "candidate", package: value };
  }

  private async toPublic(settings: PulsePrivateSettings): Promise<PulsePublicSettings> {
    const preview = await this.computePreview(settings);
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
      deletion: deletion
        ? { state: "pending", lastErrorCode: deletion.lastErrorCode ?? null }
        : { state: "none", lastErrorCode: null },
      preview,
      pendingPackage:
        preview.state === "queued" || preview.state === "candidate" ? preview.package : null,
    };
    this.lastPublic = value;
    return value;
  }

  /** Public settings without touching a database that may already be closed. */
  private async safePublic(): Promise<PulsePublicSettings> {
    if (!this.closed) {
      try {
        return await this.getSettings();
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
        deletion: { state: "none", lastErrorCode: null },
        preview: { state: "ineligible", reason: "disabled" },
        pendingPackage: null,
      }
    );
  }

  private async sendResult(outcome: PulseSendOutcome, error?: string): Promise<PulseSendResult> {
    return { outcome, settings: await this.safePublic(), ...(error ? { error } : {}) };
  }

  private async buildPackage(installationId: string): Promise<PulseDailyPackage> {
    const { start, end } = utcDayBounds(this.now());
    const { created, terminal, eventRows, llm } = await this.reports().unit(
      "pulseReport_dayAggregates",
      [start, end],
    );
    const tools: PulseToolCounts = {
      shell: 0,
      filesystem: 0,
      browser: 0,
      connector: 0,
      code: 0,
      other: 0,
    };
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

  private async hasFullDayConsent(
    settings: PulsePrivateSettings,
    day: { start: number; end: number },
  ): Promise<boolean> {
    // Consent given under an older identity never counts for the current one.
    if (!settings.identityStartedAt || settings.identityStartedAt > day.start) return false;
    return this.reports().unit("pulseReport_hasConsentWindow", [day.start, day.end]);
  }

  /** First UTC day that will be fully consented for the current identity, if known. */
  private async eligibleFrom(settings: PulsePrivateSettings): Promise<string | null> {
    const openStartedAt = await this.reports().unit("pulseReport_openConsentStart", []);
    if (!openStartedAt || !settings.identityStartedAt) return null;
    const from = nextUtcDayStart(Math.max(openStartedAt, settings.identityStartedAt));
    return new Date(from).toISOString();
  }

  private ensureSchema(): void {
    ensurePulseSchema(this.db);
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
