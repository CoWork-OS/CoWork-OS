import type { RoutineWorkflowActionExecutorParams } from "./engine";
import { getWorkflowOperation } from "./catalog";
import { MCPClientManager } from "../../mcp/client/MCPClientManager";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { gmailRequest } from "../../utils/gmail-api";
import { googleDriveRequest, googleDriveUpload } from "../../utils/google-workspace-api";
import { googleCalendarRequest } from "../../utils/google-calendar-api";
import {
  getGoogleWorkspaceAccessToken,
  refreshGoogleWorkspaceAccessToken,
} from "../../utils/google-workspace-auth";
import { getGoogleWorkspaceSettingsForAccount } from "../../../shared/google-workspace";
import { RoutineWorkflowSecretStore } from "./secret-store";
import { executeSignedWebhook } from "./signed-webhook";
import type { Routine } from "../types";

export interface RoutineWorkflowActionExecutorDeps {
  createAgentTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
  }) => Promise<{ id: string }>;
  getTaskSnapshot: (taskId: string) =>
    | Promise<{
        status: string;
        resultSummary?: string | null;
        semanticSummary?: string | null;
        error?: string | null;
      } | null>
    | {
        status: string;
        resultSummary?: string | null;
        semanticSummary?: string | null;
        error?: string | null;
      }
    | null;
  cancelAgentTask?: (taskId: string) => Promise<void>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function createRoutineWorkflowActionExecutor(deps: RoutineWorkflowActionExecutorDeps) {
  const now = deps.now || (() => Date.now());
  const sleep =
    deps.sleep ||
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const secretStore = new RoutineWorkflowSecretStore();

  return async (params: RoutineWorkflowActionExecutorParams): Promise<Record<string, unknown>> => {
    const definition = getWorkflowOperation(params.node.operation);
    if (params.dryRun) {
      return {
        preview: true,
        operation: params.node.operation,
        risk: definition?.risk || "external_write",
        input: params.input,
      };
    }

    if (params.node.operation.startsWith("ai.") || params.node.operation === "agent.run") {
      return executeAgentBackedAction(params, deps, now, sleep);
    }

    if (params.node.operation.startsWith("gmail.")) {
      return executeGmailAction(
        params.node.operation,
        params.input,
        resolveGoogleSettings(params.workflow.accountBindings?.["google-workspace"]),
        params.signal,
      );
    }

    if (params.node.operation === "drive.save_attachments") {
      return saveGmailAttachmentsToDrive(
        params.input,
        resolveGoogleSettings(params.workflow.accountBindings?.["google-workspace"]),
        params.signal,
      );
    }

    if (params.node.operation === "custom.webhook") {
      const secretRef = requireString(params.input.secretRef, "secretRef");
      const result = await executeSignedWebhook({
        url: requireString(params.input.url, "url"),
        method: typeof params.input.method === "string" ? params.input.method : undefined,
        body: params.input.body,
        secret: secretStore.resolve(secretRef),
        idempotencyKey: `${params.runId}:${params.node.id}`,
        timeoutMs: params.node.timeoutMs,
        signal: params.signal,
      });
      return { ...result };
    }

    if (isDirectGoogleWorkspaceOperation(params.node.operation)) {
      return executeGoogleWorkspaceAction(
        params.node.operation,
        params.input,
        resolveGoogleSettings(params.workflow.accountBindings?.["google-workspace"]),
        params.signal,
      );
    }

    const toolName =
      params.node.operation === "custom.mcp_tool"
        ? requireString(params.input.toolName, "toolName")
        : definition?.toolName;
    if (toolName) {
      throwIfAborted(params.signal);
      const manager = MCPClientManager.getInstance();
      assertConnectorPolicyAllowsTool(params.routine, manager, toolName);
      const args =
        params.node.operation === "custom.mcp_tool"
          ? requireRecord(params.input.arguments, "arguments")
          : normalizeMcpArguments(params.node.operation, params.input);
      validateMcpToolArguments(manager, toolName, args);
      const result = await manager.callTool(toolName, args);
      throwIfAborted(params.signal);
      return normalizeMcpResult(result);
    }

    throw new Error(
      `${definition?.name || params.node.operation} is not available in this CoWork runtime.`,
    );
  };
}

