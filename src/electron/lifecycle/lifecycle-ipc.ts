/**
 * IPC for Mission Control > Operations > Hygiene (agent-first roadmap WP9): the report, Retire,
 * Keep and edits of owner, dependencies and a rule's protects/evidence. Renderer input is
 * validated here. Retire archives or disables the item where its store can; nothing is deleted.
 */
import * as fs from "fs";
import type Database from "better-sqlite3";
import {
  IPC_CHANNELS,
  type HygieneReport,
  type LifecycleKind,
  type LifecycleRef,
} from "../../shared/types";
import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { LifecycleMetaRepository, WorkspaceRepository } from "../database/repository-facades";
import { MemoryWriter } from "../memory/MemoryWriter";
import { PlaybookService } from "../memory/PlaybookService";
import { projectHygiene, type HygieneSourceItem } from "./hygiene";

type IpcMainLike = {
  handle: (channel: string, handler: (event: Any, data: Any) => unknown) => void;
};

/** The parts of the cron service Hygiene uses. */
export interface HygieneCronLike {
  list(opts?: { includeDisabled?: boolean }): Promise<
    Array<{
      id: string;
      name: string;
      enabled: boolean;
      workspaceId?: string;
      createdAtMs: number;
      state: { lastRunAtMs?: number; nextRunAtMs?: number; totalRuns?: number };
    }>
  >;
  update(id: string, patch: { enabled: boolean }): Promise<unknown>;
}

/** The parts of the event trigger service Hygiene uses. */
export interface HygieneTriggersLike {
  listTriggers(workspaceId?: string): Array<{
    id: string;
    name: string;
    workspaceId: string;
    lastFiredAt?: number;
    fireCount: number;
    createdAt: number;
  }>;
  updateTrigger(id: string, updates: { enabled: boolean }): Promise<unknown>;
}

export interface LifecycleIpcDeps {
  ipcMain: IpcMainLike;
  getDatabase: () => Database.Database;
  getCronService: () => HygieneCronLike | null;
  getTriggerService: () => HygieneTriggersLike | null;
}

const KINDS: readonly LifecycleKind[] = ["skill", "playbook", "automation", "trigger", "rule"];
const MAX_PLAYBOOK_ENTRIES_PER_WORKSPACE = 500;
const MAX_RULES = 2_000;

function readKind(value: unknown): LifecycleKind | null {
  return KINDS.includes(value as LifecycleKind) ? (value as LifecycleKind) : null;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 300 ? value.trim() : null;
}

/** `undefined` leaves the field, `null` or "" clears it; anything else is refused. */
function readOptionalText(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" && value.length <= 500 ? value : false;
}

function readRefs(value: unknown): LifecycleRef[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) return false;
  const refs: LifecycleRef[] = [];
  for (const entry of value) {
    const kind = entry?.kind === "workspace" ? "workspace" : readKind(entry?.kind);
    const id = readId(entry?.id);
    if (!kind || !id) return false;
    refs.push({ kind, id });
  }
  return refs;
}

