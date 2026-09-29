import { TaskRepository } from "../database/repository-facades";
import type Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";
import {
  CouncilConfig,
  CouncilExecutionPolicy,
  CouncilMemo,
  CouncilParticipant,
  CouncilRun,
  CouncilSourceBundle,
  CreateCouncilConfigRequest,
  MultiLlmConfig,
  MultiLlmParticipant,
  UpdateCouncilConfigRequest,
  type ChannelType,
  type Task,
} from "../../shared/types";
import type { NotificationService } from "../notifications/service";
import { resolveTaskResultText } from "../cron/result-text";
import { TaskEventRepository } from "../database/repositories";
import type { CronService } from "../cron/service";
import type { CronJobCreate } from "../cron/types";
import {
  CouncilConfigRepository,
  CouncilMemoRepository,
  CouncilRunRepository,
} from "./council-repository-facades";
import {
  assertCouncilParticipants,
  clampIndex,
  normalizeParticipants,
  normalizeSourceBundle,
} from "./council-sql";

const COUNCIL_TRIGGER_PREFIX = "<cowork_council:";
const COUNCIL_TRIGGER_SUFFIX = ">";
const COUNCIL_CRON_MARKER_PREFIX = "[cowork:council:";
const COUNCIL_CRON_MARKER_SUFFIX = "]";
const MAX_SOURCE_BYTES_PER_FILE = 32_000;
const MAX_TOTAL_SOURCE_BYTES = 96_000;

const BLOCKED_PATH_PREFIXES = ["/etc", "/sys", "/proc", "/dev", "/boot", "/root", "/var/log"];
const BLOCKED_SUBDIR_NAMES = [".ssh", ".gnupg", ".aws", ".kube"];

function isSafeFilePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (
    BLOCKED_PATH_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(prefix + "/"))
  ) {
    return false;
  }
  const home = process.env.HOME;
  if (home) {
    for (const subdir of BLOCKED_SUBDIR_NAMES) {
      const blocked = path.join(home, subdir);
      if (resolved === blocked || resolved.startsWith(blocked + "/")) {
        return false;
      }
    }
  }
  return true;
}

function isAllOllama(participants: CouncilParticipant[]): boolean {
  return (
    participants.length > 0 &&
    participants.every((participant) => participant.providerType === "ollama")
  );
}

function computeParallelism(
  participants: CouncilParticipant[],
  policy: CouncilExecutionPolicy,
): number {
  if (participants.length === 0) return 1;
  if (typeof policy.maxParallelParticipants === "number" && policy.maxParallelParticipants > 0) {
    return Math.min(participants.length, Math.floor(policy.maxParallelParticipants));
  }
  if (policy.mode === "full_parallel") return participants.length;
  if (policy.mode === "capped_local") return Math.min(participants.length, 2);
  return isAllOllama(participants) ? Math.min(participants.length, 2) : participants.length;
}