async function executeAgentBackedAction(
  params: RoutineWorkflowActionExecutorParams,
  deps: RoutineWorkflowActionExecutorDeps,
  now: () => number,
  sleep: (delayMs: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  const prompt = buildAgentActionPrompt(params.node.operation, params.input);
  const task = await deps.createAgentTask({
    title: `${params.routine.name}: ${params.node.name}`,
    prompt,
    workspaceId: params.routine.workspaceId,
  });
  if (params.signal.aborted) {
    await deps.cancelAgentTask?.(task.id).catch(() => undefined);
    throwIfAborted(params.signal);
  }
  const onAbort = () => void deps.cancelAgentTask?.(task.id).catch(() => undefined);
  params.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = now() + Math.max(5_000, params.node.timeoutMs || 120_000);
  try {
    while (now() < deadline) {
      throwIfAborted(params.signal);
      const snapshot = await deps.getTaskSnapshot(task.id);
      if (!snapshot) throw new Error(`Workflow action task disappeared: ${task.id}`);
      if (snapshot.status === "completed") {
        const text = snapshot.resultSummary || snapshot.semanticSummary || "";
        const parsed = parsePotentialJson(text);
        if (params.node.operation === "ai.decide") {
          const decision =
            typeof parsed?.decision === "boolean"
              ? parsed.decision
              : /^(true|yes)\b/i.test(String(text).trim());
          return { taskId: task.id, text, decision, reason: parsed?.reason || text };
        }
        if (params.input.outputType === "list") {
          const items = Array.isArray(parsed)
            ? parsed
            : String(text)
                .split("\n")
                .map((line) => line.replace(/^[-*]\s*/, "").trim())
                .filter(Boolean);
          return { taskId: task.id, text, items };
        }
        return { taskId: task.id, text, ...(isRecord(parsed) ? { json: parsed } : {}) };
      }
      if (snapshot.status === "failed" || snapshot.status === "cancelled") {
        throw new Error(snapshot.error || `Workflow action task ${snapshot.status}.`);
      }
      await abortableSleep(sleep, 750, params.signal);
    }
    throw new Error(`${params.node.name} did not complete before its workflow timeout.`);
  } finally {
    params.signal.removeEventListener("abort", onAbort);
  }
}

function buildAgentActionPrompt(operation: string, input: Record<string, unknown>): string {
  const payload = JSON.stringify(input, null, 2);
  const common = [
    "You are executing one deterministic CoWork workflow step.",
    "Do not perform external writes or call external services.",
    "Return only the requested result; do not explain the workflow.",
  ];
  switch (operation) {
    case "ai.summarize":
    case "ai.recap_unread_emails":
      return [...common, "Create a concise factual summary of this input:", payload].join("\n\n");
    case "ai.extract":
      return [
        ...common,
        "Extract the requested structured information. Return valid JSON when a schema is supplied:",
        payload,
      ].join("\n\n");
    case "ai.decide":
      return [...common, "Return JSON with boolean decision and string reason:", payload].join(
        "\n\n",
      );
    case "ai.ask_gemini":
    case "ai.ask_gem":
      return [
        ...common,
        "Answer the supplied request. Respect outputType when present:",
        payload,
      ].join("\n\n");
    case "agent.run":
      return String(input.prompt || payload);
    default:
      return [...common, payload].join("\n\n");
  }
}

async function executeGmailAction(
  operation: string,
  input: Record<string, unknown>,
  settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!settings.enabled) throw new Error("Google Workspace is not connected.");

  switch (operation) {
    case "gmail.notify": {
      const raw = buildRawEmail(input);
      const result = await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: { raw },
        signal,
      });
      return { messageId: result.data?.id, threadId: result.data?.threadId };
    }
    case "gmail.draft_email": {
      const raw = buildRawEmail(input);
      const result = await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/drafts",
        body: { message: { raw } },
        signal,
      });
      return {
        draftId: result.data?.id,
        messageId: result.data?.message?.id,
        threadId: result.data?.message?.threadId,
      };
    }
    case "gmail.draft_reply": {
      const messageId = requireString(input.messageId, "messageId");
      const message = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/messages/${encodeURIComponent(messageId)}`,
        query: { format: "metadata" },
        signal,
      });
      const threadId = String(message.data?.threadId || "");
      const raw = buildRawEmail({ ...input, subject: input.subject || "Re:" });
      const result = await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/drafts",
        body: { message: { raw, threadId } },
        signal,
      });
      return { draftId: result.data?.id, messageId: result.data?.message?.id, threadId };
    }
    case "gmail.archive": {
      const threadId = requireString(input.threadId, "threadId");
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(threadId)}/modify`,
        body: { removeLabelIds: ["INBOX"] },
        signal,
      });
      return { threadId };
    }
    case "gmail.add_labels":
    case "gmail.remove_labels": {
      const messageIds = requireStringArray(input.messageIds, "messageIds");
      const labels = await resolveGmailLabelIds(
        settings,
        requireStringArray(input.labels, "labels"),
        signal,
      );
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/batchModify",
        body: {
          ids: messageIds,
          ...(operation === "gmail.add_labels"
            ? { addLabelIds: labels }
            : { removeLabelIds: labels }),
        },
        signal,
      });
      return { messageIds, labels };
    }
    case "gmail.mark_read":
    case "gmail.star": {
      const messageIds = requireStringArray(input.messageIds, "messageIds");
      const enabled =
        operation === "gmail.mark_read" ? Boolean(input.read) : Boolean(input.starred);
      const label = operation === "gmail.mark_read" ? "UNREAD" : "STARRED";
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/batchModify",
        body: {
          ids: messageIds,
          ...(operation === "gmail.mark_read"
            ? enabled
              ? { removeLabelIds: [label] }
              : { addLabelIds: [label] }
            : enabled
              ? { addLabelIds: [label] }
              : { removeLabelIds: [label] }),
        },
        signal,
      });
      return { messageIds, [operation === "gmail.mark_read" ? "read" : "starred"]: enabled };
    }
    default:
      throw new Error(`Unsupported Gmail workflow action: ${operation}`);
  }
}

