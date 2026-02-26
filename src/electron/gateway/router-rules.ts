import * as fs from "fs/promises";
import * as path from "path";
import type { Workspace } from "../../shared/types";
import type { ChannelType, IncomingMessage, MessageAttachment } from "./channels/types";
import {
  clampMontyLimits,
  createMontySafeStdlib,
  MontyProgramCache,
  runMontyCode,
  sha256Hex,
  type MontyResourceLimits,
} from "../sandbox/monty-engine";

export type RouterRuleResult =
  | { action: "pass" }
  | { action: "ignore"; reason?: string }
  | { action: "reply"; text: string; parseMode?: "markdown" }
  | { action: "rewrite"; text: string }
  | { action: "set_workspace"; workspaceId: string; text?: string }
  | { action: "set_agent"; agentRoleId: string; workspaceId?: string; text?: string };

const ROUTER_DEFAULT_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 0.25,
  maxAllocations: 120_000,
  maxMemory: 24 * 1024 * 1024,
  gcInterval: 2000,
  maxRecursionDepth: 200,
};

const ROUTER_MAX_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 1,
  maxAllocations: 300_000,
  maxMemory: 64 * 1024 * 1024,
  gcInterval: 100_000,
  maxRecursionDepth: 800,
};

const programCache = new MontyProgramCache(24);

type CachedFile = { mtimeMs: number; code: string; hash: string };
const fileCache = new Map<string, CachedFile>();

function summarizeAttachments(attachments?: MessageAttachment[]): Any[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.slice(0, 20).map((a) => ({
    type: a.type,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.size,
    url: a.url ? "[redacted]" : undefined,
  }));
}

function normalizeRuleResult(raw: unknown): RouterRuleResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Any;
  const action = typeof obj.action === "string" ? obj.action : "";

  if (action === "pass") return { action: "pass" };
  if (action === "ignore")
    return { action: "ignore", reason: typeof obj.reason === "string" ? obj.reason : undefined };
  if (action === "reply") {
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text.trim()) return null;
    const parseMode = obj.parseMode === "markdown" ? "markdown" : undefined;
    return { action: "reply", text, ...(parseMode ? { parseMode } : {}) };
  }
  if (action === "rewrite") {
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text.trim()) return null;
    return { action: "rewrite", text };
  }
  if (action === "set_workspace") {
    const workspaceId = typeof obj.workspaceId === "string" ? obj.workspaceId.trim() : "";
    if (!workspaceId) return null;
    const text = typeof obj.text === "string" ? obj.text : undefined;
    return { action: "set_workspace", workspaceId, ...(text ? { text } : {}) };
  }
  if (action === "set_agent") {
    const agentRoleId = typeof obj.agentRoleId === "string" ? obj.agentRoleId.trim() : "";
    if (!agentRoleId) return null;
    const workspaceId = typeof obj.workspaceId === "string" ? obj.workspaceId.trim() : undefined;
    const text = typeof obj.text === "string" ? obj.text : undefined;
    return {
      action: "set_agent",
      agentRoleId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(text ? { text } : {}),
    };
  }

  return null;
}

async function loadRulesCode(workspacePath: string): Promise<CachedFile | null> {
  const absPath = path.join(workspacePath, ".cowork", "router", "rules.monty");
  let stat: Any;
  try {
    stat = await fs.stat(absPath);
  } catch (err: Any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  if (!stat.isFile()) return null;

  const cached = fileCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const code = await fs.readFile(absPath, "utf8");
  const hash = sha256Hex(code);
  const next: CachedFile = { mtimeMs: stat.mtimeMs, code, hash };
  fileCache.set(absPath, next);
  return next;
}

export async function evaluateWorkspaceRouterRules(args: {
  workspace: Workspace;
  channelType: ChannelType;
  sessionId: string;
  message: IncomingMessage;
  contextType?: "dm" | "group";
  taskId?: string | null;
  limits?: MontyResourceLimits;
}): Promise<RouterRuleResult | null> {
  const wsPath = args.workspace?.path;
  if (!wsPath) return null;

  const cached = await loadRulesCode(wsPath);
  if (!cached) return null;

  const clamped = clampMontyLimits(args.limits, ROUTER_MAX_LIMITS) || {};
  const limits: MontyResourceLimits = { ...ROUTER_DEFAULT_LIMITS, ...clamped };

  const stdlib = createMontySafeStdlib();
  const externalFunctions = Object.fromEntries(
    Object.entries(stdlib).map(([k, fn]) => [k, fn as Any]),
  );

  const input = {
    channel: args.channelType,
    contextType: args.contextType || (args.message.isGroup ? "group" : "dm"),
    sessionId: args.sessionId,
    taskId: args.taskId || null,
    chatId: args.message.chatId,
    messageId: args.message.messageId,
    userId: args.message.userId,
    userName: args.message.userName,
    isGroup: !!args.message.isGroup,
    text: args.message.text,
    timestampMs: args.message.timestamp?.getTime?.() ?? Date.now(),
    attachments: summarizeAttachments(args.message.attachments),
    workspace: {
      id: args.workspace.id,
      name: args.workspace.name,
      path: args.workspace.path,
    },
  };

  const cacheKey = `router:${args.workspace.id}:${cached.hash}`;
  const res = await runMontyCode({
    code: cached.code,
    input,
    scriptName: "router_rules.monty",
    limits,
    externalFunctions,
    cache: programCache,
    cacheKey,
  });

  if (!res.ok) {
    console.warn("[RouterRules] rules.monty failed:", res.error);
    return null;
  }

  const normalized = normalizeRuleResult(res.output);
  if (!normalized || normalized.action === "pass") return null;
  return normalized;
}
