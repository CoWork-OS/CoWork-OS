/**
 * Start, stop and reconfigure the memory repo (docs/memory-repo-phase1-design.md §4.1).
 *
 * Started after the memory engine in the desktop app and the node daemon when
 * `memoryRepoEnabled` is on; restarted when the setting or the path changes; stopped by the
 * "memory repo" shutdown step. The CLI and quiet mode start it read-only.
 */
import type { MemoryFeaturesSettings } from "../../../shared/types";
import { setTeamMemoryRepoRoots } from "../../security/memory-repo-access";
import { memoryRepoRemoteUrlProblem } from "./memory-repo-sync";
import {
  configureTeamMemoryRepos,
  pullTeamMemoryRepos,
  teamMemoryRepoRoots,
  teamMemoryRepoStatuses,
  teamRepoPathProblem,
  type TeamMemoryRepoStatus,
} from "./memory-repo-team";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { setMemoryRepoRoot } from "../../security/memory-repo-access";
import { createLogger } from "../../utils/logger";
import { MemoryWriter, type MemoryWorkspacePolicy } from "../MemoryWriter";
import { MemoryRepoService, type MemoryRepoStatus } from "./MemoryRepoService";
import { runMemoryRepoExport } from "./MemoryRepoExport";
import { runMemoryItemsFactRetirement } from "./MemoryItemsFactRetirement";
import path from "node:path";
import { getSafeStorage } from "../../utils/safe-storage";
import { getUserDataDir } from "../../utils/user-data-dir";
import {
  DREAM_DEFAULT_DAILY_TOKEN_BUDGET,
  MemoryRepoDreamer,
  getMemoryRepoDreamer,
  setMemoryRepoDreamer,
  type DreamModelClient,
} from "./MemoryRepoDreamer";
import { createProviderDreamModelClient } from "./memory-repo-dream-client";
import { createDreamTaskLister, type DreamTaskSourceDeps } from "./memory-repo-dream-tasks";
import { memoryRepoPathProblem, resolveMemoryRepoPath } from "./memory-repo-paths";

const logger = createLogger("MemoryRepo");

export interface MemoryRepoBootstrapOptions {
  runtime: "desktop" | "node" | "cli";
  readOnly?: boolean;
  getWorkspacePolicy?: (workspaceId: string) => Promise<MemoryWorkspacePolicy | null>;
  /** Workspace paths, so the repo never lands inside a project workspace. */
  listWorkspacePaths?: () => Promise<string[]>;
  workspaceName?: (workspaceId: string) => Promise<string | null>;
  ownerName?: () => string | null | undefined;
  /** Run the one-time export of `memory_items` (default: when writable). */
  runExport?: boolean;
  /** Recent tasks for dreaming (Phase 2); without them a dream reads only the folder. */
  findTasksCreatedBetween?: DreamTaskSourceDeps["findTasksCreatedBetween"];
  findTaskEvents?: DreamTaskSourceDeps["findTaskEvents"];
  /** The dream's model client (default: the configured provider). */
  dreamModelClient?: DreamModelClient;
}

let options: MemoryRepoBootstrapOptions | null = null;
let unsubscribeSettings: (() => void) | null = null;
let current: { root: string; service: MemoryRepoService } | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

/** Start the repo per the current settings. Never throws; returns null when off. */
export function startMemoryRepo(
  bootOptions: MemoryRepoBootstrapOptions,
): Promise<MemoryRepoStatus | null> {
  options = bootOptions;
  unsubscribeSettings?.();
  unsubscribeSettings = MemoryFeaturesManager.onSaved(() => {
    void reconfigureMemoryRepo();
  });
  startSyncTimer();
  return reconfigureMemoryRepo();
}

/** The status of the running repo, or of the configured path when it is off or refused. */
export async function memoryRepoStatus(): Promise<
  MemoryRepoStatus & { enabled: boolean; team: TeamMemoryRepoStatus[] }