const DIRECT_GOOGLE_WORKSPACE_OPERATIONS = new Set([
  "chat.notify",
  "sheets.add_row",
  "sheets.update_rows",
  "sheets.clear_rows",
  "sheets.get_contents",
  "drive.create_folder",
  "calendar.block_time",
  "docs.create",
  "docs.append",
  "tasks.create",
]);

function isDirectGoogleWorkspaceOperation(operation: string): boolean {
  return DIRECT_GOOGLE_WORKSPACE_OPERATIONS.has(operation);
}

async function executeGoogleWorkspaceAction(
  operation: string,
  input: Record<string, unknown>,
  settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!settings.enabled) throw new Error("Google Workspace is not connected.");
  switch (operation) {
    case "chat.notify": {
      const spaceName = normalizeGoogleResource(
        requireString(input.spaceName, "spaceName"),
        "spaces",
      );
      const result = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://chat.googleapis.com/v1",
        path: `/${spaceName}/messages`,
        body: { text: requireString(input.text, "text") },
        signal,
      });
      return { message: result };
    }
    case "sheets.add_row": {
      const spreadsheetId = requireString(input.spreadsheetId, "spreadsheetId");
      const range = requireString(input.range, "range");
      const values = normalizeRows(input.values);
      const result = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://sheets.googleapis.com/v4",
        path: `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
        query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
        body: { values },
        signal,
      });
      return { updates: result.updates, tableRange: result.tableRange, spreadsheetId };
    }
    case "sheets.update_rows": {
      const spreadsheetId = requireString(input.spreadsheetId, "spreadsheetId");
      const range = requireString(input.range, "range");
      const result = await googleJsonRequest(settings, {
        method: "PUT",
        baseUrl: "https://sheets.googleapis.com/v4",
        path: `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        query: { valueInputOption: "USER_ENTERED" },
        body: { values: normalizeRows(input.values) },
        signal,
      });
      return { ...result };
    }
    case "sheets.clear_rows": {
      const spreadsheetId = requireString(input.spreadsheetId, "spreadsheetId");
      const range = requireString(input.range, "range");
      const result = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://sheets.googleapis.com/v4",
        path: `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
        body: {},
        signal,
      });
      return { ...result };
    }
    case "sheets.get_contents": {
      const spreadsheetId = requireString(input.spreadsheetId, "spreadsheetId");
      const range = requireString(input.range, "range");
      const result = await googleJsonRequest(settings, {
        method: "GET",
        baseUrl: "https://sheets.googleapis.com/v4",
        path: `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        signal,
      });
      return {
        range: result.range,
        majorDimension: result.majorDimension,
        values: result.values || [],
      };
    }
    case "drive.create_folder": {
      const result = await googleDriveRequest(settings, {
        method: "POST",
        path: "/files",
        query: { fields: "id,name,mimeType,webViewLink,parents" },
        body: {
          name: requireString(input.name, "name"),
          mimeType: "application/vnd.google-apps.folder",
          ...(typeof input.parentId === "string" && input.parentId.trim()
            ? { parents: [input.parentId.trim()] }
            : {}),
        },
        signal,
      });
      return { ...requireRecord(result.data, "Drive folder response") };
    }
    case "calendar.block_time": {
      const calendarId =
        typeof input.calendarId === "string" && input.calendarId.trim()
          ? input.calendarId.trim()
          : "primary";
      const timeZone = typeof input.timeZone === "string" ? input.timeZone : undefined;
      const result = await googleCalendarRequest(settings, {
        method: "POST",
        path: `/calendars/${encodeURIComponent(calendarId)}/events`,
        body: {
          summary: requireString(input.summary, "summary"),
          description: typeof input.description === "string" ? input.description : undefined,
          start: normalizeCalendarTime(input.start, timeZone),
          end: normalizeCalendarTime(input.end, timeZone),
        },
        signal,
      });
      return { event: result.data };
    }
    case "docs.create": {
      const document = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://docs.googleapis.com/v1",
        path: "/documents",
        body: { title: requireString(input.title, "title") },
        signal,
      });
      const documentId = requireString(document.documentId, "documentId");
      if (typeof input.content === "string" && input.content) {
        await googleJsonRequest(settings, {
          method: "POST",
          baseUrl: "https://docs.googleapis.com/v1",
          path: `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
          body: { requests: [{ insertText: { location: { index: 1 }, text: input.content } }] },
          signal,
        });
      }
      return { documentId, documentUrl: `https://docs.google.com/document/d/${documentId}/edit` };
    }
    case "docs.append": {
      const documentId = requireString(input.documentId, "documentId");
      const document = await googleJsonRequest(settings, {
        method: "GET",
        baseUrl: "https://docs.googleapis.com/v1",
        path: `/documents/${encodeURIComponent(documentId)}`,
        signal,
      });
      const content = Array.isArray(document.body?.content) ? document.body.content : [];
      const lastEndIndex = Number(content.at(-1)?.endIndex || 1);
      const result = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://docs.googleapis.com/v1",
        path: `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        body: {
          requests: [
            {
              insertText: {
                location: { index: Math.max(1, lastEndIndex - 1) },
                text: requireString(input.text, "text"),
              },
            },
          ],
        },
        signal,
      });
      return { documentId, replies: result.replies || [] };
    }
    case "tasks.create": {
      const tasklistId =
        typeof input.tasklist === "string" && input.tasklist.trim()
          ? input.tasklist.trim()
          : "@default";
      const task = await googleJsonRequest(settings, {
        method: "POST",
        baseUrl: "https://tasks.googleapis.com/tasks/v1",
        path: `/lists/${encodeURIComponent(tasklistId)}/tasks`,
        body: {
          title: requireString(input.title, "title"),
          notes: typeof input.notes === "string" ? input.notes : undefined,
          due: typeof input.due === "string" && input.due ? input.due : undefined,
        },
        signal,
      });
      return { task };
    }
    default:
      throw new Error(`Unsupported Google Workspace workflow action: ${operation}`);
  }
}

async function saveGmailAttachmentsToDrive(
  input: Record<string, unknown>,
  settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!settings.enabled) throw new Error("Google Workspace is not connected.");
  const messageId = requireString(input.messageId, "messageId");
  const folderId = requireString(input.folderId, "folderId");
  const message = await gmailRequest(settings, {
    method: "GET",
    path: `/users/me/messages/${encodeURIComponent(messageId)}`,
    query: { format: "full" },
    signal,
  });
  const attachments = collectAttachmentParts(message.data?.payload);
  const files: Array<Record<string, unknown>> = [];
  for (const attachment of attachments.slice(0, 50)) {
    const body = await gmailRequest(settings, {
      method: "GET",
      path: `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
      signal,
    });
    const bytes = decodeBase64Url(String(body.data?.data || ""));
    const metadata = await googleDriveRequest(settings, {
      method: "POST",
      path: "/files",
      query: { fields: "id,name,mimeType,webViewLink" },
      body: {
        name: attachment.filename,
        mimeType: attachment.mimeType || "application/octet-stream",
        parents: [folderId],
      },
      signal,
    });
    const fileId = requireString(metadata.data?.id, "created Drive file ID");
    await googleDriveUpload(
      settings,
      fileId,
      bytes,
      attachment.mimeType || "application/octet-stream",
      signal,
    );
    files.push({
      id: fileId,
      name: attachment.filename,
      mimeType: attachment.mimeType,
      webViewLink: metadata.data?.webViewLink,
    });
  }
  return { files, count: files.length };
}

