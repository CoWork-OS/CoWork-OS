import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { DeliveryStatusUpdate, DeliveryState } from "./types";
import type { WebhookChannelHealth } from "../../../shared/types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("WebhookChannelState");

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 10_000;
const MAX_SPOOL_ENTRIES = 500;
const MAX_DELIVERIES = 200;
const MAX_HELD_PER_CHAT = 20;
const SAVE_DEBOUNCE_MS = 250;

export interface SpoolEntry<T = unknown> {
  id: string;
  payload: T;
  receivedAt: number;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
}

export interface HeldReply {
  text: string;
  replyTo?: string;
  attachments?: Array<{
    type: string;
    url?: string;
    dataBase64?: string;
    /** Sidecar file (in the state dir) holding the bytes, so state.json stays small. */
    dataFile?: string;
    mimeType?: string;
    fileName?: string;
  }>;
  heldAt: number;
}

type HeldAttachment = NonNullable<HeldReply["attachments"]>[number];

export type WebhookHealthSnapshot = WebhookChannelHealth;

interface PersistedState {
  version: 1;
  seen: Record<string, number>;
  spool: SpoolEntry[];
  deliveries: Array<{
    messageId: string;
    chatId: string;
    state: DeliveryState;
    at: number;
    errorCode?: string;
    errorMessage?: string;
  }>;
  lastInboundAt?: number;
  rejectedWebhooks: number;
  lastRejectedAt?: number;
  lastRejectedReason?: string;
  chatActivity: Record<string, number>;
  templateSentAt: Record<string, number>;
  held: Record<string, HeldReply[]>;
}

function emptyState(): PersistedState {
  return {
    version: 1,
    seen: {},
    spool: [],
    deliveries: [],
    rejectedWebhooks: 0,
    chatActivity: {},
    templateSentAt: {},
    held: {},
  };
}

/**
 * Durable per-channel state for webhook adapters. With a `stateDir` it
 * survives restarts (dedup IDs, unprocessed inbound events, delivery history,
 * held replies); without one it is memory-only, which tests use.
 *
 * The spool is written synchronously before a webhook is acknowledged, so an
 * event is either still retried by the provider or already on disk.
 */
export class WebhookChannelState {
  private state: PersistedState = emptyState();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath?: string;

  constructor(stateDir?: string) {
    if (stateDir) {
      this.filePath = path.join(stateDir, "state.json");
      this.load();
    }
  }

  // ── Dedup ─────────────────────────────────────────────

  hasSeen(id: string, now = Date.now()): boolean {
    const seenAt = this.state.seen[id];
    return seenAt !== undefined && now - seenAt < DEDUP_TTL_MS;
  }

  markSeen(id: string, now = Date.now()): void {
    this.state.seen[id] = now;
    this.pruneSeen(now);
    this.scheduleSave();
  }

  // ── Inbound spool ─────────────────────────────────────

  /** Persist an inbound event before acknowledging it. Returns false for duplicates. */
  enqueueInbound<T>(id: string, payload: T, now = Date.now()): boolean {
    if (this.hasSeen(id, now) || this.state.spool.some((entry) => entry.id === id)) return false;
    this.state.seen[id] = now;
    this.state.spool.push({ id, payload, receivedAt: now, attempts: 0 });
    if (this.state.spool.length > MAX_SPOOL_ENTRIES) {
      this.state.spool.splice(0, this.state.spool.length - MAX_SPOOL_ENTRIES);
    }
    this.state.lastInboundAt = now;
    this.pruneSeen(now);
    this.saveNow();
    return true;
  }

  dueInbound<T>(now = Date.now()): SpoolEntry<T>[] {
    return this.state.spool.filter(
      (entry) => entry.nextAttemptAt === undefined || entry.nextAttemptAt <= now,
    ) as SpoolEntry<T>[];
  }

