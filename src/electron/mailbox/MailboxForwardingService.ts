import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { computeNextRunAtMs } from "../cron/schedule";
import { MailboxAutomationRegistry } from "./MailboxAutomationRegistry";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { gmailRequest } from "../utils/gmail-api";
import { createLogger } from "../utils/logger";
import { GOOGLE_SCOPE_GMAIL_MODIFY, hasScope } from "../../shared/google-workspace";
import type { GmailRequestResult } from "../utils/gmail-api";
import type { MailboxAutomationRecord, MailboxForwardRecipe } from "../../shared/mailbox";

const logger = createLogger("MailboxForwardingService");
const MAX_GMAIL_LIST_RESULTS = 500;
const MAX_MESSAGE_BODY_CHARS = 120_000;
const TIMER_FALLBACK_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SEARCH_WATERMARK_OVERLAP_MS = 5 * MINUTE_MS;

type MailboxForwardingServiceDeps = {
  db: Database.Database;
  log?: (...args: unknown[]) => void;
};

type ForwardingAttachment = {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  inlineData?: string;
};

type ForwardingMessage = {
  id: string;
  threadId: string;
  subject: string;
  fromRaw?: string;
  fromEmail?: string;
  internalDate: number;
  textBody: string;
  htmlBody?: string;
  attachments: ForwardingAttachment[];
  labelIds: string[];
};

type MessageForwardOutcome =
  | { status: "sent" | "already_sent" | "dry_run"; messageId: string }
  | { status: "failed"; messageId: string; error: string };

type ThreadEvaluation = {
  threadId: string;
  targets: ForwardingMessage[];
};

type RunSummary = {
  matchedThreads: number;
  matchedMessages: number;
  sentMessages: number;
  alreadySentMessages: number;
  rejectedThreads: number;
  failedMessages: number;
  dryRun: boolean;
  summary: string;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

function normalizeDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const atIndex = value.lastIndexOf("@");
  return atIndex === -1
    ? undefined
    : value
        .slice(atIndex + 1)
        .trim()
        .toLowerCase() || undefined;
}

function formatGmailAfterDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function base64UrlDecode(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(normalized + "=".repeat(padding), "base64").toString("utf8");
}

function encodeBase64Lines(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

function encodeMessage(raw: string): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function extractPlainText(payload: Any): string {
  const mimeType = normalizeString(payload?.mimeType) || "";
  if (payload?.body?.data && mimeType === "text/plain") {
    return base64UrlDecode(payload.body.data).slice(0, MAX_MESSAGE_BODY_CHARS);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = extractPlainText(part);
    if (text) return text;
  }

  if (payload?.body?.data && mimeType === "text/html") {
    return base64UrlDecode(payload.body.data)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_MESSAGE_BODY_CHARS);
  }

  return "";
}

