import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type {
  AgentConfig,
  AutonomyPolicyPreset,
  ExternalRuntimeAgent,
  Issue,
  IssueComment,
  SymphonyConfig,
  SymphonyConfigUpdate,
  SymphonyStatus,
  SymphonyStatusIssueRef,
  SymphonyWorkflowDefinition,
} from "../../shared/types";
import type { AgentDaemon } from "../agent/daemon";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import { buildAgentConfigFromAutonomyPolicy } from "../agents/autonomy-policy";
import { ControlPlaneCoreService } from "./ControlPlaneCoreService";

type AnyRecord = Record<string, unknown>;

const DEFAULT_CONFIG: Omit<SymphonyConfig, "createdAt" | "updatedAt"> = {
  enabled: false,
  activeStatuses: ["todo"],
  terminalStatuses: ["done", "cancelled"],
  maxConcurrentIssueRuns: 2,
  approvalPreset: "safe_autonomy",
  runtimeMode: "native",
  runtimeAgent: "codex",
  handoffStatus: "review",
  maxRetries: 2,
  retryBaseDelayMs: 60_000,
  pollIntervalMs: 30_000,
};

const SETTINGS_ID = "default";
const DEFAULT_PROMPT =
  "You are working on a CoWork OS issue. Move it forward, verify your work, and leave a concise handoff summary for human review.";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => String(parseScalar(entry.trim())).trim())
      .filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseSimpleYaml(frontMatter: string): AnyRecord {
  const root: AnyRecord = {};
  let currentKey: string | null = null;
  for (const rawLine of frontMatter.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const topLevel = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, rawValue] = topLevel;
      if (rawValue.trim()) {
        root[key] = parseScalar(rawValue);
        currentKey = null;
      } else {
        root[key] = {};
        currentKey = key;
      }
      continue;
    }
    const nested = rawLine.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && currentKey && root[currentKey] && typeof root[currentKey] === "object") {
      const [, key, rawValue] = nested;
      (root[currentKey] as AnyRecord)[key] = parseScalar(rawValue);
    }
  }
  return root;
}

export function loadSymphonyWorkflow(input: {
  workspacePath: string;
  workflowPath?: string;
}): SymphonyWorkflowDefinition {
  const requestedPath = input.workflowPath?.trim() || "WORKFLOW.md";
  const expanded = expandHome(requestedPath);
  const workflowPath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(input.workspacePath, expanded);

  try {
    const content = fs.readFileSync(workflowPath, "utf8");
    let config: AnyRecord = {};
    let promptTemplate = content.trim();
    if (content.startsWith("---")) {
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (!match) {
        throw new Error("Invalid WORKFLOW.md front matter");
      }
      config = parseSimpleYaml(match[1] || "");
      promptTemplate = (match[2] || "").trim();
    }
    return {
      path: workflowPath,
      config,
      promptTemplate: promptTemplate || DEFAULT_PROMPT,
      loadedAt: Date.now(),
    };
  } catch (error) {
    return {
      path: workflowPath,
      config: {},
      promptTemplate: DEFAULT_PROMPT,
      loadedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeIssueStatuses(value: unknown, fallback: Issue["status"][]): Issue["status"][] {
  const allowed = new Set<Issue["status"]>([
    "backlog",
    "todo",
    "in_progress",
    "review",
    "done",
    "blocked",
    "cancelled",
  ]);
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map((entry) => String(entry || "").trim() as Issue["status"])
    .filter((entry) => allowed.has(entry));
  return normalized.length > 0 ? normalized : fallback;
}

function getSymphonyMetadata(issue: Issue): AnyRecord {
  const raw = issue.metadata?.symphony;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AnyRecord) : {};
}

function setSymphonyMetadata(issue: Issue, updates: AnyRecord): Record<string, unknown> {
  return {
    ...issue.metadata,
    symphony: {
      ...getSymphonyMetadata(issue),
      ...updates,
    },
  };
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

function getRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : undefined;
}

function normalizeRuntimeMode(value: unknown): "native" | "acpx" | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "native" || normalized === "acpx") return normalized;
  return undefined;
}

function normalizeRuntimeAgent(value: unknown): ExternalRuntimeAgent | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "codex" || normalized === "claude") return normalized;
  return undefined;
}

export class SymphonyService {
  private readonly core: ControlPlaneCoreService;
  private readonly taskRepo: TaskRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | undefined;
  private detachDaemonListeners: (() => void) | null = null;

