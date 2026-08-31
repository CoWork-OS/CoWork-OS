import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import type { WorkspaceKitStatus } from "../../shared/types";
import { WORKSPACE_HEALTH_FILES, WORKSPACE_KIT_CONTRACTS } from "./kit-contracts";
import { lintKitDoc, isKitDocStale } from "./kit-linter";
import { parseKitDocument } from "./kit-parser";
import { getKitRevisionCount } from "./kit-revisions";

export const KIT_DIR_NAME = ".cowork";
const WORKSPACE_STATE_FILE_NAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

export type KitWorkspaceState = {
  version: number;
  bootstrapSeededAt?: number;
  onboardingCompletedAt?: number;
};

export const TRACKED_KIT_DIRECTORIES = [
  path.join(KIT_DIR_NAME, "memory"),
  path.join(KIT_DIR_NAME, "memory", "hourly"),
  path.join(KIT_DIR_NAME, "memory", "weekly"),
  path.join(KIT_DIR_NAME, "projects"),
  path.join(KIT_DIR_NAME, "agents"),
] as const;

export function resolveWorkspaceStatePath(workspacePath: string): string {
  return path.join(workspacePath, KIT_DIR_NAME, WORKSPACE_STATE_FILE_NAME);
}

export async function readWorkspaceKitState(workspacePath: string): Promise<KitWorkspaceState> {
  const statePath = resolveWorkspaceStatePath(workspacePath);
  try {
    const raw = await fsp.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<KitWorkspaceState>;
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "number" ? parsed.bootstrapSeededAt : undefined,
      onboardingCompletedAt:
        typeof parsed.onboardingCompletedAt === "number" ? parsed.onboardingCompletedAt : undefined,
    };
  } catch {
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function writeWorkspaceKitState(
  workspacePath: string,
  state: KitWorkspaceState,
): Promise<void> {
  const statePath = resolveWorkspaceStatePath(workspacePath);
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

export async function ensureBootstrapLifecycleState(
  workspacePath: string,
  state?: KitWorkspaceState,
): Promise<{
  state: KitWorkspaceState;
  bootstrapPresent: boolean;
}> {
  const current = state || (await readWorkspaceKitState(workspacePath));
  const bootstrapPath = path.join(workspacePath, KIT_DIR_NAME, "BOOTSTRAP.md");
  const bootstrapPresent = fs.existsSync(bootstrapPath);
  const next: KitWorkspaceState = { ...current, version: WORKSPACE_STATE_VERSION };
  let dirty = false;
  const now = Date.now();

  if (bootstrapPresent && !next.bootstrapSeededAt) {
    next.bootstrapSeededAt = now;
    dirty = true;
  }

  if (!bootstrapPresent && next.bootstrapSeededAt && !next.onboardingCompletedAt) {
    next.onboardingCompletedAt = now;
    dirty = true;
  }

  if (dirty) {
    await writeWorkspaceKitState(workspacePath, next);
  }

  return { state: next, bootstrapPresent };
}

export async function computeWorkspaceKitStatus(
  workspacePath: string,
  workspaceId = workspacePath,
): Promise<WorkspaceKitStatus> {
  const kitRoot = path.join(workspacePath, KIT_DIR_NAME);
  const lifecycle = await ensureBootstrapLifecycleState(workspacePath);
  const trackedHealthPaths = new Set(
    WORKSPACE_HEALTH_FILES.map((fileName) => path.join(KIT_DIR_NAME, fileName)),
  );
  const trackedDirectoryPaths = new Set(TRACKED_KIT_DIRECTORIES);

  const files: WorkspaceKitStatus["files"] = [];
  let missingCount = 0;

  for (const fileName of WORKSPACE_HEALTH_FILES) {
    const contract = WORKSPACE_KIT_CONTRACTS[fileName];
    if (!contract) continue;

    const relPath = path.join(KIT_DIR_NAME, fileName);
    const absPath = path.join(workspacePath, relPath);

    try {
      const stat = await fsp.stat(absPath);
      const parsed = parseKitDocument(absPath, contract, relPath.replace(/\\/g, "/"));
      const issues = parsed ? lintKitDoc(parsed, contract) : [];
      const stale = parsed ? isKitDocStale(parsed, contract) : false;
      files.push({
        relPath,
        exists: true,
        sizeBytes: stat.isFile() ? stat.size : undefined,
        modifiedAt: stat.mtimeMs,
        title: contract.title,
        stale,
        issues,
        revisionCount: getKitRevisionCount(absPath),
        specialHandling: contract.specialHandling,
      });
    } catch {
      missingCount += 1;
      files.push({
        relPath,
        exists: false,
        title: contract.title,
        issues: [],
        revisionCount: 0,
        specialHandling: contract.specialHandling,
      });
    }
  }

  for (const relPath of TRACKED_KIT_DIRECTORIES) {
    const absPath = path.join(workspacePath, relPath);
    try {
      const stat = await fsp.stat(absPath);
      files.push({
        relPath,
        exists: true,
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      missingCount += 1;
      files.push({ relPath, exists: false });
    }
  }

  const lintWarningCount = files.reduce(
    (sum, entry) => sum + (entry.issues?.filter((issue) => issue.level === "warning").length || 0),
    0,
  );
  const lintErrorCount = files.reduce(
    (sum, entry) => sum + (entry.issues?.filter((issue) => issue.level === "error").length || 0),
    0,
  );

  const hasTrackedKitContent =
    lifecycle.state.bootstrapSeededAt !== undefined ||
    files.some(
      (entry) =>
        entry.exists &&
        (trackedHealthPaths.has(entry.relPath) || trackedDirectoryPaths.has(entry.relPath)),
    );

  const hasKitDir = (() => {
    try {
      return fs.existsSync(kitRoot) && hasTrackedKitContent;
    } catch {
      return false;
    }
  })();

  return {
    workspaceId,
    workspacePath,
    hasKitDir,
    files,
    missingCount,
    lintWarningCount,
    lintErrorCount,
    onboarding: {
      bootstrapSeededAt: lifecycle.state.bootstrapSeededAt,
      onboardingCompletedAt: lifecycle.state.onboardingCompletedAt,
      bootstrapPresent: lifecycle.bootstrapPresent,
    },
  };
}