function fileTime(filePath: string | undefined): number | undefined {
  if (!filePath) return undefined;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Every item Hygiene looks at, as its own store describes it. A store that fails is skipped. */
export async function collectHygieneItems(
  deps: Pick<LifecycleIpcDeps, "getDatabase" | "getCronService" | "getTriggerService">,
): Promise<{ items: HygieneSourceItem[]; workspaceIds: Set<string> }> {
  const items: HygieneSourceItem[] = [];
  const db = deps.getDatabase();
  const workspaces = await new WorkspaceRepository(db).findAll().catch(() => []);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const inWorkspace = (workspaceId?: string | null): LifecycleRef[] =>
    workspaceId ? [{ kind: "workspace", id: workspaceId }] : [];

  // Skills users and agents made; bundled and read-only external skills are not theirs to retire.
  try {
    for (const skill of getCustomSkillLoader().listSkills()) {
      if (skill.source !== "managed" && skill.source !== "workspace") continue;
      items.push({
        kind: "skill",
        id: skill.id,
        name: skill.name || skill.id,
        ...(skill.metadata?.author ? { owner: skill.metadata.author } : {}),
        ...(fileTime(skill.filePath) ? { createdAt: fileTime(skill.filePath) } : {}),
      });
    }
  } catch {
    // The skill loader is not ready.
  }

  for (const workspace of workspaces) {
    const entries = await PlaybookService.listEntries(workspace.id, {
      kinds: ["success"],
      limit: MAX_PLAYBOOK_ENTRIES_PER_WORKSPACE,
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.status !== "active") continue;
      items.push({
        kind: "playbook",
        id: entry.id,
        name: entry.title || "Playbook entry",
        workspaceId: entry.workspaceId,
        createdAt: entry.createdAt,
        dependsOn: inWorkspace(entry.workspaceId),
      });
    }
  }

  const cron = deps.getCronService();
  for (const job of (await cron?.list({ includeDisabled: true }).catch(() => [])) ?? []) {
    items.push({
      kind: "automation",
      id: job.id,
      name: job.name || job.id,
      ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
      createdAt: job.createdAtMs,
      ...(job.state?.lastRunAtMs ? { lastUsedAt: job.state.lastRunAtMs } : {}),
      useCount: job.state?.totalRuns ?? 0,
      ...(job.enabled && job.state?.nextRunAtMs ? { nextRunAt: job.state.nextRunAtMs } : {}),
      dependsOn: inWorkspace(job.workspaceId),
    });
  }

  try {
    for (const trigger of deps.getTriggerService()?.listTriggers() ?? []) {
      items.push({
        kind: "trigger",
        id: trigger.id,
        name: trigger.name || trigger.id,
        workspaceId: trigger.workspaceId,
        createdAt: trigger.createdAt,
        ...(trigger.lastFiredAt ? { lastUsedAt: trigger.lastFiredAt } : {}),
        useCount: trigger.fireCount ?? 0,
        dependsOn: inWorkspace(trigger.workspaceId),
      });
    }
  } catch {
    // The trigger service is not ready.
  }

  const rules =
    (await MemoryWriter.get()
      ?.repository.list({
        scope: "workspace",
        kinds: ["rule"],
        statuses: ["active"],
        includePrivate: true,
        limit: MAX_RULES,
      })
      .catch(() => [])) ?? [];
  for (const rule of rules) {
    items.push({
      kind: "rule",
      id: rule.id,
      name: rule.content.replace(/\s+/g, " ").slice(0, 120),
      ...(rule.workspaceId ? { workspaceId: rule.workspaceId } : {}),
      // A rule the user stated or confirmed is theirs.
      ...(rule.source === "user_stated" || rule.source === "user_confirmed"
        ? { owner: "you" }
        : {}),
      createdAt: rule.createdAt,
      ...(rule.lastUsedAt ? { lastUsedAt: rule.lastUsedAt } : {}),
      useCount: rule.reinforcedCount,
      dependsOn: inWorkspace(rule.workspaceId),
    });
  }

  return { items, workspaceIds };
}

export async function buildHygieneReport(
  deps: Pick<LifecycleIpcDeps, "getDatabase" | "getCronService" | "getTriggerService">,
  options: { includeAll?: boolean; now?: number } = {},
): Promise<HygieneReport> {
  const { items, workspaceIds } = await collectHygieneItems(deps);
  const meta = await new LifecycleMetaRepository(deps.getDatabase()).list();
  return projectHygiene({
    items,
    meta,
    workspaceIds,
    now: options.now ?? Date.now(),
    includeAll: options.includeAll === true,
  });
}

/** Archive or disable the item in its own store, where that store can. */
async function retireInStore(
  deps: LifecycleIpcDeps,
  kind: LifecycleKind,
  id: string,
): Promise<void> {
  switch (kind) {
    case "skill":
      await getCustomSkillLoader().updateSkill(id, { enabled: false });
      return;
    case "automation": {
      const cron = deps.getCronService();
      if (!cron) throw new Error("Automations are not available yet.");
      await cron.update(id, { enabled: false });
      return;
    }
    case "trigger": {
      const triggers = deps.getTriggerService();
      if (!triggers) throw new Error("Triggers are not available yet.");
      await triggers.updateTrigger(id, { enabled: false });
      return;
    }
    case "rule": {
      const writer = MemoryWriter.get();
      if (!writer) throw new Error("Memory is not available yet.");
      await writer.setStatus(id, "archived");
      return;
    }
    case "playbook":
      // Playbook recall skips retired entries; the entry itself stays.
      return;
  }
}

export function registerLifecycleIpc(deps: LifecycleIpcDeps): void {
  const { ipcMain } = deps;
  const repository = () => new LifecycleMetaRepository(deps.getDatabase());

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_HYGIENE_REPORT, (_event, data: Any) =>
    buildHygieneReport(deps, { includeAll: data?.includeAll === true }),
  );

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_RETIRE, async (_event, data: Any) => {
    const kind = readKind(data?.kind);
    const id = readId(data?.id);
    if (!kind || !id) return { success: false, error: "Unknown item." };
    try {
      await retireInStore(deps, kind, id);
      await repository().retire({ kind, id, at: Date.now() });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_KEEP, async (_event, data: Any) => {
    const kind = readKind(data?.kind);
    const id = readId(data?.id);
    if (!kind || !id) return { success: false, error: "Unknown item." };
    await repository().keep({ kind, id, at: Date.now() });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_SET_META, async (_event, data: Any) => {
    const kind = readKind(data?.kind);
    const id = readId(data?.id);
    const owner = readOptionalText(data?.owner);
    const protects = readOptionalText(data?.protects);
    const evidence = readOptionalText(data?.evidence);
    const dependsOn = readRefs(data?.dependsOn);
    if (!kind || !id || owner === false || protects === false || evidence === false) {
      return { success: false, error: "Invalid lifecycle fields." };
    }
    if (dependsOn === false) return { success: false, error: "Invalid dependencies." };
    if (kind !== "rule" && (protects !== undefined || evidence !== undefined)) {
      return { success: false, error: "Only rules record what they protect and their evidence." };
    }
    const meta = await repository().setMeta({
      kind,
      id,
      ...(owner !== undefined ? { owner } : {}),
      ...(protects !== undefined ? { protects } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      at: Date.now(),
    });
    return { success: true, meta };
  });
}