> {
  const settings = MemoryFeaturesManager.loadSettings();
  const enabled = settings.memoryRepoEnabled === true;
  // Team repos (docs/memory-repo-phase4-design.md §2) are listed whether or not the folder is on.
  const team = teamMemoryRepoStatuses();
  const service = MemoryRepoService.get();
  if (service) return { ...(await service.status()), enabled, team };
  const root = resolveMemoryRepoPath(settings.memoryRepoPath);
  const workspacePaths = (await options?.listWorkspacePaths?.().catch(() => [])) ?? [];
  const problem = memoryRepoPathProblem(root, workspacePaths);
  return {
    root,
    ready: false,
    writable: false,
    gitAvailable: false,
    enabled,
    team,
    ...(problem ? { problem } : {}),
  };
}

/** Why `memoryRepoPath` cannot be saved, or null (validated in main before a save). */
export async function memoryRepoPathSettingProblem(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value.trim()) return null;
  const workspacePaths = (await options?.listWorkspacePaths?.().catch(() => [])) ?? [];
  return memoryRepoPathProblem(value, workspacePaths);
}

/**
 * Apply the current settings: start, restart at a new path, or stop. Call it after the
 * memory feature settings are saved.
 */
export function reconfigureMemoryRepo(): Promise<MemoryRepoStatus | null> {
  return serialized(async () => {
    if (!options) return null;
    const settings = MemoryFeaturesManager.loadSettings();
    const root = settings.memoryRepoEnabled ? resolveMemoryRepoPath(settings.memoryRepoPath) : null;
    if (current && current.root === root) {
      await applySyncAndTeam(current.service, settings);
      return current.service.status();
    }
    await stopCurrent();
    if (!root) {
      await applySyncAndTeam(null, settings);
      return null;
    }
    try {
      const workspacePaths = (await options.listWorkspacePaths?.().catch(() => [])) ?? [];
      const problem = memoryRepoPathProblem(root, workspacePaths);
      if (problem) {
        logger.warn(`Memory repo not started at ${root}: ${problem}`);
        const refused = new MemoryRepoService({ root, runtime: options.runtime, readOnly: true });
        return { ...(await refused.status()), problem };
      }
      const service = new MemoryRepoService({
        root,
        runtime: options.runtime,
        readOnly: options.readOnly,
        getWorkspacePolicy: options.getWorkspacePolicy,
        ownerName: options.ownerName,
      });
      const status = await service.start();
      current = { root, service };
      MemoryRepoService.setInstance(service);
      // File tools may never write the repo and read it only per task (design §6.4).
      setMemoryRepoRoot(service.root);
      if (status.ready && !options.readOnly) startDreamer(service, options);
      if (status.ready && !options.readOnly && options.runExport !== false) {
        const writer = MemoryWriter.get();
        const workspaceName = options.workspaceName;
        if (writer) {
          const listItems = () =>
            writer.repository.list({ statuses: ["active"], includePrivate: false, limit: 5000 });
          void runMemoryRepoExport(service, {
            listItems,
            workspaceName: (id) => (workspaceName ? workspaceName(id) : Promise.resolve(null)),
          })
            // Then retire the fact rows the folder now holds (Phase 3 §3).
            .then(() =>
              runMemoryItemsFactRetirement(service, {
                listItems,
                deleteItem: (id) => writer.setStatus(id, "deleted"),
                encryption: getSafeStorage(),
                backupDir: path.join(getUserDataDir(), "backups"),
              }),
            )
            .catch((error) => logger.warn("Memory repo export or fact retirement failed:", error));
        }
      }
      await applySyncAndTeam(service, settings);
      return status;
    } catch (error) {
      logger.warn("Memory repo failed to start:", error);
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Sync and team memory (docs/memory-repo-phase4-design.md)
// ---------------------------------------------------------------------------

const SYNC_INTERVAL_MS = 10 * 60 * 1000;
let appliedSyncUrl: string | null | undefined;
let appliedTeamKey: string | null = null;
let syncTimer: NodeJS.Timeout | null = null;

/** Apply the remote and team settings to the running folder. Never throws. */
async function applySyncAndTeam(
  service: MemoryRepoService | null,
  settings: MemoryFeaturesSettings,
): Promise<void> {
  try {
    const url =
      service?.isWritable() && settings.memoryRepoRemoteConfirmedPrivate === true
        ? (settings.memoryRepoRemoteUrl ?? "").trim() || null
        : null;
    if (service && url !== appliedSyncUrl) {
      const configured = await service.configureSync(url);
      appliedSyncUrl = configured.ok ? url : null;
      if (!configured.ok) logger.warn(`Memory folder sync not configured: ${configured.error}`);
      if (configured.ok && url) void service.syncNow().catch(() => undefined);
    }
    const teams = settings.memoryRepoTeamRepos ?? [];
    const teamKey = JSON.stringify({ teams, root: service?.root ?? null });
    if (teamKey !== appliedTeamKey) {
      appliedTeamKey = teamKey;
      const workspacePaths = (await options?.listWorkspacePaths?.().catch(() => [])) ?? [];
      await configureTeamMemoryRepos(teams, { personalRoot: service?.root ?? null, workspacePaths });
      setTeamMemoryRepoRoots(teamMemoryRepoRoots());
    }
  } catch (error) {
    logger.warn("Applying memory folder sync or team settings failed:", error);
  }
}

function startSyncTimer(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    const service = current?.service;
    if (service?.isSyncConfigured()) void service.syncNow().catch(() => undefined);
    void pullTeamMemoryRepos().catch(() => undefined);
  }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

/**
 * Why the memory folder settings cannot be saved, or null: the folder path, the remote URL and
 * the team repos (validated in main before a save).
 */
export async function memoryRepoSettingsProblem(
  value: Partial<MemoryFeaturesSettings> | null | undefined,
): Promise<string | null> {
  if (!value) return null;
  const pathProblem = await memoryRepoPathSettingProblem(value.memoryRepoPath);
  if (pathProblem) return pathProblem;
  if (typeof value.memoryRepoRemoteUrl === "string") {
    const urlProblem = memoryRepoRemoteUrlProblem(value.memoryRepoRemoteUrl);
    if (urlProblem) return urlProblem;
  }
  if (Array.isArray(value.memoryRepoTeamRepos)) {
    const workspacePaths = (await options?.listWorkspacePaths?.().catch(() => [])) ?? [];
    const personalRoot = resolveMemoryRepoPath(
      value.memoryRepoPath ?? MemoryFeaturesManager.loadSettings().memoryRepoPath,
    );
    const others: string[] = [];
    for (const team of value.memoryRepoTeamRepos) {
      if (!team || typeof team.path !== "string") continue;
      const problem = teamRepoPathProblem(team, { personalRoot, workspacePaths, others });
      if (problem) return `${team.name || "Team repo"}: ${problem}`;
      others.push(team.path);
    }
  }
  return null;
}

/** The dreamer of a writable repo (docs/memory-repo-phase2-design.md §6). */
function startDreamer(service: MemoryRepoService, bootOptions: MemoryRepoBootstrapOptions): void {
  const { findTasksCreatedBetween, findTaskEvents } = bootOptions;
  const listRecentTasks =
    findTasksCreatedBetween && findTaskEvents
      ? createDreamTaskLister({
          findTasksCreatedBetween,
          findTaskEvents,
          workspaceName: bootOptions.workspaceName,
          getWorkspacePolicy: bootOptions.getWorkspacePolicy,
        })
      : async () => [];
  setMemoryRepoDreamer(
    new MemoryRepoDreamer({
      getService: () => (MemoryRepoService.get() === service ? service : null),
      client: bootOptions.dreamModelClient ?? createProviderDreamModelClient(),
      listRecentTasks,
      settings: () => {
        const settings = MemoryFeaturesManager.loadSettings();
        return {
          enabled: settings.memoryRepoDreamingEnabled !== false,
          dailyTokenBudget:
            settings.memoryRepoDreamDailyTokenBudget ?? DREAM_DEFAULT_DAILY_TOKEN_BUDGET,
        };
      },
    }),
  );
}

async function stopCurrent(): Promise<void> {
  appliedSyncUrl = undefined;
  if (getMemoryRepoDreamer()) setMemoryRepoDreamer(null);
  if (!current) return;
  const { service } = current;
  current = null;
  if (MemoryRepoService.get() === service) MemoryRepoService.setInstance(null);
  setMemoryRepoRoot(null);
  await service.stop();
}

/** The "memory repo" shutdown step: finish the write in progress (bounded) and stop. */
export function stopMemoryRepo(): Promise<void> {
  return serialized(async () => {
    options = null;
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    appliedSyncUrl = undefined;
    appliedTeamKey = null;
    await stopCurrent();
  });
}