function extractHtml(payload: Any): string | undefined {
  const mimeType = normalizeString(payload?.mimeType) || "";
  if (payload?.body?.data && mimeType === "text/html") {
    return base64UrlDecode(payload.body.data);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  for (const part of parts) {
    const html = extractHtml(part);
    if (html) return html;
  }

  return undefined;
}

function collectAttachments(payload: Any): ForwardingAttachment[] {
  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  const attachments: ForwardingAttachment[] = [];

  for (const part of parts) {
    const filename = normalizeString(part?.filename);
    const body = part?.body;
    if (filename && (normalizeString(body?.attachmentId) || normalizeString(body?.data))) {
      attachments.push({
        filename,
        mimeType: normalizeString(part?.mimeType) || "application/octet-stream",
        attachmentId: normalizeString(body?.attachmentId),
        inlineData: normalizeString(body?.data),
      });
    }
    attachments.push(...collectAttachments(part));
  }

  return attachments;
}

function extractHeaders(headers: Any[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    const name = normalizeString(header?.name)?.toLowerCase();
    const value = normalizeString(header?.value);
    if (!name || !value) continue;
    if (!(name in result)) {
      result[name] = value;
    }
  }
  return result;
}

function matchesAnyKeyword(text: string, keywords: string[] | undefined): boolean {
  if (!keywords?.length) return false;
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function matchesAttachmentKeywords(
  attachments: ForwardingAttachment[],
  keywords: string[] | undefined,
): boolean {
  if (!keywords?.length) return false;
  return attachments.some((attachment) => matchesAnyKeyword(attachment.filename, keywords));
}

function attachmentMatchesExtensions(
  attachment: ForwardingAttachment,
  allowedExtensions: string[] | undefined,
): boolean {
  if (!allowedExtensions?.length) return true;
  const lower = attachment.filename.toLowerCase();
  return allowedExtensions.some((ext) => lower.endsWith(`.${ext.toLowerCase()}`));
}

function attachmentListMatches(
  attachments: ForwardingAttachment[],
  recipe: MailboxForwardRecipe,
): ForwardingAttachment[] {
  return attachments.filter((attachment) => {
    if (!attachmentMatchesExtensions(attachment, recipe.attachmentExtensions)) {
      return false;
    }
    if (recipe.attachmentKeywords?.length) {
      return matchesAnyKeyword(attachment.filename, recipe.attachmentKeywords);
    }
    return true;
  });
}

function buildForwardedMime(params: {
  to: string;
  subject: string;
  body: string;
  originalFrom?: string;
  originalSubject?: string;
  originalDate?: number;
  originalMessageId: string;
  attachments: Array<{ filename: string; mimeType: string; data: Uint8Array }>;
}): string {
  const boundary = `cowork-forward-${randomUUID()}`;
  const headers = [
    `To: ${escapeHeader(params.to)}`,
    `Subject: ${escapeHeader(params.subject)}`,
    "MIME-Version: 1.0",
    `X-CoWork-Original-Message-Id: ${escapeHeader(params.originalMessageId)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    [
      "Forwarded by CoWork OS",
      params.originalFrom ? `From: ${params.originalFrom}` : null,
      params.originalSubject ? `Original subject: ${params.originalSubject}` : null,
      params.originalDate ? `Original date: ${new Date(params.originalDate).toUTCString()}` : null,
      "",
      params.body,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\r\n"),
  ];

  const parts = [...headers];
  for (const attachment of params.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${escapeHeader(attachment.filename)}"`,
      `Content-Disposition: attachment; filename="${escapeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      encodeBase64Lines(attachment.data),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

export class MailboxForwardingService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private runningAutomationIds = new Set<string>();

  constructor(private deps: MailboxForwardingServiceDeps) {
    this.ensureSchema();
  }

  start(): void {
    this.started = true;
    void this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    if (!this.started) return;
    this.armTimer();
  }

  async runNow(automationId: string): Promise<string> {
    const automation = MailboxAutomationRegistry.listAutomations().find(
      (item) => item.id === automationId && item.kind === "forward",
    );
    if (!automation?.forward) {
      throw new Error("Forwarding automation not found");
    }
    const summary = await this.runAutomation(automation, true);
    await this.refresh();
    return summary.summary;
  }

  private ensureSchema(): void {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_forwarding_message_runs (
        automation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (automation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_forwarding_message_runs_thread
        ON mailbox_forwarding_message_runs(thread_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS mailbox_forwarding_run_state (
        automation_id TEXT PRIMARY KEY,
        last_successful_scan_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) return;

    const now = Date.now();
    const automations = MailboxAutomationRegistry.listAutomations().filter(
      (item) => item.kind === "forward" && item.status === "active" && item.forward,
    );

    let earliest: number | undefined;
    for (const automation of automations) {
      const nextRunAt =
        automation.nextRunAt ?? computeNextRunAtMs(automation.forward!.schedule, now);
      if (nextRunAt !== automation.nextRunAt) {
        MailboxAutomationRegistry.setForwardNextRun(automation.id, nextRunAt);
      }
      if (nextRunAt !== undefined && (earliest === undefined || nextRunAt < earliest)) {
        earliest = nextRunAt;
      }
    }

    const delayMs =
      earliest === undefined
        ? TIMER_FALLBACK_MS
        : Math.max(0, Math.min(TIMER_FALLBACK_MS, earliest - now));
    this.timer = setTimeout(() => {
      void this.processDueAutomations();
    }, delayMs);
  }

  private async processDueAutomations(): Promise<void> {
    if (!this.started) return;
    const now = Date.now();
    const automations = MailboxAutomationRegistry.listAutomations().filter(
      (item) =>
        item.kind === "forward" &&
        item.status === "active" &&
        item.forward &&
        typeof item.nextRunAt === "number" &&
        item.nextRunAt <= now,
    );

    for (const automation of automations) {
      try {
        await this.runAutomation(automation, false);
      } catch (error) {
        logger.error("Forwarding automation failed", {
          automationId: automation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.refresh();
  }

  private async runAutomation(
    automation: MailboxAutomationRecord,
    manual: boolean,
  ): Promise<RunSummary> {
    if (!automation.forward) {
      throw new Error("Forwarding automation is missing recipe data");
    }
    if (this.runningAutomationIds.has(automation.id)) {
      throw new Error("Forwarding automation is already running");
    }

    this.runningAutomationIds.add(automation.id);
    const runAtMs = Date.now();
    MailboxAutomationRegistry.markForwardRunStarted(automation.id, runAtMs);

    try {
      const summary = await this.executeForwardingRun(automation);
      const shouldRemainActive = automation.status === "active";
      const nextRunAt = shouldRemainActive
        ? computeNextRunAtMs(automation.forward.schedule, Date.now())
        : automation.nextRunAt;
      const nextStatus = shouldRemainActive
        ? nextRunAt === undefined && automation.forward.schedule.kind === "at"
          ? "paused"
          : "active"
        : automation.status;
      MailboxAutomationRegistry.markForwardRunFinished(automation.id, {
        status: nextStatus,
        latestOutcome: summary.summary,
        latestFireAt: runAtMs,
        nextRunAt,
      });
      return summary;
    } catch (error) {
      const shouldRemainActive = automation.status === "active";
      const nextRunAt = shouldRemainActive
        ? computeNextRunAtMs(automation.forward.schedule, Date.now())
        : automation.nextRunAt;
      MailboxAutomationRegistry.markForwardRunFinished(automation.id, {
        status: shouldRemainActive
          ? nextRunAt === undefined
            ? "paused"
            : "error"
          : automation.status,
        latestOutcome: "Forwarding run failed",
        latestError: error instanceof Error ? error.message : String(error),
        latestFireAt: runAtMs,
        nextRunAt,
      });
      throw error;
    } finally {
      this.runningAutomationIds.delete(automation.id);
    }
  }

  private async executeForwardingRun(automation: MailboxAutomationRecord): Promise<RunSummary> {
    if (!automation.forward) {
      throw new Error("Forwarding automation is missing recipe data");
    }
    const automationId = automation.id;
    const recipe = automation.forward;
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error("Google Workspace integration is disabled");
    }
    if (settings.scopes && !hasScope(settings.scopes, GOOGLE_SCOPE_GMAIL_MODIFY)) {
      throw new Error(
        "Google Workspace Gmail modify scope is required. Reconnect in Settings > Integrations > Google Workspace.",
      );
    }

    const labelMap = await this.getOrCreateLabels(settings, recipe);
    const lastSuccessfulScanAt = this.getLastSuccessfulScanAt(automationId);
    const earliestTimestamp = this.computeEarliestTimestamp(automation, lastSuccessfulScanAt);
    const threadIds = await this.listCandidateThreadIds(settings, recipe, earliestTimestamp);

    let matchedThreads = 0;
    let matchedMessages = 0;
    let sentMessages = 0;
    let alreadySentMessages = 0;
    let rejectedThreads = 0;
    let failedMessages = 0;

    for (const threadId of threadIds) {
      const threadResult = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/threads/${encodeURIComponent(threadId)}`,
        query: { format: "full" },
      });
      const evaluation = this.evaluateThread(threadResult, recipe, earliestTimestamp);
      if (!evaluation) {
        continue;
      }

      const targetOutcomes: MessageForwardOutcome[] = [];
      if (evaluation.targets.length === 0) {
        await this.applyThreadLabels(settings, threadId, {
          add: [labelMap.rejected],
          remove: [labelMap.candidate, labelMap.forwarded],
        });
        rejectedThreads += 1;
        continue;
      }

      matchedThreads += 1;
      matchedMessages += evaluation.targets.length;

      for (const message of evaluation.targets) {
        const outcome = await this.forwardMessage(settings, automationId, recipe, message);
        targetOutcomes.push(outcome);
        if (outcome.status === "sent") {
          sentMessages += 1;
        } else if (outcome.status === "already_sent") {
          alreadySentMessages += 1;
        } else if (outcome.status === "failed") {
          failedMessages += 1;
        }
      }

      const hasFailures = targetOutcomes.some((outcome) => outcome.status === "failed");
      if (recipe.dryRun) {
        await this.applyThreadLabels(settings, threadId, {
          add: [labelMap.candidate],
          remove: [labelMap.rejected, labelMap.forwarded],
        });
      } else if (hasFailures) {
        await this.applyThreadLabels(settings, threadId, {
          add: [labelMap.candidate],
          remove: [labelMap.rejected, labelMap.forwarded],
        });
      } else {
        await this.applyThreadLabels(settings, threadId, {
          add: [labelMap.forwarded],
          remove: [labelMap.candidate, labelMap.rejected],
        });
      }
    }

    if (!recipe.dryRun && failedMessages === 0) {
      this.setLastSuccessfulScanAt(automationId, Date.now());
    }

    const summary = recipe.dryRun
      ? `Dry run matched ${matchedMessages} message${matchedMessages === 1 ? "" : "s"} across ${matchedThreads} thread${matchedThreads === 1 ? "" : "s"}`
      : `Forwarded ${sentMessages + alreadySentMessages} message${sentMessages + alreadySentMessages === 1 ? "" : "s"} across ${matchedThreads} thread${matchedThreads === 1 ? "" : "s"}`;
    return {
      matchedThreads,
      matchedMessages,
      sentMessages,
      alreadySentMessages,
      rejectedThreads,
      failedMessages,
      dryRun: Boolean(recipe.dryRun),
      summary:
        failedMessages > 0
          ? `${summary} with ${failedMessages} failure${failedMessages === 1 ? "" : "s"}`
          : summary,
    };
  }

  private computeEarliestTimestamp(
    automation: MailboxAutomationRecord,
    lastSuccessfulScanAt?: number,
  ): number {
    const recipe = automation.forward!;
    const now = Date.now();
    const backfillStart = now - recipe.backfillDays! * DAY_MS;
    if (recipe.schedule.kind === "at") {
      return backfillStart;
    }

    if (typeof lastSuccessfulScanAt === "number" && Number.isFinite(lastSuccessfulScanAt)) {
      return Math.max(backfillStart, lastSuccessfulScanAt - SEARCH_WATERMARK_OVERLAP_MS);
    }

    return backfillStart;
  }

  private async listCandidateThreadIds(
    settings: Any,
    recipe: MailboxForwardRecipe,
    earliestTimestamp: number,
  ): Promise<string[]> {
    if (recipe.providerThreadId) {
      return [recipe.providerThreadId];
    }

    const queryParts = [
      recipe.gmailQuery,
      "-in:sent",
      "-in:drafts",
      "has:attachment",
      `after:${formatGmailAfterDate(earliestTimestamp)}`,
    ].filter((value): value is string => Boolean(value));

    const result = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/messages",
      query: {
        q: queryParts.join(" "),
        maxResults: Math.min(MAX_GMAIL_LIST_RESULTS, Math.max(25, recipe.maxMessagesPerRun! * 3)),
      },
    });

    const refs = Array.isArray(result.data?.messages) ? result.data.messages : [];
    const threadIds: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const threadId = normalizeString((ref as Any)?.threadId);
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      threadIds.push(threadId);
      if (threadIds.length >= recipe.maxMessagesPerRun!) {
        break;
      }
    }
    return threadIds;
  }

  private getLastSuccessfulScanAt(automationId: string): number | undefined {
    const row = this.deps.db
      .prepare(
        `SELECT last_successful_scan_at
         FROM mailbox_forwarding_run_state
         WHERE automation_id = ?`,
      )
      .get(automationId) as { last_successful_scan_at: number | null } | undefined;
    const timestamp = row?.last_successful_scan_at;
    return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private setLastSuccessfulScanAt(automationId: string, timestamp: number): void {
    this.deps.db
      .prepare(
        `INSERT INTO mailbox_forwarding_run_state
           (automation_id, last_successful_scan_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           last_successful_scan_at = excluded.last_successful_scan_at,
           updated_at = excluded.updated_at`,
      )
      .run(automationId, timestamp, Date.now());
  }

  private evaluateThread(
    threadResult: GmailRequestResult,
    recipe: MailboxForwardRecipe,
    earliestTimestamp: number,
  ): ThreadEvaluation | null {
    const data = threadResult.data;
    const threadId = normalizeString(data?.id);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    if (!threadId || messages.length === 0) {
      return null;
    }

    const targets: ForwardingMessage[] = [];
    for (const rawMessage of messages) {
      const message = this.normalizeForwardingMessage(rawMessage);
      if (!message) continue;
      if (message.internalDate < earliestTimestamp) continue;
      const senderEmail = message.fromEmail;
      const senderDomain = normalizeDomain(senderEmail);
      const allowed =
        (senderEmail && recipe.allowedSenders.includes(senderEmail)) ||
        (senderDomain && recipe.allowedDomains.includes(senderDomain));
      if (!allowed) continue;
      if (senderEmail && recipe.excludedSenders?.includes(senderEmail)) continue;
      if (senderDomain && recipe.excludedDomains?.includes(senderDomain)) continue;

      const allowedAttachments = attachmentListMatches(message.attachments, recipe);
      if (allowedAttachments.length === 0) continue;

      const keywordMatched =
        (!recipe.subjectKeywords?.length && !recipe.attachmentKeywords?.length) ||
        matchesAnyKeyword(message.subject, recipe.subjectKeywords) ||
        matchesAttachmentKeywords(allowedAttachments, recipe.attachmentKeywords);
      if (!keywordMatched) continue;

      targets.push({
        ...message,
        attachments: allowedAttachments,
      });
    }

    return { threadId, targets };
  }

  private normalizeForwardingMessage(rawMessage: Any): ForwardingMessage | null {
    const id = normalizeString(rawMessage?.id);
    const threadId = normalizeString(rawMessage?.threadId);
    if (!id || !threadId) return null;
    const payload = rawMessage?.payload || {};
    const headers = extractHeaders(Array.isArray(payload.headers) ? payload.headers : []);
    const attachments = collectAttachments(payload);
    const labelIds = Array.isArray(rawMessage?.labelIds)
      ? rawMessage.labelIds
          .map((label: unknown) => normalizeString(label))
          .filter((label: string): label is string => Boolean(label))
      : [];
    return {
      id,
      threadId,
      subject: headers.subject || "(No subject)",
      fromRaw: headers.from,
      fromEmail: normalizeEmail(headers.from),
      internalDate: Number(rawMessage?.internalDate || Date.now()),
      textBody: extractPlainText(payload),
      htmlBody: extractHtml(payload),
      attachments,
      labelIds,
    };
  }

  private async getOrCreateLabels(
    settings: Any,
    recipe: MailboxForwardRecipe,
  ): Promise<{
    forwarded: string;
    rejected: string;
    candidate: string;
  }> {
    const result = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/labels",
    });
    const labels = Array.isArray(result.data?.labels) ? result.data.labels : [];
    const byName = new Map<string, string>();
    for (const label of labels) {
      const name = normalizeString((label as Any)?.name);
      const id = normalizeString((label as Any)?.id);
      if (name && id) {
        byName.set(name, id);
      }
    }

    const ensure = async (name: string): Promise<string> => {
      const existing = byName.get(name);
      if (existing) return existing;
      const created = await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/labels",
        body: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      const id = normalizeString(created.data?.id);
      if (!id) {
        throw new Error(`Failed to create Gmail label: ${name}`);
      }
      byName.set(name, id);
      return id;
    };

    return {
      forwarded: await ensure(recipe.forwardedLabelName || "cowork/forwarded"),
      rejected: await ensure(recipe.rejectedLabelName || "cowork/rejected"),
      candidate: await ensure(recipe.candidateLabelName || "cowork/candidate"),
    };
  }

  private async applyThreadLabels(
    settings: Any,
    threadId: string,
    input: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const add = (input.add || []).filter(Boolean);
    const remove = (input.remove || []).filter(Boolean);
    if (add.length === 0 && remove.length === 0) return;
    await gmailRequest(settings, {
      method: "POST",
      path: `/users/me/threads/${encodeURIComponent(threadId)}/modify`,
      body: {
        addLabelIds: add.length ? Array.from(new Set(add)) : undefined,
        removeLabelIds: remove.length ? Array.from(new Set(remove)) : undefined,
      },
    });
  }

  private async forwardMessage(
    settings: Any,
    automationId: string,
    recipe: MailboxForwardRecipe,
    message: ForwardingMessage,
  ): Promise<MessageForwardOutcome> {
    const alreadyForwarded = this.deps.db
      .prepare(
        `SELECT status FROM mailbox_forwarding_message_runs WHERE automation_id = ? AND message_id = ?`,
      )
      .get(automationId, message.id) as { status: string } | undefined;
    if (alreadyForwarded?.status === "sent") {
      return { status: "already_sent", messageId: message.id };
    }

    if (recipe.dryRun) {
      return { status: "dry_run", messageId: message.id };
    }

    try {
      const attachments: Array<{ filename: string; mimeType: string; data: Uint8Array }> = [];
      for (const attachment of message.attachments) {
        let data: Uint8Array | null = null;
        if (attachment.inlineData) {
          const normalized = attachment.inlineData.replace(/-/g, "+").replace(/_/g, "/");
          const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
          data = Buffer.from(normalized + "=".repeat(padding), "base64");
        } else if (attachment.attachmentId) {
          const attachmentResult = await gmailRequest(settings, {
            method: "GET",
            path: `/users/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
          });
          const attachmentData = normalizeString(attachmentResult.data?.data);
          if (attachmentData) {
            const normalized = attachmentData.replace(/-/g, "+").replace(/_/g, "/");
            const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
            data = Buffer.from(normalized + "=".repeat(padding), "base64");
          }
        }
        if (!data) {
          throw new Error(`Missing attachment data for ${attachment.filename}`);
        }
        attachments.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          data,
        });
      }

      const raw = buildForwardedMime({
        to: recipe.targetEmail,
        subject: message.subject.startsWith("Fwd:") ? message.subject : `Fwd: ${message.subject}`,
        body: message.textBody || "(No plain text body available)",
        originalFrom: message.fromRaw,
        originalSubject: message.subject,
        originalDate: message.internalDate,
        originalMessageId: message.id,
        attachments,
      });
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: {
          raw: encodeMessage(raw),
        },
      });

      const now = Date.now();
      this.deps.db
        .prepare(
          `INSERT INTO mailbox_forwarding_message_runs
             (automation_id, message_id, thread_id, status, error, created_at, updated_at)
           VALUES (?, ?, ?, 'sent', NULL, ?, ?)
           ON CONFLICT(automation_id, message_id) DO UPDATE SET
             status = 'sent',
             error = NULL,
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at`,
        )
        .run(automationId, message.id, message.threadId, now, now);
      return { status: "sent", messageId: message.id };
    } catch (error) {
      const now = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.deps.db
        .prepare(
          `INSERT INTO mailbox_forwarding_message_runs
             (automation_id, message_id, thread_id, status, error, created_at, updated_at)
           VALUES (?, ?, ?, 'error', ?, ?, ?)
           ON CONFLICT(automation_id, message_id) DO UPDATE SET
             status = 'error',
             error = excluded.error,
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at`,
        )
        .run(automationId, message.id, message.threadId, errorMessage, now, now);
      return { status: "failed", messageId: message.id, error: errorMessage };
    }
  }
}
