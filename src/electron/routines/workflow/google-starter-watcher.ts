import type { RoutineWorkflowNode, WorkflowInputValue } from "../../../shared/routine-workflow";
import type { Routine } from "../types";
import type { RoutineService } from "../service";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { gmailRequest } from "../../utils/gmail-api";
import { googleDriveRequest } from "../../utils/google-workspace-api";
import { googleCalendarRequest } from "../../utils/google-calendar-api";
import { createLogger } from "../../utils/logger";
import { getGoogleWorkspaceSettingsForAccount } from "../../../shared/google-workspace";

const logger = createLogger("RoutineGoogleStarters");
const DEFAULT_POLL_INTERVAL_MS = 60_000;

type StarterCursor = {
  lastCheckedAt?: number;
  gmailPageToken?: string;
  gmailWindowEndAt?: number;
  drivePageToken?: string;
};

export class GoogleWorkspaceWorkflowStarterWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly db: Any,
    private readonly routineService: RoutineService,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.ensureSchema();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    setTimeout(() => void this.poll(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) return;
    this.polling = true;
    try {
      for (const routine of this.routineService.list()) {
        if (!routine.enabled || !routine.activeWorkflowVersionId) continue;
        const activeWorkflow = this.routineService.getActiveWorkflowDefinition(routine.id);
        if (!activeWorkflow) continue;
        const runtimeRoutine: Routine = { ...routine, workflow: activeWorkflow };
        const starter = activeWorkflow.nodes.find(
          (node) => node.id === activeWorkflow.starterNodeId && node.kind === "starter",
        );
        if (!starter) continue;
        try {
          if (starter.operation === "starter.gmail_message") {
            await this.pollGmail(runtimeRoutine, starter);
          } else if (
            starter.operation === "starter.drive_item_added" ||
            starter.operation === "starter.drive_file_edited" ||
            starter.operation === "starter.drive_folder_item_edited" ||
            starter.operation === "starter.sheet_changed" ||
            starter.operation === "starter.form_response" ||
            starter.operation === "starter.meeting_outputs_ready"
          ) {
            await this.pollDriveChanges(runtimeRoutine, starter);
          } else if (starter.operation === "starter.meeting_relative") {
            await this.pollMeetingRelative(runtimeRoutine, starter);
          }
        } catch (error) {
          logger.debug(`Starter poll failed for ${routine.name}:`, error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollGmail(routine: Routine, starter: RoutineWorkflowNode): Promise<void> {
    const cursor = this.getCursor(routine.id, starter.id);
    const now = Date.now();
    if (!cursor.lastCheckedAt) {
      this.setCursor(routine.id, starter.id, { lastCheckedAt: now });
      return;
    }
    const configuredQuery = literalString(starter.config.query);
    const from = literalString(starter.config.from);
    const subjectContains = literalString(starter.config.subjectContains);
    const windowEndAt = cursor.gmailWindowEndAt || now;
    const query = [
      configuredQuery,
      from ? `from:${quoteGmailSearch(from)}` : "",
      subjectContains ? `subject:${quoteGmailSearch(subjectContains)}` : "",
      `after:${Math.max(0, Math.floor(cursor.lastCheckedAt / 1_000) - 1)}`,
      `before:${Math.floor(windowEndAt / 1_000) + 1}`,
      literalBoolean(starter.config.includeFlowGenerated) ? "" : "-label:cowork-flow-generated",
    ]
      .filter(Boolean)
      .join(" ");
    const settings = this.googleSettingsFor(routine);
    let pageToken = cursor.gmailPageToken || "";
    for (let page = 0; page < 10; page += 1) {
      const listed = await gmailRequest(settings, {
        method: "GET",
        path: "/users/me/messages",
        query: { q: query, maxResults: 100, pageToken: pageToken || undefined },
      });
      const refs = (listed.data?.messages || []) as Array<{ id?: string; threadId?: string }>;
      for (const ref of refs.reverse()) {
        if (!ref.id) continue;
        const message = await gmailRequest(settings, {
          method: "GET",
          path: `/users/me/messages/${encodeURIComponent(ref.id)}`,
          query: { format: "full" },
        });
        const payload = summarizeGmailMessage(message.data);
        this.routineService.enqueueWorkflowEvent({
          routineId: routine.id,
          triggerNodeId: starter.id,
          source: "gmail",
          idempotencyKey: `gmail:${ref.id}`,
          receivedAt: Number(message.data?.internalDate || now),
          payload,
          summary: payload.subject ? `Gmail: ${payload.subject}` : "New Gmail message",
        });
      }
      pageToken = String(listed.data?.nextPageToken || "");
      if (!pageToken) break;
    }
    this.setCursor(
      routine.id,
      starter.id,
      pageToken
        ? { ...cursor, gmailPageToken: pageToken, gmailWindowEndAt: windowEndAt }
        : {
            ...cursor,
            lastCheckedAt: windowEndAt,
            gmailPageToken: undefined,
            gmailWindowEndAt: undefined,
          },
    );
  }

  private async pollDriveChanges(routine: Routine, starter: RoutineWorkflowNode): Promise<void> {
    const cursor = this.getCursor(routine.id, starter.id);
    const settings = this.googleSettingsFor(routine);
    if (!cursor.drivePageToken) {
      const token = await googleDriveRequest(settings, {
        method: "GET",
        path: "/changes/startPageToken",
        query: { supportsAllDrives: true },
      });
      this.setCursor(routine.id, starter.id, {
        ...cursor,
        drivePageToken: String(token.data?.startPageToken || ""),
        lastCheckedAt: Date.now(),
      });
      return;
    }

    let pageToken = cursor.drivePageToken;
    let newStartPageToken = pageToken;
    for (let page = 0; page < 10 && pageToken; page += 1) {
      const result = await googleDriveRequest(settings, {
        method: "GET",
        path: "/changes",
        query: {
          pageToken,
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields:
            "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,createdTime,modifiedTime,webViewLink,trashed))",
        },
      });
      for (const change of result.data?.changes || []) {
        if (!this.driveChangeMatches(starter, change)) continue;
        const file = change.file || {};
        const source =
          starter.operation === "starter.sheet_changed"
            ? "google_sheets"
            : starter.operation === "starter.form_response"
              ? "google_forms"
              : "google_drive";
        this.routineService.enqueueWorkflowEvent({
          routineId: routine.id,
          triggerNodeId: starter.id,
          source,
          idempotencyKey: `drive:${starter.operation}:${change.fileId}:${change.time || file.modifiedTime || "changed"}`,
          receivedAt: Date.parse(change.time || file.modifiedTime || new Date().toISOString()),
          payload: {
            source,
            changeType: starter.operation.replace(/^starter\./, ""),
            fileId: change.fileId,
            id: file.id || change.fileId,
            name: file.name,
            mimeType: file.mimeType,
            parents: file.parents,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            webViewLink: file.webViewLink,
            removed: Boolean(change.removed || file.trashed),
            spreadsheetId:
              starter.operation === "starter.sheet_changed" ? change.fileId : undefined,
            formId: literalString(starter.config.formId),
          },
          summary: file.name ? `Drive change: ${file.name}` : "Drive item changed",
        });
      }
      pageToken = result.data?.nextPageToken || "";
      newStartPageToken = result.data?.newStartPageToken || newStartPageToken;
    }
    this.setCursor(routine.id, starter.id, {
      drivePageToken: pageToken || newStartPageToken,
      lastCheckedAt: Date.now(),
    });
  }

  private driveChangeMatches(starter: RoutineWorkflowNode, change: Any): boolean {
    const file = change.file || {};
    if (file.trashed || change.removed) return false;
    const fileId = String(file.id || change.fileId || "");
    const parents = Array.isArray(file.parents) ? file.parents.map(String) : [];
    switch (starter.operation) {
      case "starter.drive_file_edited":
        return (
          !literalString(starter.config.fileId) || fileId === literalString(starter.config.fileId)
        );
      case "starter.drive_item_added": {
        const folderId = literalString(starter.config.folderId);
        const createdAt = Date.parse(file.createdTime || "");
        const modifiedAt = Date.parse(file.modifiedTime || "");
        return (
          parents.includes(folderId) &&
          Number.isFinite(createdAt) &&
          Math.abs(modifiedAt - createdAt) < 5_000
        );
      }
      case "starter.drive_folder_item_edited":
        return parents.includes(literalString(starter.config.folderId));
      case "starter.sheet_changed":
        return fileId === literalString(starter.config.spreadsheetId);
      case "starter.form_response":
        return (
          Boolean(literalString(starter.config.spreadsheetId)) &&
          fileId === literalString(starter.config.spreadsheetId)
        );
      case "starter.meeting_outputs_ready": {
        const name = String(file.name || "").toLocaleLowerCase();
        return (
          file.mimeType === "application/vnd.google-apps.document" &&
          /(meeting|notes|transcript)/.test(name)
        );
      }
      default:
        return false;
    }
  }

  private async pollMeetingRelative(routine: Routine, starter: RoutineWorkflowNode): Promise<void> {
    const cursor = this.getCursor(routine.id, starter.id);
    const now = Date.now();
    const lastCheckedAt = cursor.lastCheckedAt || now - this.pollIntervalMs * 2;
    const direction = literalString(starter.config.direction) === "after" ? "after" : "before";
    const offsetMs =
      Math.max(0, Number(literalString(starter.config.offsetMinutes) || 15)) * 60_000;
    const calendarId = literalString(starter.config.calendarId) || "primary";
    const query = literalString(starter.config.query);
    const settings = this.googleSettingsFor(routine);
    const events = await googleCalendarRequest(settings, {
      method: "GET",
      path: `/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        timeMin: new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
        timeMax: new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        q: query || undefined,
      },
    });
    for (const event of events.data?.items || []) {
      const startMs = Date.parse(event.start?.dateTime || `${event.start?.date}T00:00:00`);
      const endMs = Date.parse(event.end?.dateTime || `${event.end?.date}T00:00:00`);
      const triggerAt = direction === "before" ? startMs - offsetMs : endMs + offsetMs;
      if (!Number.isFinite(triggerAt) || triggerAt <= lastCheckedAt || triggerAt > now) continue;
      this.routineService.enqueueWorkflowEvent({
        routineId: routine.id,
        triggerNodeId: starter.id,
        source: "google_calendar",
        idempotencyKey: `calendar:${event.id}:${direction}:${offsetMs}:${triggerAt}`,
        receivedAt: triggerAt,
        payload: {
          source: "google_calendar",
          eventId: event.id,
          summary: event.summary,
          description: event.description,
          location: event.location,
          organizer: event.organizer,
          attendees: event.attendees,
          start: event.start,
          end: event.end,
          htmlLink: event.htmlLink,
          direction,
          offsetMinutes: offsetMs / 60_000,
        },
        summary: event.summary ? `Meeting: ${event.summary}` : "Calendar meeting",
      });
    }
    this.setCursor(routine.id, starter.id, { ...cursor, lastCheckedAt: now });
  }

  private getCursor(routineId: string, starterNodeId: string): StarterCursor {
    const row = this.db
      .prepare(
        "SELECT cursor_json FROM routine_starter_cursors WHERE routine_id = ? AND starter_node_id = ?",
      )
      .get(routineId, starterNodeId) as { cursor_json?: string } | undefined;
    if (!row?.cursor_json) return {};
    try {
      return JSON.parse(row.cursor_json) as StarterCursor;
    } catch {
      return {};
    }
  }

  private setCursor(routineId: string, starterNodeId: string, cursor: StarterCursor): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO routine_starter_cursors
         (routine_id, starter_node_id, cursor_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(routineId, starterNodeId, JSON.stringify(cursor), Date.now());
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routine_starter_cursors (
        routine_id TEXT NOT NULL,
        starter_node_id TEXT NOT NULL,
        cursor_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(routine_id, starter_node_id)
      );
    `);
  }

  private googleSettingsFor(routine: Routine) {
    return getGoogleWorkspaceSettingsForAccount(
      GoogleWorkspaceSettingsManager.loadSettings(),
      routine.workflow?.accountBindings?.["google-workspace"],
    );
  }
}

function literalString(value: WorkflowInputValue | undefined): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function literalBoolean(value: WorkflowInputValue | undefined): boolean {
  return value === true || value === "true";
}

function quoteGmailSearch(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

function summarizeGmailMessage(message: Any): Record<string, Any> {
  const headers = new Map<string, string>(
    (message?.payload?.headers || []).map((header: Any) => [
      String(header.name || "").toLocaleLowerCase(),
      String(header.value || ""),
    ]),
  );
  return {
    source: "gmail",
    messageId: message?.id,
    threadId: message?.threadId,
    subject: headers.get("subject") || "",
    from: headers.get("from") || "",
    to: headers.get("to") || "",
    date: headers.get("date") || "",
    body: extractGmailBody(message?.payload),
    snippet: message?.snippet || "",
    labelIds: message?.labelIds || [],
    attachments: collectGmailAttachments(message?.payload),
    internalDate: message?.internalDate,
  };
}

function extractGmailBody(payload: Any): string {
  const parts = flattenGmailParts(payload);
  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data);
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  const data = plain?.body?.data || html?.body?.data;
  if (!data) return "";
  const decoded = Buffer.from(
    String(data).replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  return html && !plain
    ? decoded
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : decoded.trim();
}

function collectGmailAttachments(payload: Any): Array<Record<string, unknown>> {
  return flattenGmailParts(payload)
    .filter((part) => part.filename || part.body?.attachmentId)
    .map((part) => ({
      filename: part.filename,
      mimeType: part.mimeType,
      attachmentId: part.body?.attachmentId,
      size: part.body?.size,
    }));
}

function flattenGmailParts(payload: Any): Any[] {
  if (!payload) return [];
  return [payload, ...(payload.parts || []).flatMap((part: Any) => flattenGmailParts(part))];
}