function normalizeMcpArguments(
  operation: string,
  input: Record<string, unknown>,
): Record<string, Any> {
  switch (operation) {
    case "sheets.add_row":
    case "sheets.update_rows":
      return {
        ...input,
        values:
          Array.isArray(input.values) && !Array.isArray(input.values[0])
            ? [input.values]
            : input.values,
      };
    case "calendar.block_time":
      return {
        calendarId: input.calendarId || "primary",
        summary: input.summary,
        description: input.description,
        start: isRecord(input.start)
          ? input.start
          : { dateTime: input.start, timeZone: input.timeZone },
        end: isRecord(input.end) ? input.end : { dateTime: input.end, timeZone: input.timeZone },
        confirm: true,
      };
    case "tasks.create":
      return {
        tasklistId: input.tasklist || input.tasklistId || "@default",
        title: input.title,
        notes: input.notes,
        due: input.due,
      };
    default:
      return { ...input };
  }
}

function normalizeMcpResult(result: Any): Record<string, unknown> {
  const textParts = Array.isArray(result?.content)
    ? result.content
        .filter((item: Any) => item?.type === "text")
        .map((item: Any) => String(item.text || ""))
    : [];
  const text = textParts.join("\n").trim();
  const parsed = parsePotentialJson(text);
  if (isRecord(parsed)) return { ...parsed, text };
  if (Array.isArray(parsed)) return { items: parsed, text };
  return { text, content: result?.content || [] };
}

