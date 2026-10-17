/**
 * Import a Hermes Agent or OpenClaw home into CoWork (docs/migrating-from-hermes.md,
 * docs/migrating-from-openclaw.md). Used by Settings > Import, onboarding and
 * `cowork import`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentImportDetection,
  AgentImportPreview,
  AgentImportResult,
  AgentImportSource,
} from "../../shared/types";
import { applyImportPlan, type AgentImportTargets } from "./apply";
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
  return source === "hermes" ? resolveHermesHome(locations) : resolveOpenClawHome(locations);
}

/** Which agent homes exist on this machine (onboarding offers the import for these). */
export function detectAgentImports(locations: AgentImportLocations = {}): AgentImportDetection[] {
  const hermes = resolveHermesHome(locations);
  const openclaw = resolveOpenClawHome(locations);
  return [
    { source: "hermes", home: hermes, found: hermesHomeExists(hermes) },
    { source: "openclaw", home: openclaw, found: openClawHomeExists(openclaw) },
  ];
}

export function buildImportPlan(
  source: AgentImportSource,
  options: { withSecrets: boolean; nowMs?: number } & AgentImportLocations,
): ImportPlan {
  const home = resolveAgentHome(source, options);
  return source === "hermes"
    ? readHermesHome(home, options)
    : readOpenClawHome(home, { ...options, homedir: options.homedir });
}

export function previewAgentImport(
  source: AgentImportSource,
  options: { withSecrets: boolean } & AgentImportLocations,
): AgentImportPreview {
  return toPreview(buildImportPlan(source, options));
}

export async function runAgentImport(
  source: AgentImportSource,
  targets: AgentImportTargets,
  options: {
    withSecrets: boolean;
    dryRun: boolean;
    excludeItemIds?: readonly string[];
  } & AgentImportLocations,
): Promise<AgentImportResult> {
  const plan = buildImportPlan(source, options);
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
