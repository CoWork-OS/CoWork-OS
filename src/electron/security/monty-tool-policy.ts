import * as path from "path";
import type { GatewayContextType, Workspace } from "../../shared/types";
import {
  clampMontyLimits,
  createMontySafeStdlib,
  runMontyCode,
  type MontyResourceLimits,
} from "../sandbox/monty-engine";

export type ToolPolicyDecision = {
  decision: "pass" | "deny" | "require_approval";
  reason?: string;
};

/** Stable reason used when a configured workspace policy cannot be evaluated. */
export const TOOL_POLICY_UNAVAILABLE_REASON = "workspace tool policy unavailable";

/**
 * Decisions for tools whose default was chosen deliberately, used when the workspace has no
 * tools.monty. A workspace policy always decides first.
 *
 * list_terminal_tabs passes: it returns the user's terminal tabs' names, folders and status,
 * never their output.
 *
 * read_terminal requires approval: a shell tab can hold secrets the redaction patterns miss,
 * such as a typed password, a pasted token, or another project's output, and reading it sends
 * that text to the model provider. The registry turns this into one consent per tab for the task
 * (TerminalTabTools.requestReadConsent, "Allow for this task") that names the tab, rather than
 * a prompt per read; a tab this task's code block run opened needs none, since the user ran it.
 * The tool also checks that consent itself, so a tools.monty that passes cannot skip it.
 */
const DEFAULT_TOOL_DECISIONS: ReadonlyMap<string, ToolPolicyDecision> = new Map<
  string,
  ToolPolicyDecision
>([
  ["list_terminal_tabs", { decision: "pass" }],
  [
    "read_terminal",
    {
      decision: "require_approval",
      reason: "terminal output can hold secrets that redaction misses",
    },
  ],
]);

function defaultToolDecision(toolName: string): ToolPolicyDecision {
  return { ...(DEFAULT_TOOL_DECISIONS.get(toolName) ?? { decision: "pass" }) };
}

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

const isTestEnv = !!process.env.VITEST || process.env.NODE_ENV === "test";

type CachedPolicyFile = { mtimeMs: number; code: string };
const fileCache = new Map<string, CachedPolicyFile>();
const nativeFs = process.getBuiltinModule("fs") as typeof import("node:fs");

async function loadPolicyCode(workspacePath: string): Promise<CachedPolicyFile | null> {
  const absPath = path.join(workspacePath, ".cowork", "policy", "tools.monty");
  let stat: Any;
  try {
    stat = await nativeFs.promises.stat(absPath);
  } catch (err: Any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  // A path that is not a regular file is "no policy configured", not a policy
  // failure. The caller turns a throw here into a blanket deny for every tool
  // in the workspace, so a checked-in directory named tools.monty — or a file
  // the app cannot read — would otherwise brick the workspace with no
  // remediation path.
  if (!stat.isFile()) return null;

  const cached = fileCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const code = await nativeFs.promises.readFile(absPath, "utf8");
  const next: CachedPolicyFile = { mtimeMs: stat.mtimeMs, code };
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
  if (!wsPath) return defaultToolDecision(args.toolName);

  const unavailable = (): ToolPolicyDecision => ({
    decision: "deny",
    reason: TOOL_POLICY_UNAVAILABLE_REASON,
  });

  let cached: CachedPolicyFile | null = null;
  try {
    cached = await loadPolicyCode(wsPath);
  } catch (err) {
    if (!isTestEnv) {
      console.warn("[ToolPolicy] Failed to read tools.monty:", err);
    }
    return unavailable();
  }

  if (!cached) return defaultToolDecision(args.toolName);

  const clamped = clampMontyLimits(args.limits, MAX_LIMITS) || {};
  const limits: MontyResourceLimits = { ...DEFAULT_LIMITS, ...clamped };

  try {
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

    const res = await runMontyCode({
      code: cached.code,
      input,
      scriptName: "tools_policy.monty",
      limits,
      externalFunctions,
    });

    if (!res.ok) {
      if (!isTestEnv) {
        console.warn("[ToolPolicy] tools.monty failed:", res.error);
      }
      return unavailable();
    }

    const decision = normalizeDecision(res.output);
    if (!decision) {
      if (!isTestEnv) {
        console.warn("[ToolPolicy] tools.monty returned an invalid decision");
      }
      return unavailable();
    }
    return decision;
  } catch (err) {
    if (!isTestEnv) {
      console.warn("[ToolPolicy] tools.monty evaluation failed:", err);
    }
    return unavailable();
  }
}