  /** Earliest scheduled retry that still needs a timer after a restart or drain. */
  nextInboundAttemptAt(now = Date.now()): number | undefined {
    let next: number | undefined;
    for (const entry of this.state.spool) {
      const attemptAt = entry.nextAttemptAt;
      if (attemptAt === undefined || attemptAt <= now || attemptAt === Number.MAX_SAFE_INTEGER) {
        continue;
      }
      if (next === undefined || attemptAt < next) next = attemptAt;
    }
    return next;
  }

  completeInbound(id: string): void {
    this.state.spool = this.state.spool.filter((entry) => entry.id !== id);
    this.scheduleSave();
  }

  /** Records a failed attempt; returns the delay before the next one, or null to give up. */
  failInbound(id: string, error: string, maxAttempts: number, now = Date.now()): number | null {
    const entry = this.state.spool.find((item) => item.id === id);
    if (!entry) return null;
    entry.attempts += 1;
    entry.lastError = error.slice(0, 500);
    if (entry.attempts >= maxAttempts) {
      entry.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      this.scheduleSave();
      return null;
    }
    const delay = Math.min(60_000 * 2 ** (entry.attempts - 1), 30 * 60_000);
    entry.nextAttemptAt = now + delay;
    this.scheduleSave();
    return delay;
  }

  // ── Webhook health ────────────────────────────────────

  recordRejectedWebhook(reason: string, now = Date.now()): void {
    this.state.rejectedWebhooks += 1;
    this.state.lastRejectedAt = now;
    this.state.lastRejectedReason = reason;
    this.scheduleSave();
  }

  recordDelivery(update: DeliveryStatusUpdate): void {
    this.state.deliveries.push({
      messageId: update.messageId,
      chatId: update.chatId,
      state: update.state,
      at: update.timestamp.getTime(),
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
    });
    if (this.state.deliveries.length > MAX_DELIVERIES) {
      this.state.deliveries.splice(0, this.state.deliveries.length - MAX_DELIVERIES);
    }
    this.scheduleSave();
  }

  // ── Conversation windows and held replies ─────────────

  recordChatActivity(chatId: string, at: number): void {
    this.state.chatActivity[chatId] = Math.max(this.state.chatActivity[chatId] || 0, at);
    this.scheduleSave();
  }

  lastChatActivity(chatId: string): number | undefined {
    return this.state.chatActivity[chatId];
  }

  recordTemplateSent(chatId: string, at = Date.now()): void {
    this.state.templateSentAt[chatId] = at;
    this.scheduleSave();
  }

  lastTemplateSent(chatId: string): number | undefined {
    return this.state.templateSentAt[chatId];
  }

  holdReply(chatId: string, reply: HeldReply): number {
    const queue = this.state.held[chatId] || [];
    queue.push(this.spillAttachments(reply));
    if (queue.length > MAX_HELD_PER_CHAT) {
      for (const dropped of queue.splice(0, queue.length - MAX_HELD_PER_CHAT)) {
        this.discardHeldReply(dropped);
      }
    }
    this.state.held[chatId] = queue;
    this.saveNow();
    return queue.length;
  }

  /** Attachment bytes for a held reply, whether stored inline or in a sidecar file. */
  heldAttachmentData(attachment: HeldAttachment): Buffer | undefined {
    if (attachment.dataBase64) return Buffer.from(attachment.dataBase64, "base64");
    const file = this.heldFilePath(attachment.dataFile);
    return file ? fs.readFileSync(file) : undefined;
  }

  /** Delete a delivered (or dropped) held reply's sidecar files. */
  discardHeldReply(reply: HeldReply): void {
    for (const attachment of reply.attachments || []) {
      const file = this.heldFilePath(attachment.dataFile);
      if (file) fs.rmSync(file, { force: true });
    }
  }

  takeHeldReplies(chatId: string): HeldReply[] {
    const queue = this.state.held[chatId] || [];
    delete this.state.held[chatId];
    if (queue.length > 0) this.saveNow();
    return queue;
  }