async function googleJsonRequest(
  settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
  options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    baseUrl: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<Record<string, Any>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const url = `${options.baseUrl}${options.path}${params.size ? `?${params.toString()}` : ""}`;
  const requestOnce = async (accessToken: string) => {
    const controller = new AbortController();
    const timeoutMs = Math.min(Math.max(Number(settings.timeoutMs) || 20_000, 1_000), 60_000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const data = parsePotentialJson(text);
      if (!response.ok) {
        const detail = isRecord(data)
          ? String(data.error?.message || data.message || response.statusText)
          : text || response.statusText;
        throw Object.assign(new Error(`Google Workspace API error ${response.status}: ${detail}`), {
          status: response.status,
        });
      }
      return isRecord(data) ? data : {};
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("Google Workspace API request was cancelled.");
        }
        throw new Error("Google Workspace API request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  const accessToken = await getGoogleWorkspaceAccessToken(settings);
  try {
    return await requestOnce(accessToken);
  } catch (error: Any) {
    if (error?.status !== 401 || !settings.refreshToken) throw error;
    return requestOnce(await refreshGoogleWorkspaceAccessToken(settings));
  }
}

function normalizeRows(value: unknown): unknown[][] {
  if (!Array.isArray(value)) throw new Error("values must be a list.");
  return Array.isArray(value[0]) ? (value as unknown[][]) : [value];
}

function normalizeCalendarTime(value: unknown, timeZone?: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  const dateTime = requireString(value, "calendar time");
  return { dateTime, ...(timeZone ? { timeZone } : {}) };
}

function normalizeGoogleResource(value: string, collection: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  return normalized.startsWith(`${collection}/`) ? normalized : `${collection}/${normalized}`;
}

function buildRawEmail(input: Record<string, unknown>): string {
  const headers: string[] = [];
  const to = stringOrCsv(input.to);
  const cc = stringOrCsv(input.cc);
  const bcc = stringOrCsv(input.bcc);
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (typeof input.subject === "string" && input.subject) headers.push(`Subject: ${input.subject}`);
  headers.push(
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  );
  const encodedBody = Buffer.from(String(input.body || ""), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function resolveGmailLabelIds(
  settings: Any,
  names: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const result = await gmailRequest(settings, {
    method: "GET",
    path: "/users/me/labels",
    signal,
  });
  const labels = (result.data?.labels || []) as Array<{ id: string; name: string }>;
  const byName = new Map(labels.map((label) => [label.name.toLocaleLowerCase(), label.id]));
  return names.map((name) => byName.get(name.toLocaleLowerCase()) || name);
}

function collectAttachmentParts(
  payload: Any,
): Array<{ filename: string; mimeType?: string; attachmentId: string }> {
  if (!payload || typeof payload !== "object") return [];
  const own =
    payload.filename && payload.body?.attachmentId
      ? [
          {
            filename: String(payload.filename),
            mimeType: payload.mimeType ? String(payload.mimeType) : undefined,
            attachmentId: String(payload.body.attachmentId),
          },
        ]
      : [];
  return own.concat((payload.parts || []).flatMap((part: Any) => collectAttachmentParts(part)));
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function stringOrCsv(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

function requireString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a list.`);
  const normalized = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  if (normalized.length === 0) throw new Error(`${field} needs at least one value.`);
  return normalized;
}

function assertConnectorPolicyAllowsTool(
  routine: Routine,
  manager: MCPClientManager,
  toolName: string,
): void {
  if (routine.connectorPolicy.mode !== "allowlist") return;
  const serverId = manager.getServerIdForTool(toolName);
  const connectorId = manager.getConnectorIdForTool(toolName);
  const allowed = new Set(routine.connectorPolicy.connectorIds);
  if (!serverId || (!allowed.has(serverId) && (!connectorId || !allowed.has(connectorId)))) {
    throw new Error(`Connector policy does not allow workflow tool "${toolName}".`);
  }
}

function validateMcpToolArguments(
  manager: MCPClientManager,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const tool = manager.getAllTools().find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Tool ${toolName} is not connected.`);
  validateSchemaValue(args, tool.inputSchema, "arguments");
}

function validateSchemaValue(value: unknown, schema: Any, path: string): void {
  if (!schema || typeof schema !== "object") return;
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) throw new Error(`${path} must be an object.`);
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!(required in value)) throw new Error(`${path}.${required} is required.`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !(key in properties));
      if (unknown) throw new Error(`${path}.${unknown} is not accepted by ${path}.`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateSchemaValue(child, properties[key], `${path}.${key}`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be a list.`);
    value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}.${index}`));
    return;
  }
  if (type === "string" && typeof value !== "string") throw new Error(`${path} must be text.`);
  if ((type === "number" || type === "integer") && typeof value !== "number")
    throw new Error(`${path} must be a number.`);
  if (type === "boolean" && typeof value !== "boolean")
    throw new Error(`${path} must be true or false.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error(`${path} must be one of the connector's allowed values.`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow action was cancelled.");
}

async function abortableSleep(
  sleep: (delayMs: number) => Promise<void>,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(delayMs),
      new Promise<void>((_resolve, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Workflow action was cancelled."),
          );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function requireRecord(value: unknown, field: string): Record<string, Any> {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function parsePotentialJson(value: unknown): Any {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, Any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveGoogleSettings(accountEmail?: string) {
  return getGoogleWorkspaceSettingsForAccount(
    GoogleWorkspaceSettingsManager.loadSettings(),
    accountEmail,
  );
}