export interface CouncilServiceDeps {
  db: Database.Database;
  getCronService: () => CronService | null;
  getNotificationService?: () => NotificationService | null;
  deliverToChannel?: (params: {
    channelType: ChannelType;
    channelDbId?: string;
    channelId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<void>;
}

export class CouncilService {
  private readonly configRepo: CouncilConfigRepository;
  private readonly runRepo: CouncilRunRepository;
  private readonly memoRepo: CouncilMemoRepository;
  private readonly taskRepo: TaskRepository;
  private readonly taskEventRepo: TaskEventRepository;
  private readonly inFlightTriggers = new Set<string>();

  constructor(private readonly deps: CouncilServiceDeps) {
    this.configRepo = new CouncilConfigRepository(deps.db);
    this.runRepo = new CouncilRunRepository(deps.db);
    this.memoRepo = new CouncilMemoRepository(deps.db);
    this.taskRepo = new TaskRepository(deps.db);
    this.taskEventRepo = new TaskEventRepository(deps.db);
  }

  static buildManagedTrigger(councilId: string): string {
    return `${COUNCIL_TRIGGER_PREFIX}${councilId}${COUNCIL_TRIGGER_SUFFIX}`;
  }

  static parseManagedTrigger(prompt: string): string | null {
    const trimmed = String(prompt || "").trim();
    if (!trimmed.startsWith(COUNCIL_TRIGGER_PREFIX) || !trimmed.endsWith(COUNCIL_TRIGGER_SUFFIX)) {
      return null;
    }
    return (
      trimmed.slice(COUNCIL_TRIGGER_PREFIX.length, -COUNCIL_TRIGGER_SUFFIX.length).trim() || null
    );
  }

  /** Ids of every council, across workspaces. */
  listAllIds(): Promise<string[]> {
    return this.configRepo.allIds();
  }

  async list(workspaceId: string): Promise<CouncilConfig[]> {
    return this.configRepo.listByWorkspace(workspaceId);
  }

  async get(id: string): Promise<CouncilConfig | undefined> {
    return this.configRepo.findById(id);
  }

  async getMemo(id: string): Promise<CouncilMemo | undefined> {
    return this.memoRepo.findById(id);
  }

  async getLatestMemo(councilConfigId: string): Promise<CouncilMemo | undefined> {
    return this.memoRepo.getLatestForCouncil(councilConfigId);
  }

  async listRuns(councilConfigId: string, limit = 20): Promise<CouncilRun[]> {
    return this.runRepo.listByCouncil(councilConfigId, limit);
  }

  async create(request: CreateCouncilConfigRequest): Promise<CouncilConfig> {
    const config = await this.configRepo.create(request);
    return await this.syncManagedJob(config.id);
  }

  async update(request: UpdateCouncilConfigRequest): Promise<CouncilConfig | undefined> {
    const updated = await this.configRepo.update(request);
    if (!updated) return undefined;
    return await this.syncManagedJob(updated.id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<CouncilConfig | undefined> {
    const updated = await this.configRepo.update({ id, enabled });
    if (!updated) return undefined;
    return await this.syncManagedJob(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.configRepo.findById(id);
    if (!existing) return false;
    const cron = this.deps.getCronService();
    if (existing.managedCronJobId && cron) {
      await cron.remove(existing.managedCronJobId).catch(() => undefined);
    }
    return this.configRepo.delete(id);
  }

  async runNow(id: string): Promise<CouncilRun | null> {
    const config = await this.configRepo.findById(id);
    if (!config?.managedCronJobId) return null;
    const cron = this.deps.getCronService();
    if (!cron) throw new Error("Scheduler service is not running");
    const result = await cron.run(config.managedCronJobId, "force");
    if (!result.ok || !result.ran) {
      return null;
    }
    return (await this.runRepo.findByTaskId(result.taskId)) || null;
  }

  async isCouncilJob(jobId: string): Promise<boolean> {
    return !!(await this.configRepo.findByManagedCronJobId(jobId));
  }

  async prepareTaskForTrigger(
    triggerPrompt: string,
    workspaceId: string,
  ): Promise<{
    runId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: Task["agentConfig"];
  } | null> {
    const councilId = CouncilService.parseManagedTrigger(triggerPrompt);
    if (!councilId) return null;

    if (this.inFlightTriggers.has(councilId)) {
      throw new Error(`Council ${councilId} is already being triggered`);
    }
    this.inFlightTriggers.add(councilId);

    try {
      return await this._prepareTaskForTriggerInner(councilId, workspaceId);
    } finally {
      this.inFlightTriggers.delete(councilId);
    }
  }

  private async _prepareTaskForTriggerInner(
    councilId: string,
    workspaceId: string,
  ): Promise<{
    runId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: Task["agentConfig"];
  } | null> {
    const config = await this.configRepo.findById(councilId);
    if (!config) throw new Error(`Council not found: ${councilId}`);
    const participants = normalizeParticipants(config.participants);
    assertCouncilParticipants(participants);

    const proposerSeatIndex = clampIndex(config.nextIdeaSeatIndex, participants.length);
    const sourceSnapshot = normalizeSourceBundle(config.sourceBundle);
    const run = await this.runRepo.create({
      councilConfigId: config.id,
      workspaceId: config.workspaceId || workspaceId,
      proposerSeatIndex,
      sourceSnapshot,
    });

    const nextIdeaSeatIndex =
      participants.length > 0
        ? (proposerSeatIndex + 1) % participants.length
        : config.nextIdeaSeatIndex;
    await this.configRepo.update({ id: config.id, nextIdeaSeatIndex });

    const multiLlmParticipants: MultiLlmParticipant[] = participants.map((participant, index) => ({
      providerType: participant.providerType,
      modelKey: participant.modelKey,
      displayName: participant.seatLabel,
      isJudge: index === clampIndex(config.judgeSeatIndex, participants.length),
      seatLabel: participant.seatLabel,
      roleInstruction: participant.roleInstruction,
      isIdeaProposer: index === proposerSeatIndex,
    }));
    const judgeSeatIndex = clampIndex(config.judgeSeatIndex, participants.length);
    const judge = participants[judgeSeatIndex];
    const maxParallelParticipants = computeParallelism(participants, config.executionPolicy);
    const multiLlmConfig: MultiLlmConfig = {
      participants: multiLlmParticipants,
      judgeProviderType: judge.providerType,
      judgeModelKey: judge.modelKey,
      maxParallelParticipants,
    };

    return {
      runId: run.id,
      title: `Council: ${config.name}`,
      prompt: await this.buildCouncilPrompt(config, proposerSeatIndex),
      workspaceId: config.workspaceId || workspaceId,
      agentConfig: {
        multiLlmMode: true,
        multiLlmConfig,
        councilMode: true,
        councilRunId: run.id,
        retainMemory: false,
        allowUserInput: false,
      },
    };
  }

  async bindRunTask(runId: string, taskId: string): Promise<CouncilRun | undefined> {
    return this.runRepo.bindTask(runId, taskId);
  }

  async finalizeRunForTask(taskId: string): Promise<CouncilRun | null> {
    const run = await this.runRepo.findByTaskId(taskId);
    if (!run || run.memoId) return run || null;

    const config = await this.configRepo.findById(run.councilConfigId);
    if (!config) return null;
    const task = await this.taskRepo.findById(taskId);
    const events = this.taskEventRepo.findByTaskId(taskId);
    const resolvedText =
      resolveTaskResultText({
        summary: task?.resultSummary,
        semanticSummary: task?.semanticSummary,
        verificationVerdict: task?.verificationVerdict,
        verificationReport: task?.verificationReport,
        events,
      }) ||
      task?.resultSummary ||
      task?.error ||
      "Council run completed without a synthesized memo.";
    const normalizedText = String(resolvedText).trim();
    const status =
      task?.status === "failed" || task?.status === "cancelled" ? "failed" : "completed";

    let delivered = false;
    let deliveryError: string | undefined;
    if (
      config.deliveryConfig.enabled &&
      config.deliveryConfig.channelType &&
      config.deliveryConfig.channelId &&
      this.deps.deliverToChannel
    ) {
      try {
        await this.deps.deliverToChannel({
          channelType: config.deliveryConfig.channelType,
          channelDbId: config.deliveryConfig.channelDbId,
          channelId: config.deliveryConfig.channelId,
          message: `**R&D Council Memo — ${config.name}**\n\n${normalizedText}`,
          idempotencyKey: `council:${run.id}`,
        });
        delivered = true;
      } catch (error: Any) {
        deliveryError = error?.message || String(error);
      }
    }

    const memo = await this.memoRepo.create({
      councilRunId: run.id,
      councilConfigId: run.councilConfigId,
      workspaceId: run.workspaceId,
      taskId,
      proposerSeatIndex: run.proposerSeatIndex,
      content: normalizedText,
      delivered,
      deliveryError,
    });

    const updatedRun = await this.runRepo.complete(run.id, {
      status,
      summary: normalizedText.slice(0, 1000),
      error: status === "failed" ? task?.error || deliveryError : undefined,
      memoId: memo.id,
    });

    await this.deps
      .getNotificationService?.()
      ?.add({
        type: status === "failed" ? "warning" : "info",
        title: `R&D Council memo: ${config.name}`,
        message:
          deliveryError && !delivered
            ? `Memo saved. Channel delivery failed: ${deliveryError}`
            : delivered
              ? "Memo saved and delivered."
              : "Memo saved in-app.",
        taskId,
        workspaceId: run.workspaceId,
      })
      .catch(() => undefined);

    return updatedRun || null;
  }

  async syncManagedJob(id: string): Promise<CouncilConfig> {
    const config = await this.configRepo.findById(id);
    if (!config) throw new Error(`Council not found: ${id}`);

    const cron = this.deps.getCronService();
    if (!cron) return config;

    const job: CronJobCreate = {
      name: `Council: ${config.name}`,
      description: `${COUNCIL_CRON_MARKER_PREFIX}${config.id}${COUNCIL_CRON_MARKER_SUFFIX}`,
      enabled: config.enabled,
      accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      schedule: config.schedule,
      workspaceId: config.workspaceId,
      taskPrompt: CouncilService.buildManagedTrigger(config.id),
      taskTitle: `Council: ${config.name}`,
      allowUserInput: false,
      maxHistoryEntries: 25,
    };

    if (config.managedCronJobId) {
      const result = await cron.update(config.managedCronJobId, {
        name: job.name,
        description: job.description,
        enabled: job.enabled,
        schedule: job.schedule,
        workspaceId: job.workspaceId,
        accessProfileId: job.accessProfileId,
        taskPrompt: job.taskPrompt,
        taskTitle: job.taskTitle,
        allowUserInput: false,
        maxHistoryEntries: job.maxHistoryEntries,
      });
      if (!result.ok) throw new Error(result.error);
      return (await this.configRepo.findById(id))!;
    }

    const added = await cron.add(job);
    if (!added.ok) throw new Error(added.error);
    const updated = await this.configRepo.update({ id, managedCronJobId: added.job.id });
    if (!updated) throw new Error(`Council not found after cron sync: ${id}`);
    return updated;
  }

  private async buildCouncilPrompt(
    config: CouncilConfig,
    proposerSeatIndex: number,
  ): Promise<string> {
    const sourceContext = await this.buildSourceContext(config.sourceBundle);
    const proposer = config.participants[clampIndex(proposerSeatIndex, config.participants.length)];
    return [
      `You are part of the R&D Council "${config.name}".`,
      "",
      "Goal:",
      "Review the curated business/product context below, debate next moves, and produce a revenue-growth memo.",
      "",
      `Special role for this run: ${proposer?.seatLabel || "Seat 1"} is the rotating idea proposer.`,
      "That proposer must introduce at least one concrete new growth idea.",
      "All other participants should challenge, refine, or reject weak ideas and push toward clear actions.",
      "",
      "Boundaries:",
      "- Review only the curated sources in this prompt.",
      "- Do not roam beyond the listed files, URLs, and connector references.",
      "- Use tools only if needed to inspect the listed sources more closely.",
      "",
      "Required final memo sections:",
      "1. Executive Summary",
      "2. What We Reviewed",
      "3. Best New Idea",
      "4. Where The Models Agreed",
      "5. Where They Disagreed",
      "6. Recommended Next Actions",
      "7. Experiments To Run",
      "8. Risks / Missing Inputs",
      "",
      sourceContext,
    ].join("\n");
  }

  private async buildSourceContext(sourceBundle: CouncilSourceBundle): Promise<string> {
    const lines: string[] = ["Curated source bundle:"];

    if (sourceBundle.files.length > 0) {
      lines.push("");
      lines.push("Files:");
      let remaining = MAX_TOTAL_SOURCE_BYTES;
      for (const file of sourceBundle.files) {
        const snippet = await this.readFileSnippet(
          file.path,
          Math.min(MAX_SOURCE_BYTES_PER_FILE, remaining),
        );
        remaining -= snippet.length;
        lines.push(`- ${file.label || path.basename(file.path)} (${file.path})`);
        lines.push(snippet ? `\n\`\`\`\n${snippet}\n\`\`\`` : "  [Could not read a text snippet]");
        if (remaining <= 0) break;
      }
    }

    if (sourceBundle.urls.length > 0) {
      lines.push("");
      lines.push("URLs:");
      for (const item of sourceBundle.urls) {
        lines.push(`- ${item.label || item.url}: ${item.url}`);
      }
    }

    if (sourceBundle.connectors.length > 0) {
      lines.push("");
      lines.push("Connector references:");
      for (const item of sourceBundle.connectors) {
        lines.push(
          `- ${item.label} [provider=${item.provider}${item.resourceId ? `, resource=${item.resourceId}` : ""}]${item.notes ? ` — ${item.notes}` : ""}`,
        );
      }
    }

    if (
      sourceBundle.files.length === 0 &&
      sourceBundle.urls.length === 0 &&
      sourceBundle.connectors.length === 0
    ) {
      lines.push("- No curated sources configured yet.");
    }

    return lines.join("\n");
  }

  private async readFileSnippet(filePath: string, maxBytes: number): Promise<string> {
    try {
      if (!isSafeFilePath(filePath)) return "";
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return "";
      const buffer = await fs.readFile(filePath);
      const slice = buffer.subarray(0, Math.min(buffer.length, Math.max(0, maxBytes)));
      const text = slice
        .toString("utf8")
        .replace(/\u0000/g, "")
        .trim();
      return text.length > 0 ? text : "";
    } catch {
      return "";
    }
  }
}