  restoreHeldReplies(chatId: string, replies: HeldReply[]): void {
    if (replies.length === 0) return;
    this.state.held[chatId] = [...replies, ...(this.state.held[chatId] || [])].slice(
      -MAX_HELD_PER_CHAT,
    );
    this.saveNow();
  }

  snapshot(now = Date.now()): WebhookHealthSnapshot {
    const dayAgo = now - DEDUP_TTL_MS;
    const deliveryCounts: Partial<Record<DeliveryState, number>> = {};
    for (const delivery of this.state.deliveries) {
      if (delivery.at < dayAgo) continue;
      deliveryCounts[delivery.state] = (deliveryCounts[delivery.state] || 0) + 1;
    }
    return {
      lastInboundAt: this.state.lastInboundAt,
      rejectedWebhooks: this.state.rejectedWebhooks,
      lastRejectedAt: this.state.lastRejectedAt,
      lastRejectedReason: this.state.lastRejectedReason,
      pendingInbound: this.state.spool.length,
      failedInbound: this.state.spool
        .filter((entry) => entry.attempts > 0)
        .map((entry) => ({ id: entry.id, attempts: entry.attempts, lastError: entry.lastError })),
      deliveryCounts,
      recentDeliveryFailures: this.state.deliveries
        .filter((delivery) => delivery.state === "failed" || delivery.state === "undelivered")
        .slice(-10)
        .reverse(),
      heldReplies: Object.entries(this.state.held).map(([chatId, replies]) => ({
        chatId,
        count: replies.length,
        oldestHeldAt: replies[0]?.heldAt ?? now,
      })),
    };
  }

  /** Flush pending writes; call on disconnect. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  private pruneSeen(now: number): void {
    const entries = Object.entries(this.state.seen);
    if (entries.length <= MAX_DEDUP_ENTRIES && entries.every(([, at]) => now - at < DEDUP_TTL_MS)) {
      return;
    }
    const kept = entries
      .filter(([, at]) => now - at < DEDUP_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DEDUP_ENTRIES);
    this.state.seen = Object.fromEntries(kept);
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed?.version === 1) this.state = { ...emptyState(), ...parsed };
    } catch {
      this.state = emptyState();
    }
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.saveNow();
      } catch (error) {
        // A timer callback has no caller to report to; the next save retries.
        logger.warn("Failed to persist webhook channel state:", error);
      }
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private heldDir(): string | undefined {
    return this.filePath ? path.join(path.dirname(this.filePath), "held") : undefined;
  }

  private heldFilePath(dataFile: string | undefined): string | undefined {
    const dir = this.heldDir();
    return dir && dataFile ? path.join(dir, path.basename(dataFile)) : undefined;
  }

  /** Move inline attachment bytes into sidecar files when state is persisted. */
  private spillAttachments(reply: HeldReply): HeldReply {
    const dir = this.heldDir();
    if (!dir || !reply.attachments?.some((attachment) => attachment.dataBase64)) return reply;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      ...reply,
      attachments: reply.attachments.map((attachment) => {
        const { dataBase64, ...rest } = attachment;
        if (!dataBase64) return attachment;
        const dataFile = `${randomUUID()}.bin`;
        fs.writeFileSync(path.join(dir, dataFile), Buffer.from(dataBase64, "base64"), {
          mode: 0o600,
        });
        return { ...rest, dataFile };
      }),
    };
  }

  private saveNow(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

/** Rate-limits a repeated warning so a misconfigured provider cannot flood logs. */
export class ThrottledWarning {
  private lastAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(private readonly intervalMs = 60_000) {}

  /** Returns the message to emit (with a suppressed count), or null while throttled. */
  next(message: string, now = Date.now()): string | null {
    if (now - this.lastAt < this.intervalMs) {
      this.suppressed += 1;
      return null;
    }
    const suffix = this.suppressed > 0 ? ` (${this.suppressed} similar rejections suppressed)` : "";
    this.lastAt = now;
    this.suppressed = 0;
    return `${message}${suffix}`;
  }
}
