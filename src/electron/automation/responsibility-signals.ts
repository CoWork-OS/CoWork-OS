import { createHash } from "node:crypto";
import { CHANNEL_TYPES, type ChannelType } from "../../shared/gateway-channel-types";
import { taskAgentConfigForCreation } from "../../shared/security/task-entrypoint";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { CronJob } from "../cron/types";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../security/access-profile-resolver";
import type { AgentConfig, Workspace, PermissionSettingsData } from "../../shared/types";
import {
  RESPONSIBILITY_SIGNAL_ALREADY_ADMITTED,
  type ResponsibilityOperation,
} from "../../shared/bot-responsibility";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { BotResponsibilityRepository } from "./BotResponsibilityRepository";
import { resolveResponsibilityHistoryChannel } from "./responsibility-store";
import { assertResponsibilityMailboxEvent } from "./responsibility-mailbox";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type SourceWorkspace = Pick<Workspace, "path" | "permissions"> & Pick<Partial<Workspace>, "isTemp">;
function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function permitted(workspace: SourceWorkspace, target: string, additional?: SourceWorkspace) {
  if (
    [workspace, ...(additional ? [additional] : [])].some(
      (view) => evaluateWorkspaceFilesystemAccess(view, target, "read").decision !== "allow",
    )
  )
    throw new Error("Selected source is unavailable under current workspace policy");
}

/** Bounded native sampling. It reads only selected sources and never calls a model.
 * A failed/unstable sample does not advance the durable source cursor. */
export async function sampleResponsibilityFile(
  workspace: SourceWorkspace,
  source: ResponsibilityOperation,
  additional?: SourceWorkspace,
) {
  const root = await fs.realpath(workspace.path);
  const requested = path.resolve(workspace.path, source.resourceId);
  permitted(workspace, requested, additional);
  let canonical: string;
  try {
    canonical = await fs.realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A missing leaf under a symlink may point outside the selected workspace.
    let ancestor = path.dirname(requested);
    while (true) {
      try {
        if (!within(root, await fs.realpath(ancestor)))
          throw new Error("Selected source leaves the workspace");
        break;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw failure;
        ancestor = parent;
      }
    }
    return { source, fingerprint: digest("missing"), hasSignal: false };
  }
  if (!within(root, canonical)) throw new Error("Selected source leaves the workspace");
  permitted(workspace, canonical, additional);
  if (source.method === "list_directory") {
    const entries = await fs.readdir(canonical, { withFileTypes: true });
    if (entries.length > MAX_ENTRIES)
      throw new Error("Selected directory exceeds the bounded signal sample");
    const visible = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(canonical, entry.name);
      if (
        [workspace, ...(additional ? [additional] : [])].some(
          (view) => evaluateWorkspaceFilesystemAccess(view, target, "read").decision !== "allow",
        )
      )
        continue;
      const metadata = await fs.lstat(target);
      visible.push({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "file",
        size: metadata.size,
      });
    }
    return { source, fingerprint: digest(JSON.stringify(visible)), hasSignal: visible.length > 0 };
  }
  const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES)
      throw new Error("Selected file exceeds the bounded signal sample or is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAX_BYTES) throw new Error("Selected file exceeds the bounded signal sample");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes !== before.size
    )
      throw new Error("Selected source changed during sampling; retry a fresh sample");
    permitted(workspace, canonical, additional);
    return { source, fingerprint: hash.digest("hex"), hasSignal: bytes > 0 };
  } finally {
    await handle.close();
  }
}

