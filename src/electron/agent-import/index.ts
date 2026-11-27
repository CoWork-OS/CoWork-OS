/**
 * Import a Hermes Agent, OpenClaw, Claude Code or Cursor home into CoWork
 * (docs/migrating-from-hermes.md, docs/migrating-from-openclaw.md,
 * docs/migrating-from-claude-code-and-cursor.md). Used by Settings > Import, onboarding and
 * `cowork import`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGENT_IMPORT_SOURCES,
  type AgentImportDetection,
  type AgentImportPreview,
  type AgentImportResult,
  type AgentImportSource,
} from "../../shared/types";
import { applyImportPlan, type AgentImportTargets } from "./apply";
import {
  claudeCodeHomeExists,
  readClaudeCodeHome,
  resolveClaudeCodeHome,
} from "./claude-code-reader";
import {
  cursorHomeExists,
  cursorStateDbPath,
  readCursorHome,
  readCursorUserRules,
  resolveCursorHome,
} from "./cursor-reader";
import { hermesHomeExists, readHermesHome, resolveHermesHome } from "./hermes-reader";
import { openClawHomeExists, readOpenClawHome, resolveOpenClawHome } from "./openclaw-reader";
import { toPreview, type ImportPlan } from "./plan";

export { applyImportPlan } from "./apply";
export type { AgentImportTargets, ImportWorkspace } from "./apply";
export { createDefaultImportTargets } from "./targets";

export interface AgentImportLocations {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
}

export function resolveAgentHome(
  source: AgentImportSource,
  locations: AgentImportLocations = {},
): string {
  switch (source) {
    case "hermes":
      return resolveHermesHome(locations);
    case "openclaw":
      return resolveOpenClawHome(locations);
    case "claude-code":
      return resolveClaudeCodeHome(locations);
    case "cursor":
      return resolveCursorHome(locations);
  }
}

function agentHomeExists(
  source: AgentImportSource,
  home: string,
  locations: AgentImportLocations,
): boolean {
  switch (source) {
    case "hermes":
      return hermesHomeExists(home);
    case "openclaw":
      return openClawHomeExists(home);
    case "claude-code":
      return claudeCodeHomeExists(home);
    case "cursor":
      return cursorHomeExists(home, locations);
  }
}

/** Which agent homes exist on this machine (onboarding offers the import for these). */
export function detectAgentImports(locations: AgentImportLocations = {}): AgentImportDetection[] {
  return AGENT_IMPORT_SOURCES.map((source) => {
    const home = resolveAgentHome(source, locations);
    return { source, home, found: agentHomeExists(source, home, locations) };
  });
}

export interface BuildImportPlanOptions extends AgentImportLocations {
  withSecrets: boolean;
  nowMs?: number;
  /** The chosen workspace: Claude Code memory and Cursor project rules are read from it. */
  workspacePath?: string;
  /**
   * Cursor's User Rules. `previewAgentImport` and `runAgentImport` read them when this is
   * left out; a plan built directly has none.
   */
  cursorUserRules?: string | null;
}

/** Reads what a plan needs asynchronously (Cursor's User Rules) before it is built. */
async function withAsyncInputs(
  source: AgentImportSource,
  options: BuildImportPlanOptions,
): Promise<BuildImportPlanOptions> {
  if (source !== "cursor" || options.cursorUserRules !== undefined) return options;
  const home = resolveAgentHome(source, options);
  if (!cursorHomeExists(home, options)) return options;
  return { ...options, cursorUserRules: await readCursorUserRules(cursorStateDbPath(options)) };
}

export function buildImportPlan(
  source: AgentImportSource,
  options: BuildImportPlanOptions,
): ImportPlan {
  const home = resolveAgentHome(source, options);
  switch (source) {
    case "hermes":
      return readHermesHome(home, options);
    case "openclaw":
      return readOpenClawHome(home, { ...options, homedir: options.homedir });
    case "claude-code":
      return readClaudeCodeHome(home, options);
    case "cursor":
      return readCursorHome(home, { ...options, userRules: options.cursorUserRules });
  }
}

export async function previewAgentImport(
  source: AgentImportSource,
  options: BuildImportPlanOptions,
): Promise<AgentImportPreview> {
  return toPreview(buildImportPlan(source, await withAsyncInputs(source, options)));
}

export async function runAgentImport(
  source: AgentImportSource,
  targets: AgentImportTargets,
  options: {
    dryRun: boolean;
    excludeItemIds?: readonly string[];
  } & BuildImportPlanOptions,
): Promise<AgentImportResult> {
  const plan = buildImportPlan(
    source,
    await withAsyncInputs(source, {
      ...options,
      workspacePath: options.workspacePath ?? targets.workspace?.path,
    }),
  );
  if (!plan.found) {
    return {
      source,
      home: plan.home,
      dryRun: options.dryRun,
      imported: 0,
      ready: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
  }
  return applyImportPlan(plan, targets, {
    dryRun: options.dryRun,
    excludeItemIds: options.excludeItemIds,
  });
}

/**
 * Whether a CoWork desktop app holds this profile. Electron's single-instance lock is a
 * `SingletonLock` link to `<host>-<pid>` on macOS and Linux; Windows has no file to check,
 * so it reads as not running there.
 */
export function isDesktopAppRunning(userDataDir: string): boolean {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
    const pid = Number(target.split("-").pop());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else; still running.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