  constructor(
    private readonly deps: {
      db: Database.Database;
      agentDaemon?: AgentDaemon;
      log?: (...args: unknown[]) => void;
    },
  ) {
    this.core = new ControlPlaneCoreService(deps.db);
    this.taskRepo = new TaskRepository(deps.db);
    this.workspaceRepo = new WorkspaceRepository(deps.db);
    this.ensureSchema();
  }

  start(): void {
    this.stop();
    const config = this.getConfig();
    if (config.enabled) {
      this.intervalHandle = setInterval(() => {
        void this.runOnce("schedule");
      }, config.pollIntervalMs);
      this.intervalHandle.unref();
    }
    this.attachDaemonListeners();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.detachDaemonListeners?.();
    this.detachDaemonListeners = null;
  }

  getConfig(): SymphonyConfig {
    const row = this.deps.db
      .prepare("SELECT * FROM symphony_configs WHERE id = ?")
      .get(SETTINGS_ID) as AnyRecord | undefined;
    if (!row) return this.insertDefaultConfig();
    const now = Date.now();
    return {
      enabled: Boolean(row.enabled),
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
      workflowPath: typeof row.workflow_path === "string" ? row.workflow_path : undefined,
      activeStatuses: parseJson(row.active_statuses as string | null, DEFAULT_CONFIG.activeStatuses),
      terminalStatuses: parseJson(row.terminal_statuses as string | null, DEFAULT_CONFIG.terminalStatuses),
      maxConcurrentIssueRuns: Math.max(1, Number(row.max_concurrent_issue_runs) || DEFAULT_CONFIG.maxConcurrentIssueRuns),
      approvalPreset: (row.approval_preset as AutonomyPolicyPreset) || DEFAULT_CONFIG.approvalPreset,
      runtimeMode: row.runtime_mode === "acpx" ? "acpx" : "native",
      runtimeAgent: row.runtime_agent === "claude" ? "claude" : "codex",
      handoffStatus: (row.handoff_status as Issue["status"]) || DEFAULT_CONFIG.handoffStatus,
      maxRetries: Math.max(0, Number(row.max_retries) || DEFAULT_CONFIG.maxRetries),
      retryBaseDelayMs: Math.max(1000, Number(row.retry_base_delay_ms) || DEFAULT_CONFIG.retryBaseDelayMs),
      pollIntervalMs: Math.max(5000, Number(row.poll_interval_ms) || DEFAULT_CONFIG.pollIntervalMs),
      createdAt: Number(row.created_at) || now,
      updatedAt: Number(row.updated_at) || now,
      lastRunAt: Number(row.last_run_at) || undefined,
    };
  }

