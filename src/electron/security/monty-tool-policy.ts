import * as fs from "fs/promises";
import * as path from "path";
import type { GatewayContextType, Workspace } from "../../shared/types";
import {
  clampMontyLimits,
  createMontySafeStdlib,
  MontyProgramCache,
  runMontyCode,
  sha256Hex,
  type MontyResourceLimits,
} from "../sandbox/monty-engine";

export type ToolPolicyDecision = {
  decision: "pass" | "deny" | "require_approval";
  reason?: string;
};

const DEFAULT_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 0.3,
  maxAllocations: 150_000,
  maxMemory: 32 * 1024 * 1024,
  gcInterval: 2000,
  maxRecursionDepth: 250,
};

const MAX_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 2,
  maxAllocations: 500_000,
  maxMemory: 96 * 1024 * 1024,
  gcInterval: 100_000,
  maxRecursionDepth: 1200,
};

const programCache = new MontyProgramCache(24);
const isTestEnv = !!process.env.VITEST || process.env.NODE_ENV === "test";

type CachedPolicyFile = { mtimeMs: number; code: string; hash: string };
const fileCache = new Map<string, CachedPolicyFile>();

async function loadPolicyCode(workspacePath: string): Promise<CachedPolicyFile | null> {
  const absPath = path.join(workspacePath, ".cowork", "policy", "tools.monty");
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
  const next: CachedPolicyFile = { mtimeMs: stat.mtimeMs, code, hash };
  fileCache.set(absPath, next);
  return next;
}

function normalizeDecision(raw: unknown): ToolPolicyDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Any;
  const decision = typeof obj.decision === "string" ? obj.decision : "";
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;

  if (decision === "pass") return { decision: "pass", ...(reason ? { reason } : {}) };
  if (decision === "deny") return { decision: "deny", ...(reason ? { reason } : {}) };
  if (decision === "require_approval")
    return { decision: "require_approval", ...(reason ? { reason } : {}) };
  return null;
}

export async function evaluateMontyToolPolicy(args: {
  workspace: Workspace;
  toolName: string;
  toolInput: unknown;
  gatewayContext?: GatewayContextType;
  limits?: MontyResourceLimits;
}): Promise<ToolPolicyDecision> {
  const wsPath = args.workspace?.path;
  if (!wsPath) return { decision: "pass" };

  let cached: CachedPolicyFile | null = null;
  try {
    cached = await loadPolicyCode(wsPath);
  } catch (err) {
    if (!isTestEnv) {
      console.warn("[ToolPolicy] Failed to read tools.monty:", err);
    }
    return { decision: "pass" };
  }

  if (!cached) return { decision: "pass" };

  const clamped = clampMontyLimits(args.limits, MAX_LIMITS) || {};
  const limits: MontyResourceLimits = { ...DEFAULT_LIMITS, ...clamped };

  const stdlib = createMontySafeStdlib();
  const externalFunctions = Object.fromEntries(
    Object.entries(stdlib).map(([k, fn]) => [k, fn as Any]),
  );

  const input = {
    tool: args.toolName,
    params: args.toolInput ?? null,
    gatewayContext: args.gatewayContext ?? null,
    workspace: {
      id: args.workspace.id,
      name: args.workspace.name,
      path: args.workspace.path,
      isTemp: !!args.workspace.isTemp,
      permissions: args.workspace.permissions,
    },
    timestampMs: Date.now(),
  };

  const cacheKey = `tool_policy:${args.workspace.id}:${cached.hash}`;
  const res = await runMontyCode({
    code: cached.code,
    input,
    scriptName: "tools_policy.monty",
    limits,
    externalFunctions,
    cache: programCache,
    cacheKey,
  });

  if (!res.ok) {
    if (!isTestEnv) {
      console.warn("[ToolPolicy] tools.monty failed:", res.error);
    }
    return { decision: "pass" };
  }

  return normalizeDecision(res.output) || { decision: "pass" };
}