/** Called by the existing cron admission hook in every production runtime. */
export async function prepareResponsibilitySchedule(
  db: Database.Database,
  job: Pick<
    CronJob,
    | "id"
    | "workspaceId"
    | "runMode"
    | "chatContext"
    | "delivery"
    | "taskAgentConfig"
    | "accessProfileId"
  >,
  access: {
    settings?: PermissionSettingsData;
    adminPolicies?: import("../admin/policies").AdminPolicies;
  } = {},
  kind: "cron" | "event" = "cron",
): Promise<void | { skipReason?: string; agentConfig?: AgentConfig }> {
  const context = await new BotResponsibilityRepository(db).signalContext(
    job.id,
    false,
    undefined,
    kind,
  );
  if (!context) return;
  if (
    job.workspaceId !== context.binding.workspaceId ||
    (job.runMode && job.runMode !== "new_task")
  )
    throw new Error("Scheduled responsibility target has changed");
  if (job.delivery?.enabled)
    throw new Error("Responsibility scheduled output needs a delivery approval binding");
  if (
    job.chatContext &&
    !context.binding.definition.sources.some(
      (source) =>
        source.connectorId === `gateway:${job.chatContext!.channelType}` &&
        source.method === "channel_history" &&
        source.resourceId === job.chatContext!.channelId,
    )
  )
    throw new Error("Scheduled chat context is outside the selected sources");
  const preparedConfig = taskAgentConfigForCreation(
    {
      ...job.taskAgentConfig,
      ...(job.accessProfileId ? { accessProfileId: job.accessProfileId } : {}),
    },
    access.settings ?? {},
  );
  const profile = resolveEffectiveAccessProfile({
    task: { source: kind === "event" ? "hook" : "cron", agentConfig: preparedConfig },
    workspace: context.workspace,
    ...access,
  });
  if (profile.profileUnavailable) throw new Error("The selected access profile is unavailable.");
  const effectiveWorkspace = applyAccessProfileToWorkspace(
    {
      ...context.workspace,
      id: context.binding.workspaceId,
      name: "Source sample",
      createdAt: 0,
      lastUsedAt: 0,
    },
    profile,
  );
  if (!effectiveWorkspace.permissions.read)
    throw new Error("Selected source is unavailable under current workspace policy");
  const bindingRef = {
    id: context.binding.id,
    workspaceId: context.binding.workspaceId,
    agentRoleId: context.binding.agentRoleId,
    revision: context.binding.revision,
    controlVersion: context.binding.controlVersion,
    engine: context.binding.definition.engine,
  };
  const current = await new BotResponsibilityRepository(db).signalContext(
    job.id,
    true,
    bindingRef,
    kind,
  );
  if (!current) throw new Error("Source signal responsibility is unavailable");
  const channelInstancesByType = new Map<ChannelType, string>();
  for (const sample of current.history) {
    const channelType = CHANNEL_TYPES.find(
      (type) => type === sample.source.connectorId.slice("gateway:".length),
    );
    if (!channelType) throw new Error("Selected history channel type is unavailable");
    const existing = channelInstancesByType.get(channelType);
    if (existing && existing !== sample.channelInstanceId)
      throw new Error("Selected history channel instance changed during source sampling");
    channelInstancesByType.set(channelType, sample.channelInstanceId);
  }
  const channelInstances = [...channelInstancesByType]
    .map(([channelType, channelId]) => ({ channelType, channelId }))
    .sort((a, b) => a.channelType.localeCompare(b.channelType));
  const samples: Array<Awaited<ReturnType<typeof sampleResponsibilityFile>>> = [...current.history];
  for (const source of context.binding.definition.sources.filter(
    (item) => item.connectorId === "workspace_files",
  ))
    samples.push(await sampleResponsibilityFile(context.workspace, source, effectiveWorkspace));
  samples.sort((a, b) => JSON.stringify(a.source).localeCompare(JSON.stringify(b.source)));
  const fingerprint = digest(
    JSON.stringify(samples.map(({ source, fingerprint }) => ({ source, fingerprint }))),
  );
  if (
    (!context.head && !samples.some((sample) => sample.hasSignal)) ||
    context.head?.fingerprint === fingerprint
  )
    return { skipReason: RESPONSIBILITY_SIGNAL_ALREADY_ADMITTED };
  const { binding } = context;
  return {
    agentConfig: {
      ...preparedConfig,
      responsibilityRun: {
        id: binding.id,
        workspaceId: binding.workspaceId,
        agentRoleId: binding.agentRoleId,
        revision: binding.revision,
        controlVersion: binding.controlVersion,
        engine: binding.definition.engine,
      },
      responsibilitySignal: {
        fingerprint,
        expectedSequence: context.head?.sequence ?? 0,
        channelInstances,
      },
    },
  };
}

/** Gateway events only wake a selected cached source. Event fields never become
 * task instructions; the task reads its selected source under current policy. */
export async function prepareResponsibilityEvent(
  db: Database.Database,
  trigger: import("../triggers/types").EventTrigger,
  event: import("../triggers/types").TriggerEvent,
  access: Parameters<typeof prepareResponsibilitySchedule>[2] = {},
) {
  const repo = new BotResponsibilityRepository(db);
  const binding = await repo.getForEventTrigger(trigger.id);
  if (!binding) {
    const config = trigger.action.config.agentConfig;
    if (
      config?.responsibilityRun ||
      (config?.automationRoutineId &&
        (await repo.getForEngine("routine", config.automationRoutineId)))
    )
      throw new Error("Event trigger responsibility binding is unavailable");
    return;
  }
  await repo.assertEngineMayExecute(binding.definition.engine.kind, binding.definition.engine.id);
  if (
    !["channel_message", "mailbox_event"].includes(trigger.source) ||
    event.source !== trigger.source ||
    trigger.action.type !== "create_task" ||
    trigger.action.config.runMode === "thread_follow_up" ||
    trigger.workspaceId !== binding.workspaceId ||
    (trigger.action.config.workspaceId && trigger.action.config.workspaceId !== binding.workspaceId)
  )
    throw new Error("Event responsibility target has changed or has no ingestion scope adapter");
  if (event.source === "channel_message") {
    const sourceChannelType = event.fields.channelType;
    if (
      typeof sourceChannelType !== "string" ||
      !sourceChannelType.trim() ||
      sourceChannelType.length > 128
    )
      throw new Error("Event source channel type is unavailable");
    if (
      !binding.definition.sources.some(
        (source) =>
          source.connectorId === `gateway:${sourceChannelType}` &&
          source.method === "channel_history" &&
          source.resourceId === event.fields.chatId,
      )
    )
      throw new Error("Event is outside the selected responsibility sources");
    const sourceInstanceId = event.fields.channelInstanceId;
    if (
      typeof sourceInstanceId !== "string" ||
      !sourceInstanceId.trim() ||
      sourceInstanceId.length > 128
    )
      throw new Error("Event source channel instance is unavailable");
    const selectedInstance = resolveResponsibilityHistoryChannel(db, sourceChannelType);
    if (selectedInstance.kind === "ambiguous")
      throw new Error("Selected history channel instance is ambiguous");
    if (selectedInstance.kind !== "enabled")
      throw new Error("Selected history channel instance is unavailable");
    if (selectedInstance.id !== sourceInstanceId)
      throw new Error("Event source channel instance changed after occurrence acceptance");
  } else {
    assertResponsibilityMailboxEvent(db, trigger, event, binding.workspaceId);
  }
  const result = await prepareResponsibilitySchedule(
    db,
    {
      id: trigger.id,
      workspaceId: trigger.workspaceId,
      runMode: "new_task",
      taskAgentConfig: trigger.action.config.agentConfig,
    },
    access,
    "event",
  );
  if (!result) throw new Error("Event responsibility binding changed during admission");
  return result;
}