  updateConfig(updates: SymphonyConfigUpdate): SymphonyConfig {
    const existing = this.getConfig();
    const next: SymphonyConfig = {
      ...existing,
      ...(typeof updates.enabled === "boolean" ? { enabled: updates.enabled } : {}),
      ...(updates.workspaceId === null
        ? { workspaceId: undefined }
        : typeof updates.workspaceId === "string"
          ? { workspaceId: updates.workspaceId.trim() || undefined }
          : {}),
      ...(updates.workflowPath === null
        ? { workflowPath: undefined }
        : typeof updates.workflowPath === "string"
          ? { workflowPath: updates.workflowPath.trim() || undefined }
          : {}),
      activeStatuses: normalizeIssueStatuses(updates.activeStatuses, existing.activeStatuses),
      terminalStatuses: normalizeIssueStatuses(updates.terminalStatuses, existing.terminalStatuses),
      maxConcurrentIssueRuns:
        typeof updates.maxConcurrentIssueRuns === "number"
          ? Math.max(1, Math.min(20, Math.round(updates.maxConcurrentIssueRuns)))
          : existing.maxConcurrentIssueRuns,
      approvalPreset: updates.approvalPreset || existing.approvalPreset,
      runtimeMode: updates.runtimeMode || existing.runtimeMode,
      runtimeAgent:
        updates.runtimeAgent === null ? undefined : updates.runtimeAgent || existing.runtimeAgent || "codex",
      handoffStatus: updates.handoffStatus || existing.handoffStatus,
      maxRetries:
        typeof updates.maxRetries === "number"
          ? Math.max(0, Math.min(10, Math.round(updates.maxRetries)))
          : existing.maxRetries,
      retryBaseDelayMs:
        typeof updates.retryBaseDelayMs === "number"
          ? Math.max(1000, Math.round(updates.retryBaseDelayMs))
          : existing.retryBaseDelayMs,
      pollIntervalMs:
        typeof updates.pollIntervalMs === "number"
          ? Math.max(5000, Math.round(updates.pollIntervalMs))
          : existing.pollIntervalMs,
      lastRunAt: updates.lastRunAt === null ? undefined : updates.lastRunAt ?? existing.lastRunAt,
      updatedAt: Date.now(),
    };

    this.deps.db
      .prepare(
        `
          UPDATE symphony_configs
          SET enabled = ?, workspace_id = ?, workflow_path = ?, active_statuses = ?,
              terminal_statuses = ?, max_concurrent_issue_runs = ?, approval_preset = ?,
              runtime_mode = ?, runtime_agent = ?, handoff_status = ?, max_retries = ?,
              retry_base_delay_ms = ?, poll_interval_ms = ?, last_run_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        next.enabled ? 1 : 0,
        next.workspaceId || null,
        next.workflowPath || null,
        JSON.stringify(next.activeStatuses),
        JSON.stringify(next.terminalStatuses),
        next.maxConcurrentIssueRuns,
        next.approvalPreset,
        next.runtimeMode,
        next.runtimeAgent || null,
        next.handoffStatus,
        next.maxRetries,
        next.retryBaseDelayMs,
        next.pollIntervalMs,
        next.lastRunAt ?? null,
        next.updatedAt,
        SETTINGS_ID,
      );
    this.start();
    return this.getConfig();
  }

  getStatus(): SymphonyStatus {
    const config = this.getConfig();
    const workspace = this.resolveWorkspace(config);
    const workflow = workspace
      ? loadSymphonyWorkflow({ workspacePath: workspace.path, workflowPath: config.workflowPath })
      : {
          path: config.workflowPath || "WORKFLOW.md",
          config: {},
          promptTemplate: DEFAULT_PROMPT,
          loadedAt: Date.now(),
          error: "No workspace configured for Symphony.",
        };
    const issues = this.core.listIssues({
      workspaceId: config.workspaceId,
      limit: 1000,
    });
    const activeRuns = issues
      .filter((issue) => issue.activeRunId && getSymphonyMetadata(issue).lastRunId === issue.activeRunId)
      .map((issue) => this.toStatusIssueRef(issue));
    const retryQueue = issues
      .filter((issue) => typeof getSymphonyMetadata(issue).retryDueAt === "number")
      .map((issue) => this.toStatusIssueRef(issue));
    const latestDispatches = issues
      .filter((issue) => typeof getSymphonyMetadata(issue).lastDispatchAt === "number")
      .sort(
        (a, b) =>
          Number(getSymphonyMetadata(b).lastDispatchAt || 0) -
          Number(getSymphonyMetadata(a).lastDispatchAt || 0),
      )
      .slice(0, 8)
      .map((issue) => this.toStatusIssueRef(issue));
    return {
      state: this.running ? "running" : workflow.error ? "blocked" : this.lastError ? "error" : "idle",
      config,
      workflow,
      activeRuns,
      retryQueue,
      latestDispatches,
      lastError: this.lastError,
    };
  }

  async runOnce(_trigger: "manual" | "schedule" = "manual"): Promise<SymphonyStatus> {
    const config = this.getConfig();
    if (!config.enabled) {
      return this.getStatus();
    }
    if (this.running) {
      return this.getStatus();
    }
    this.running = true;
    this.lastError = undefined;
    try {
      const workspace = this.resolveWorkspace(config);
      if (!workspace) throw new Error("No workspace configured for Symphony.");
      const workflow = loadSymphonyWorkflow({
        workspacePath: workspace.path,
        workflowPath: config.workflowPath,
      });
      if (workflow.error) {
        throw new Error(`WORKFLOW.md unavailable: ${workflow.error}`);
      }
      const dispatchConfig = this.applyWorkflowConfig(config, workflow);

      const allIssues = this.core.listIssues({ workspaceId: workspace.id, limit: 1000 });
      const activeCount = allIssues.filter(
        (issue) => issue.activeRunId && getSymphonyMetadata(issue).lastRunId === issue.activeRunId,
      ).length;
      const slots = Math.max(0, dispatchConfig.maxConcurrentIssueRuns - activeCount);
      if (slots === 0) return this.getStatus();

      const now = Date.now();
      const candidates = allIssues
        .filter((issue) => dispatchConfig.activeStatuses.includes(issue.status))
        .filter((issue) => !dispatchConfig.terminalStatuses.includes(issue.status))
        .filter((issue) => !issue.activeRunId)
        .filter((issue) => {
          const metadata = getSymphonyMetadata(issue);
          const retryDueAt = Number(metadata.retryDueAt || 0);
          return !retryDueAt || retryDueAt <= now;
        })
        .sort((a, b) => {
          const priority = (b.priority || 0) - (a.priority || 0);
          return priority !== 0 ? priority : a.updatedAt - b.updatedAt;
        })
        .slice(0, slots);

      for (const issue of candidates) {
        await this.dispatchIssue(issue, workspace.id, workflow, dispatchConfig);
      }
      this.updateConfig({ lastRunAt: Date.now() });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.log?.("[Symphony]", this.lastError);
    } finally {
      this.running = false;
    }
    return this.getStatus();
  }

  private async dispatchIssue(
    issue: Issue,
    workspaceId: string,
    workflow: SymphonyWorkflowDefinition,
    config: SymphonyConfig,
  ): Promise<void> {
    const checkout = this.core.checkoutIssue({
      issueId: issue.id,
      agentRoleId: issue.assigneeAgentRoleId,
      workspaceId,
    });
    try {
      if (!this.deps.agentDaemon) {
        throw new Error("Agent daemon unavailable for Symphony dispatch.");
      }
      const prompt = this.buildPrompt(issue, workflow, config, checkout.run.id);
      const agentConfig = this.buildAgentConfig(config);
      const task = await this.deps.agentDaemon.createTask({
        title: issue.title,
        prompt,
        workspaceId,
        agentConfig,
        source: "symphony",
        taskOverrides: {
          issueId: issue.id,
          heartbeatRunId: checkout.run.id,
          companyId: issue.companyId,
          goalId: issue.goalId,
          projectId: issue.projectId,
          requestDepth: issue.requestDepth,
          billingCode: issue.billingCode,
          assignedAgentRoleId: issue.assigneeAgentRoleId,
        },
      });
      this.core.attachTaskToRun(checkout.run.id, task.id);
      const latest = this.core.getIssue(issue.id);
      if (latest) {
        this.core.updateIssue(issue.id, {
          metadata: setSymphonyMetadata(latest, {
            workflowPath: workflow.path,
            lastDispatchAt: Date.now(),
            lastRunId: checkout.run.id,
            retryDueAt: null,
          }),
        });
      }
    } catch (error) {
      this.releaseDispatchFailure(issue.id, checkout.run.id, config, error);
      throw error;
    }
  }

  private applyWorkflowConfig(
    config: SymphonyConfig,
    workflow: SymphonyWorkflowDefinition,
  ): SymphonyConfig {
    const workflowConfig = workflow.config || {};
    const runtimeBlock = getRecord(workflowConfig.runtime);
    const runtimeMode =
      normalizeRuntimeMode(runtimeBlock?.mode) ||
      normalizeRuntimeMode(runtimeBlock?.kind) ||
      normalizeRuntimeMode(workflowConfig.runtimeMode) ||
      normalizeRuntimeMode(workflowConfig.runtime) ||
      config.runtimeMode;
    const runtimeAgent =
      normalizeRuntimeAgent(runtimeBlock?.agent) ||
      normalizeRuntimeAgent(workflowConfig.runtimeAgent) ||
      normalizeRuntimeAgent(workflowConfig.acpxAgent) ||
      config.runtimeAgent;
    return {
      ...config,
      runtimeMode,
      runtimeAgent,
    };
  }

  private releaseDispatchFailure(
    issueId: string,
    runId: string,
    config: SymphonyConfig,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.core.releaseIssue({
      issueId,
      runId,
      status: "failed",
      error: message,
    });
    const released = this.core.getIssue(issueId);
    if (!released) return;
    const retryCount = Number(getSymphonyMetadata(released).retryCount || 0) + 1;
    const retryDueAt =
      retryCount <= config.maxRetries
        ? Date.now() + config.retryBaseDelayMs * Math.pow(2, retryCount - 1)
        : undefined;
    this.core.updateIssue(issueId, {
      status: retryDueAt ? "todo" : config.handoffStatus,
      completedAt: null,
      metadata: setSymphonyMetadata(released, {
        retryCount,
        retryDueAt: retryDueAt || null,
        lastError: message,
      }),
    });
    this.core.createIssueComment({
      issueId,
      authorType: "system",
      body: retryDueAt
        ? `Symphony dispatch failed; retry ${retryCount}/${config.maxRetries} scheduled.`
        : `Symphony dispatch failed; retry limit reached and issue moved to ${config.handoffStatus}.`,
    });
  }

  private buildAgentConfig(config: SymphonyConfig): AgentConfig {
    const autonomyConfig = buildAgentConfigFromAutonomyPolicy({
      preset: config.approvalPreset,
      autonomousMode: true,
      allowUserInput: false,
      requireWorktree: true,
    });
    return {
      ...autonomyConfig,
      autonomousMode: true,
      allowUserInput: false,
      requireWorktree: true,
      ...(config.runtimeMode === "acpx"
        ? {
            externalRuntime: {
              kind: "acpx",
              agent: (config.runtimeAgent || "codex") as ExternalRuntimeAgent,
              sessionMode: "persistent",
              outputMode: "json",
              permissionMode: config.approvalPreset === "manual" ? "approve-reads" : "approve-all",
            },
          }
        : {}),
    };
  }

  private buildPrompt(
    issue: Issue,
    workflow: SymphonyWorkflowDefinition,
    config: SymphonyConfig,
    runId: string,
  ): string {
    const company = this.core.getCompany(issue.companyId);
    const goal = issue.goalId ? this.core.getGoal(issue.goalId) : undefined;
    const project = issue.projectId ? this.core.getProject(issue.projectId) : undefined;
    const workspace = this.resolveWorkspace(config);
    const comments = this.core.listIssueComments(issue.id);
    const retryCount = Number(getSymphonyMetadata(issue).retryCount || 0);
    const values: Record<string, string> = {
      "issue.id": issue.id,
      "issue.title": issue.title,
      "issue.description": issue.description || "",
      "issue.status": issue.status,
      "issue.priority": String(issue.priority),
      "company.name": company?.name || "",
      "goal.title": goal?.title || "",
      "project.name": project?.name || "",
      "workspace.path": workspace?.path || "",
      attempt: String(retryCount + 1),
      runId,
    };
    const rendered = renderTemplate(workflow.promptTemplate, values);
    return [
      rendered,
      "",
      "CoWork Symphony issue context:",
      `- Issue: ${issue.title}`,
      issue.description ? `- Description: ${issue.description}` : "",
      `- Status: ${issue.status}`,
      `- Priority: ${issue.priority}`,
      company ? `- Company: ${company.name}` : "",
      goal ? `- Goal: ${goal.title}` : "",
      project ? `- Project: ${project.name}` : "",
      workspace ? `- Workspace path: ${workspace.path}` : "",
      `- Run attempt: ${retryCount + 1}`,
      `- Human handoff status: ${config.handoffStatus}`,
      "",
      this.formatComments(comments),
      "",
      "Finish by leaving a concise implementation and verification handoff. Do not merge automatically.",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  private formatComments(comments: IssueComment[]): string {
    if (comments.length === 0) return "Existing issue comments: none.";
    return [
      "Existing issue comments:",
      ...comments.slice(-10).map((comment) => `- ${comment.authorType}: ${comment.body}`),
    ].join("\n");
  }

  private attachDaemonListeners(): void {
    if (this.detachDaemonListeners || !this.deps.agentDaemon) return;
    const handler = (event: { taskId?: string; payload?: { status?: string } }) => {
      const taskId = event?.taskId;
      if (!taskId) return;
      const status = event.payload?.status;
      if (
        status &&
        !["completed", "failed", "cancelled", "interrupted"].includes(status)
      ) {
        return;
      }
      this.handleTerminalTask(taskId);
    };
    this.deps.agentDaemon.on("task_completed", handler);
    this.deps.agentDaemon.on("task_cancelled", handler);
    this.deps.agentDaemon.on("task_status", handler);
    this.detachDaemonListeners = () => {
      this.deps.agentDaemon?.off("task_completed", handler);
      this.deps.agentDaemon?.off("task_cancelled", handler);
      this.deps.agentDaemon?.off("task_status", handler);
    };
  }

  private handleTerminalTask(taskId: string): void {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.source !== "symphony" || !task.issueId) return;
    const issue = this.core.getIssue(task.issueId);
    if (!issue) return;
    const config = this.getConfig();
    const metadata = getSymphonyMetadata(issue);
    if (task.status === "completed") {
      this.core.updateIssue(issue.id, {
        status: config.handoffStatus,
        completedAt: null,
        metadata: setSymphonyMetadata(issue, {
          retryDueAt: null,
          lastCompletedAt: Date.now(),
        }),
      });
      this.core.createIssueComment({
        issueId: issue.id,
        authorType: "system",
        body: `Symphony run completed and moved this issue to ${config.handoffStatus}.`,
      });
      return;
    }

    if (!["failed", "cancelled", "interrupted"].includes(task.status)) return;
    const retryCount = Number(metadata.retryCount || 0) + 1;
    const retryDueAt =
      retryCount <= config.maxRetries
        ? Date.now() + config.retryBaseDelayMs * Math.pow(2, retryCount - 1)
        : undefined;
    this.core.updateIssue(issue.id, {
      status: retryDueAt ? "todo" : config.handoffStatus,
      completedAt: null,
      metadata: setSymphonyMetadata(issue, {
        retryCount,
        retryDueAt: retryDueAt || null,
        lastError: task.error || `Task ${task.status}`,
      }),
    });
    this.core.createIssueComment({
      issueId: issue.id,
      authorType: "system",
      body: retryDueAt
        ? `Symphony run ${task.status}; retry ${retryCount}/${config.maxRetries} scheduled.`
        : `Symphony run ${task.status}; retry limit reached and issue moved to ${config.handoffStatus}.`,
    });
  }

  private toStatusIssueRef(issue: Issue): SymphonyStatusIssueRef {
    const metadata = getSymphonyMetadata(issue);
    return {
      issueId: issue.id,
      title: issue.title,
      status: issue.status,
      taskId: issue.taskId,
      runId: issue.activeRunId || (metadata.lastRunId as string | undefined),
      retryCount: Number(metadata.retryCount || 0),
      retryDueAt: Number(metadata.retryDueAt || 0) || undefined,
      lastDispatchAt: Number(metadata.lastDispatchAt || 0) || undefined,
    };
  }

  private resolveWorkspace(config: SymphonyConfig): ReturnType<WorkspaceRepository["findById"]> | undefined {
    if (config.workspaceId) {
      const configured = this.workspaceRepo.findById(config.workspaceId);
      if (configured) return configured;
    }
    return this.workspaceRepo.findAll().find((workspace) => !workspace.isTemp);
  }

  private insertDefaultConfig(): SymphonyConfig {
    const now = Date.now();
    this.deps.db
      .prepare(
        `
          INSERT OR IGNORE INTO symphony_configs (
            id, enabled, workspace_id, workflow_path, active_statuses, terminal_statuses,
            max_concurrent_issue_runs, approval_preset, runtime_mode, runtime_agent,
            handoff_status, max_retries, retry_base_delay_ms, poll_interval_ms,
            last_run_at, created_at, updated_at
          ) VALUES (?, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `,
      )
      .run(
        SETTINGS_ID,
        JSON.stringify(DEFAULT_CONFIG.activeStatuses),
        JSON.stringify(DEFAULT_CONFIG.terminalStatuses),
        DEFAULT_CONFIG.maxConcurrentIssueRuns,
        DEFAULT_CONFIG.approvalPreset,
        DEFAULT_CONFIG.runtimeMode,
        DEFAULT_CONFIG.runtimeAgent,
        DEFAULT_CONFIG.handoffStatus,
        DEFAULT_CONFIG.maxRetries,
        DEFAULT_CONFIG.retryBaseDelayMs,
        DEFAULT_CONFIG.pollIntervalMs,
        now,
        now,
      );
    return {
      ...DEFAULT_CONFIG,
      createdAt: now,
      updatedAt: now,
    };
  }

  private ensureSchema(): void {
    this.deps.db.exec(`
      CREATE TABLE IF NOT EXISTS symphony_configs (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        workflow_path TEXT,
        active_statuses TEXT NOT NULL,
        terminal_statuses TEXT NOT NULL,
        max_concurrent_issue_runs INTEGER NOT NULL DEFAULT 2,
        approval_preset TEXT NOT NULL DEFAULT 'safe_autonomy',
        runtime_mode TEXT NOT NULL DEFAULT 'native',
        runtime_agent TEXT,
        handoff_status TEXT NOT NULL DEFAULT 'review',
        max_retries INTEGER NOT NULL DEFAULT 2,
        retry_base_delay_ms INTEGER NOT NULL DEFAULT 60000,
        poll_interval_ms INTEGER NOT NULL DEFAULT 30000,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.insertDefaultConfig();
  }
}

let symphonyServiceInstance: SymphonyService | null = null;

export function setSymphonyService(service: SymphonyService | null): void {
  symphonyServiceInstance = service;
}

export function getSymphonyService(): SymphonyService | null {
  return symphonyServiceInstance;
}
