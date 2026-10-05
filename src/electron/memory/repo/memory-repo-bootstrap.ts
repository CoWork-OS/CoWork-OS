/**
 * Start, stop and reconfigure the memory repo (docs/memory-repo-phase1-design.md §4.1).
 *
 * Started after the memory engine in the desktop app and the node daemon when
 * `memoryRepoEnabled` is on; restarted when the setting or the path changes; stopped by the
 * "memory repo" shutdown step. The CLI and quiet mode start it read-only.
 */
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { setMemoryRepoRoot } from "../../security/memory-repo-access";
import { createLogger } from "../../utils/logger";
import { MemoryWriter, type MemoryWorkspacePolicy } from "../MemoryWriter";
import { MemoryRepoService, type MemoryRepoStatus } from "./MemoryRepoService";
import { runMemoryRepoExport } from "./MemoryRepoExport";
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
  return reconfigureMemoryRepo();
}

/** The status of the running repo, or of the configured path when it is off or refused. */
export async function memoryRepoStatus(): Promise<MemoryRepoStatus & { enabled: boolean }> {
  const settings = MemoryFeaturesManager.loadSettings();
  const enabled = settings.memoryRepoEnabled === true;
  const service = MemoryRepoService.get();
  if (service) return { ...(await service.status()), enabled };
  const root = resolveMemoryRepoPath(settings.memoryRepoPath);
  const workspacePaths = (await options?.listWorkspacePaths?.().catch(() => [])) ?? [];
  const problem = memoryRepoPathProblem(root, workspacePaths);
  return {
    root,
    ready: false,
    writable: false,
    gitAvailable: false,
    enabled,
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
    if (current && current.root === root) return current.service.status();
    await stopCurrent();
    if (!root) return null;
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
          void runMemoryRepoExport(service, {
            listItems: () =>
              writer.repository.list({ statuses: ["active"], includePrivate: false, limit: 5000 }),
            workspaceName: (id) => (workspaceName ? workspaceName(id) : Promise.resolve(null)),
          }).catch((error) => logger.warn("Memory repo export failed:", error));
        }
      }
      return status;
    } catch (error) {
      logger.warn("Memory repo failed to start:", error);
      return null;
    }
  });
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
    await stopCurrent();
  });
}
