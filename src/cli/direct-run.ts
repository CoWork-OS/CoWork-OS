#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../electron/database/schema";
import { SecureSettingsRepository } from "../electron/database/SecureSettingsRepository";
import {
  ApprovalRepository,
  LLMModelRepository,
  SkillRepository,
  TaskEventRepository,
  TaskRepository,
  TaskSessionMetadataRepository,
  WorkspacePermissionRuleRepository,
  WorkspaceRepository,
} from "../electron/database/repositories";
import {
  SessionRetentionService,
  type SessionRetentionFilters,
  type TaskSessionSummary,
} from "../electron/sessions/SessionRetentionService";
import { AgentDaemon } from "../electron/agent/daemon";
import { LLMProviderFactory } from "../electron/agent/llm";
import { SearchProviderFactory } from "../electron/agent/search";
import { BuiltinToolsSettingsManager } from "../electron/agent/tools/builtin-settings";
import { GuardrailManager } from "../electron/guardrails/guardrail-manager";
import { AppearanceManager } from "../electron/settings/appearance-manager";
import { PersonalityManager } from "../electron/settings/personality-manager";
import { MemoryFeaturesManager } from "../electron/settings/memory-features-manager";
import { MemoryService } from "../electron/memory/MemoryService";
import { MCPClientManager } from "../electron/mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../electron/mcp/settings";
import { getUserDataDir } from "../electron/utils/user-data-dir";
import { LLMSettingsSchema, MCPSettingsSchema } from "../electron/utils/validation";
import {
  importProcessEnvToSettings,
  migrateEnvToSettings,
} from "../electron/utils/env-migration";
import {
  getEnvSettingsImportModeFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
} from "../electron/utils/runtime-mode";
import { isTerminalTaskStatus } from "../shared/task-status";
import type { AgentConfig, CliTaskOwnership, Task } from "../shared/types";
import { buildTaskTitle } from "./format";

type Any = Record<string, any>;

interface DirectRunArgs {
  command:
    | "run"
    | "doctor"
    | "version"
    | "status"
    | "providers-list"
    | "providers-fallback-list"
    | "providers-fallback-add"
    | "providers-fallback-remove"
    | "workspace-list"
    | "workspace-create"
    | "tail"
    | "approvals-list"
    | "providers-configure"
    | "sessions-list"
    | "sessions-show"
    | "sessions-export"
    | "sessions-rename"
    | "sessions-archive"
    | "sessions-delete"
    | "sessions-prune"
    | "tasks-list"
    | "tasks-cancel"
    | "tasks-attach"
    | "tasks-stale"
    | "tasks-cleanup"
    | "logs-latest"
    | "logs-tail"
    | "logs-grep"
    | "tools-list"
    | "tools-info"
    | "tools-enable"
    | "tools-disable"
    | "mcp-list"
    | "mcp-add"
    | "mcp-remove"
    | "mcp-enable"
    | "mcp-disable"
    | "mcp-test"
    | "skills-list"
    | "skills-info"
    | "skills-audit"
    | "models-list"
    | "backup-create"
    | "backup-restore"
    | "security-audit"
    | "security-rules-list"
    | "security-rules-remove"
    | "prompt-size"
    | "prompt-preview"
    | "dashboard-status";
  prompt: string;
  cwd: string;
  taskId?: string;
  sessionId?: string;
  limit?: number;
  days?: number;
  providerType?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  output?: string;
  query?: string;
  name?: string;
  transport?: string;
  commandLine?: string;
  url?: string;
  category?: string;
  tool?: string;
  ruleId?: string;
  workspaceName?: string;
  title?: string;
  workspaceId?: string;
  olderThan?: string;
  newerThan?: string;
  after?: string;
  before?: string;
  source?: string;
  cwdFilter?: string;
  endReason?: string;
  minTokens?: number;
  maxTokens?: number;
  minCost?: number;
  maxCost?: number;
  shellAccess?: boolean;
  detach?: boolean;
  detachedWorker?: boolean;
  readyFile?: string;
  activeOnly?: boolean;
  cliOnly?: boolean;
  interruptedCli?: boolean;
  includeSecrets?: boolean;
  includeArchived?: boolean;
  all?: boolean;
  vacuum?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseDirectRunArgs(argv);
  if (args.command === "run" && !args.prompt) {
    process.stderr.write('Usage: cowork-direct-run --prompt "task" [--cwd <path>]\n');
    return 1;
  }

  process.env.COWORK_HEADLESS = process.env.COWORK_HEADLESS || "1";
  const allowEnvImport = shouldImportEnvForCommand(args.command);
  if (allowEnvImport) {
    process.env.COWORK_IMPORT_ENV_SETTINGS =
      process.env.COWORK_IMPORT_ENV_SETTINGS ||
      (hasProviderEnv() ? "1" : process.env.COWORK_IMPORT_ENV_SETTINGS || "");
  }

  let daemon: AgentDaemon | null = null;
  let mcpClientManager: MCPClientManager | null = null;
  let taskRepo: TaskRepository | null = null;
  let activeTaskId: string | null = null;
  let activeCliRunId: string | null = null;
  let activeInterruptPolicy: CliTaskOwnership["interruptPolicy"] = "cancel";
  let cliHeartbeat: ReturnType<typeof setInterval> | null = null;
  let done = false;
  const restoreConsole = installCliLogFilter();

  try {
    const dbManager = new DatabaseManager();
    new SecureSettingsRepository(dbManager.getDatabase());
    taskRepo = new TaskRepository(dbManager.getDatabase());

    LLMProviderFactory.initialize();
    SearchProviderFactory.initialize();
    GuardrailManager.initialize();
    AppearanceManager.initialize();
    PersonalityManager.initialize();
    MemoryFeaturesManager.initialize();

    if (allowEnvImport) {
      await migrateEnvToSettings();
    }
    if (allowEnvImport && shouldImportEnvSettingsFromArgsOrEnv()) {
      await importProcessEnvToSettings({
        mode: getEnvSettingsImportModeFromArgsOrEnv(),
      });
    }

    const localResult = await runLocalMetadataCommand(dbManager, args);
    if (localResult !== null) return localResult;

    MemoryService.initialize(dbManager);

    daemon = new AgentDaemon(dbManager, { startupRecovery: false });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await daemon.initialize();

    try {
      mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.initialize();
    } catch (error) {
      const message = `[MCP] ${error instanceof Error ? error.message : String(error)}`;
      writeEvent(args, { type: "mcp_error", message }, message);
    }

    const workspace = await resolveWorkspace(daemon, args);
    if (args.shellAccess) {
      daemon.updateWorkspacePermissions(workspace.id, { shell: true });
    }
    const cliRunId = randomUUID();
    const cliOwnership: CliTaskOwnership = {
      owner: "cowork-run",
      runId: cliRunId,
      pid: process.pid,
      startedAt: Date.now(),
      cwd: path.resolve(args.cwd),
      mode: args.detachedWorker || args.detach ? "detached" : "attached",
      interruptPolicy: args.detachedWorker || args.detach ? "detach" : "cancel",
      lastSeenAt: Date.now(),
    };
    const agentConfig: AgentConfig = {
      ...(args.shellAccess ? { shellAccess: true } : {}),
      cli: cliOwnership,
    };

    const task = await daemon.createTask({
      title: args.title || buildTaskTitle(args.prompt),
      prompt: args.prompt,
      workspaceId: workspace.id,
      agentConfig,
      autoStart: false,
    });
    activeTaskId = task.id;
    activeCliRunId = cliRunId;
    activeInterruptPolicy = cliOwnership.interruptPolicy;
    startCliHeartbeat();

    writeEvent(args, {
      type: "task_created",
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        workspaceId: task.workspaceId,
      },
    }, `Created task: ${task.id}  ${task.title}`);
    if (args.readyFile) {
      await writeDetachedReadyFile(args.readyFile, task);
    }

    daemon.on("assistant_message", (payload: Any) => {
      if (payload?.taskId !== task.id) return;
      const message = stringifyMessage(payload.message || payload.text || payload.content);
      if (message) writeEvent(args, { type: "assistant_message", taskId: task.id, message }, message);
    });
    daemon.on("task_status", (payload: Any) => {
      if (payload?.taskId !== task.id) return;
      const message = stringifyMessage(payload.message || payload.status);
      if (message) writeEvent(args, { type: "task_status", taskId: task.id, message }, message);
    });
    daemon.on("task_completed", (payload: Any) => {
      if (payload?.taskId !== task.id) return;
      const message = stringifyMessage(payload.message || payload.resultSummary || "Task completed.");
      if (message) writeEvent(args, { type: "task_completed", taskId: task.id, message }, message);
      done = true;
    });

    await daemon.startTask(task);

    const status = await waitForTerminalTask(daemon, task.id, args);
    await updateActiveCliOwnership({ endedAt: Date.now(), exitCode: status === "completed" ? 0 : 1 });
    stopCliHeartbeat();
    activeTaskId = null;
    activeCliRunId = null;
    done = true;
    return status === "failed" || status === "cancelled" ? 1 : 0;
  } catch (error) {
    writeError(args, formatError(error));
    return 1;
  } finally {
    done = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopCliHeartbeat();
    await shutdownRuntime();
    restoreConsole();
  }

  function onSignal(signal?: NodeJS.Signals): void {
    if (done) return;
    done = true;
    const shouldCancel = activeInterruptPolicy === "cancel" || signal === "SIGTERM";
    const settle = shouldCancel
      ? cancelActiveTask()
      : updateActiveCliOwnership({ endedAt: Date.now(), exitCode: 130 });
    void settle.finally(() => {
      stopCliHeartbeat();
      void shutdownRuntime().finally(() => process.exit(130));
    });
  }

  async function cancelActiveTask(): Promise<void> {
    const taskId = activeTaskId;
    if (!daemon || !taskId) return;
    try {
      await daemon.cancelTask(taskId);
      await updateActiveCliOwnership({ endedAt: Date.now(), exitCode: 130 });
    } catch {
      // Best-effort: SIGINT should still tear down the direct runner.
    } finally {
      activeTaskId = null;
      activeCliRunId = null;
    }
  }

  function startCliHeartbeat(): void {
    stopCliHeartbeat();
    cliHeartbeat = setInterval(() => {
      void updateActiveCliOwnership({ lastSeenAt: Date.now() });
    }, 5000);
  }

  function stopCliHeartbeat(): void {
    if (cliHeartbeat) {
      clearInterval(cliHeartbeat);
      cliHeartbeat = null;
    }
  }

  async function updateActiveCliOwnership(updates: Partial<CliTaskOwnership>): Promise<void> {
    const taskId = activeTaskId;
    const runId = activeCliRunId;
    if (!taskRepo || !taskId || !runId) return;
    const task = taskRepo.findById(taskId);
    const cli = getCliOwnership(task);
    if (!task || !cli || cli.runId !== runId) return;
    taskRepo.update(taskId, {
      agentConfig: {
        ...(task.agentConfig || {}),
        cli: {
          ...cli,
          ...updates,
        },
      },
    });
  }

  async function shutdownRuntime(): Promise<void> {
    try {
      await mcpClientManager?.shutdown?.();
    } catch {
      // Best-effort.
    }
    try {
      await daemon?.shutdown();
    } catch {
      // Best-effort.
    }
  }
}

async function resolveWorkspace(daemon: AgentDaemon, args: DirectRunArgs) {
  if (args.workspaceId) {
    const workspace = daemon.getWorkspaceById(args.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${args.workspaceId}`);
    return workspace;
  }

  const cwd = path.resolve(args.cwd);
  await fs.mkdir(cwd, { recursive: true });
  const existing = daemon.getWorkspaceByPath(cwd);
  if (existing) return existing;
  return daemon.createWorkspace(path.basename(cwd) || "Workspace", cwd);
}

async function waitForTerminalTask(
  daemon: AgentDaemon,
  taskId: string,
  args: DirectRunArgs,
): Promise<Task["status"]> {
  let lastStatus = "";
  while (true) {
    const task = await daemon.getTaskById(taskId);
    if (!task) throw new Error(`Task disappeared: ${taskId}`);
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      if (task.status !== "pending" && task.status !== "executing") {
        writeEvent(args, { type: "status", taskId, status: task.status }, `Status: ${task.status}`);
      }
    }
    if (isTerminalTaskStatus(task.status)) {
      if (task.resultSummary) {
        writeEvent(args, { type: "result_summary", taskId, message: task.resultSummary }, task.resultSummary);
      }
      if (task.error) writeError(args, task.error, taskId);
      return task.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function parseDirectRunArgs(argv: string[]): DirectRunArgs {
  const args: DirectRunArgs = { command: "run", prompt: "", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--doctor":
        args.command = "doctor";
        break;
      case "--version":
        args.command = "version";
        break;
      case "--status":
        args.command = "status";
        break;
      case "--providers-list":
        args.command = "providers-list";
        break;
      case "--providers-fallback-list":
        args.command = "providers-fallback-list";
        break;
      case "--providers-fallback-add":
        args.command = "providers-fallback-add";
        break;
      case "--providers-fallback-remove":
        args.command = "providers-fallback-remove";
        break;
      case "--workspace-list":
        args.command = "workspace-list";
        break;
      case "--workspace-create":
        args.command = "workspace-create";
        break;
      case "--tail":
        args.command = "tail";
        break;
      case "--approvals-list":
        args.command = "approvals-list";
        break;
      case "--providers-configure":
        args.command = "providers-configure";
        break;
      case "--sessions-list":
        args.command = "sessions-list";
        break;
      case "--sessions-show":
        args.command = "sessions-show";
        break;
      case "--sessions-export":
        args.command = "sessions-export";
        break;
      case "--sessions-rename":
        args.command = "sessions-rename";
        break;
      case "--sessions-archive":
        args.command = "sessions-archive";
        break;
      case "--sessions-delete":
        args.command = "sessions-delete";
        break;
      case "--sessions-prune":
        args.command = "sessions-prune";
        break;
      case "--tasks-list":
        args.command = "tasks-list";
        break;
      case "--tasks-cancel":
        args.command = "tasks-cancel";
        break;
      case "--tasks-attach":
        args.command = "tasks-attach";
        break;
      case "--tasks-stale":
        args.command = "tasks-stale";
        break;
      case "--tasks-cleanup":
        args.command = "tasks-cleanup";
        break;
      case "--logs-latest":
        args.command = "logs-latest";
        break;
      case "--logs-tail":
        args.command = "logs-tail";
        break;
      case "--logs-grep":
        args.command = "logs-grep";
        break;
      case "--tools-list":
        args.command = "tools-list";
        break;
      case "--tools-info":
        args.command = "tools-info";
        break;
      case "--tools-enable":
        args.command = "tools-enable";
        break;
      case "--tools-disable":
        args.command = "tools-disable";
        break;
      case "--mcp-list":
        args.command = "mcp-list";
        break;
      case "--mcp-add":
        args.command = "mcp-add";
        break;
      case "--mcp-remove":
        args.command = "mcp-remove";
        break;
      case "--mcp-enable":
        args.command = "mcp-enable";
        break;
      case "--mcp-disable":
        args.command = "mcp-disable";
        break;
      case "--mcp-test":
        args.command = "mcp-test";
        break;
      case "--skills-list":
        args.command = "skills-list";
        break;
      case "--skills-info":
        args.command = "skills-info";
        break;
      case "--skills-audit":
        args.command = "skills-audit";
        break;
      case "--models-list":
        args.command = "models-list";
        break;
      case "--backup-create":
        args.command = "backup-create";
        break;
      case "--backup-restore":
        args.command = "backup-restore";
        break;
      case "--security-audit":
        args.command = "security-audit";
        break;
      case "--security-rules-list":
        args.command = "security-rules-list";
        break;
      case "--security-rules-remove":
        args.command = "security-rules-remove";
        break;
      case "--prompt-size":
        args.command = "prompt-size";
        break;
      case "--prompt-preview":
        args.command = "prompt-preview";
        break;
      case "--dashboard-status":
        args.command = "dashboard-status";
        break;
      case "--task-id":
        args.taskId = next || "";
        i++;
        break;
      case "--session-id":
        args.sessionId = next || "";
        i++;
        break;
      case "--provider":
        args.providerType = next || "";
        i++;
        break;
      case "--name":
        args.name = next || "";
        args.workspaceName = args.workspaceName || args.name;
        i++;
        break;
      case "--transport":
        args.transport = next || "";
        i++;
        break;
      case "--command":
        args.commandLine = next || "";
        i++;
        break;
      case "--url":
        args.url = next || "";
        i++;
        break;
      case "--output":
        args.output = next || "";
        i++;
        break;
      case "--query":
        args.query = next || "";
        i++;
        break;
      case "--category":
        args.category = next || "";
        i++;
        break;
      case "--tool":
        args.tool = next || "";
        i++;
        break;
      case "--rule-id":
        args.ruleId = next || "";
        i++;
        break;
      case "--api-key":
        args.apiKey = next || "";
        i++;
        break;
      case "--model":
        args.model = next || "";
        i++;
        break;
      case "--base-url":
        args.baseUrl = next || "";
        i++;
        break;
      case "--limit":
        args.limit = sanitizeLimit(next);
        i++;
        break;
      case "--days":
        args.days = sanitizeDays(next);
        i++;
        break;
      case "--prompt":
        args.prompt = next || "";
        i++;
        break;
      case "--cwd":
        args.cwd = next || process.cwd();
        i++;
        break;
      case "--title":
        args.title = next || "";
        i++;
        break;
      case "--workspace-id":
        args.workspaceId = next || "";
        i++;
        break;
      case "--older-than":
        args.olderThan = next || "";
        i++;
        break;
      case "--newer-than":
        args.newerThan = next || "";
        i++;
        break;
      case "--after":
        args.after = next || "";
        i++;
        break;
      case "--before":
        args.before = next || "";
        i++;
        break;
      case "--source":
        args.source = next || "";
        i++;
        break;
      case "--cwd-filter":
        args.cwdFilter = next || "";
        i++;
        break;
      case "--end-reason":
        args.endReason = next || "";
        i++;
        break;
      case "--min-tokens":
        args.minTokens = sanitizeNonNegativeNumber(next);
        i++;
        break;
      case "--max-tokens":
        args.maxTokens = sanitizeNonNegativeNumber(next);
        i++;
        break;
      case "--min-cost":
        args.minCost = sanitizeNonNegativeNumber(next);
        i++;
        break;
      case "--max-cost":
        args.maxCost = sanitizeNonNegativeNumber(next);
        i++;
        break;
      case "--shell":
        args.shellAccess = true;
        break;
      case "--detach":
        args.detach = true;
        break;
      case "--detached-worker":
        args.detachedWorker = true;
        break;
      case "--ready-file":
        args.readyFile = next || "";
        i++;
        break;
      case "--active":
        args.activeOnly = true;
        break;
      case "--cli":
        args.cliOnly = true;
        break;
      case "--interrupted-cli":
        args.interruptedCli = true;
        break;
      case "--include-secrets":
        args.includeSecrets = true;
        break;
      case "--include-archived":
        args.includeArchived = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--vacuum":
        args.vacuum = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function runLocalMetadataCommand(
  dbManager: DatabaseManager,
  args: DirectRunArgs,
): Promise<number | null> {
  const db = dbManager.getDatabase();
  const tasks = new TaskRepository(db);
  const taskEvents = new TaskEventRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const approvals = new ApprovalRepository(db);
  const sessionMetadata = new TaskSessionMetadataRepository(db);
  const sessionRetention = new SessionRetentionService(
    tasks,
    taskEvents,
    sessionMetadata,
    workspaces,
  );

  if (String(args.command).startsWith("sessions-")) {
    await migrateLegacySessionMetadata(sessionMetadata);
  }

  switch (args.command) {
    case "doctor": {
      const providerStatus = LLMProviderFactory.getConfigStatus();
      const allWorkspaces = workspaces.findAll();
      const payload = {
        type: "doctor",
        ok: true,
        runtime: "local",
        profileData: "local",
        currentProvider: providerStatus.currentProvider,
        currentModel: providerStatus.currentModel,
        configuredProviders: providerStatus.providers.filter((provider) => provider.configured),
        workspaceCount: allWorkspaces.length,
        cwd: path.resolve(args.cwd),
      };
      writeEvent(args, payload, formatDoctor(payload));
      return 0;
    }
    case "version": {
      const pkg = await readPackageInfo();
      const payload = {
        type: "version",
        version: pkg.version,
        name: pkg.name,
        node: process.versions.node,
        electron: process.versions.electron || null,
        platform: process.platform,
        arch: process.arch,
        userData: getUserDataDir(),
      };
      writeEvent(
        args,
        payload,
        [
          `CoWork OS ${pkg.version}`,
          `Node ${process.versions.node}`,
          ...(process.versions.electron ? [`Electron ${process.versions.electron}`] : []),
          `${process.platform} ${process.arch}`,
        ].join("\n"),
      );
      return 0;
    }
    case "providers-list": {
      const providerStatus = LLMProviderFactory.getConfigStatus();
      const configured = providerStatus.providers.filter((provider) => provider.configured);
      writeEvent(
        args,
        {
          type: "providers",
          currentProvider: providerStatus.currentProvider,
          currentModel: providerStatus.currentModel,
          providers: providerStatus.providers,
        },
        [
          `Current: ${providerStatus.currentProvider} (${providerStatus.currentModel || "default model"})`,
          ...(configured.length
            ? configured.map((provider) => `- ${provider.name} (${provider.type}) configured`)
            : ["No local providers configured. Open Settings > LLM in the desktop app or import provider env settings."]),
        ].join("\n"),
      );
      return 0;
    }
    case "providers-configure": {
      if (!args.providerType) throw new Error("Usage: cowork providers configure <provider> [--api-key <key>] [--model <model>] [--base-url <url>]");
      const result = configureLocalProvider(args);
      writeEvent(
        args,
        { type: "provider_configured", providerType: result.providerType, model: result.model },
        `Configured local provider "${result.providerType}"${result.model ? ` (${result.model})` : ""}.`,
      );
      return 0;
    }
    case "workspace-list": {
      const allWorkspaces = workspaces.findAll();
      const visibleWorkspaces = allWorkspaces.filter((workspace) => !workspace.isTemp && !workspace.id.startsWith("__temp_workspace__"));
      writeEvent(
        args,
        { type: "workspaces", workspaces: visibleWorkspaces, totalCount: allWorkspaces.length, hiddenTemporaryCount: allWorkspaces.length - visibleWorkspaces.length },
        visibleWorkspaces.length
          ? [
              ...visibleWorkspaces.map((workspace) => `${workspace.name}  ${workspace.path}  (${workspace.id})`),
              ...(allWorkspaces.length > visibleWorkspaces.length
                ? [`Hidden temporary workspaces: ${allWorkspaces.length - visibleWorkspaces.length}`]
                : []),
            ].join("\n")
          : "No local workspaces configured.",
      );
      return 0;
    }
    case "workspace-create": {
      const workspacePath = path.resolve(args.cwd);
      await fs.mkdir(workspacePath, { recursive: true });
      const existing = workspaces.findByPath(workspacePath);
      const workspace =
        existing ||
        workspaces.create(args.workspaceName || path.basename(workspacePath) || "Workspace", workspacePath, {
          read: true,
          write: true,
          delete: false,
          network: true,
          shell: false,
        });
      writeEvent(
        args,
        { type: "workspace", workspace, created: !existing },
        `${existing ? "Workspace exists" : "Created workspace"}: ${workspace.name}  ${workspace.path}  (${workspace.id})`,
      );
      return 0;
    }
    case "tail": {
      if (!args.taskId) throw new Error("Usage: cowork tail <taskId> [--limit <n>]");
      const task = tasks.findById(args.taskId);
      if (!task) throw new Error(`Task not found: ${args.taskId}`);
      const events = taskEvents.findRecentByTaskId(args.taskId, args.limit || 200);
      writeEvent(
        args,
        { type: "task_events", task, events },
        events.length
          ? events.map(formatTaskEventLine).join("\n")
          : `No events found for task ${args.taskId}.`,
      );
      return 0;
    }
    case "approvals-list": {
      const rows = approvals.findPending(args.limit || 100);
      writeEvent(
        args,
        { type: "approvals", approvals: rows },
        rows.length
          ? rows.map((approval) => `${approval.id}  ${approval.type}  ${approval.description}  task=${approval.taskId}`).join("\n")
          : "No pending approvals.",
      );
      return 0;
    }
    case "status":
    case "dashboard-status": {
      const providerStatus = LLMProviderFactory.getConfigStatus();
      const mcpSettings = MCPSettingsManager.loadSettings();
      const toolSettings = BuiltinToolsSettingsManager.loadSettings();
      const taskCounts = countTasksByStatus(db);
      const workspaceCount = workspaces.findAll().length;
      const pendingApprovals = approvals.findPending(1000).length;
      const enabledToolCategories = Object.entries(toolSettings.categories)
        .filter(([, value]) => value.enabled)
        .map(([key]) => key);
      const payload = {
        type: args.command === "dashboard-status" ? "dashboard_status" : "status",
        runtime: "local",
        controlPlaneRequired: false,
        currentProvider: providerStatus.currentProvider,
        currentModel: providerStatus.currentModel,
        configuredProviders: providerStatus.providers.filter((provider) => provider.configured),
        workspaceCount,
        taskCounts,
        pendingApprovals,
        mcpServers: mcpSettings.servers.length,
        enabledToolCategories,
      };
      writeEvent(
        args,
        payload,
        [
          "CoWork OS local status",
          "- runtime: local direct runner",
          "- control plane: not required",
          `- provider: ${providerStatus.currentProvider} (${providerStatus.currentModel || "default model"})`,
          `- workspaces: ${workspaceCount}`,
          `- tasks: ${formatCountMap(taskCounts) || "none"}`,
          `- pending approvals: ${pendingApprovals}`,
          `- mcp servers: ${mcpSettings.servers.length}`,
          `- enabled tool categories: ${enabledToolCategories.join(", ") || "none"}`,
        ].join("\n"),
      );
      return 0;
    }
    case "sessions-list":
      return listSessions(sessionRetention, args);
    case "sessions-show":
      return showSession(sessionRetention, sessionMetadata, args);
    case "sessions-export":
      return await exportSession(sessionRetention, args);
    case "sessions-rename":
      return renameSession(sessionRetention, args);
    case "sessions-archive":
      return archiveSession(sessionRetention, args);
    case "sessions-delete":
      return archiveSession(sessionRetention, args);
    case "sessions-prune":
      return await pruneSessions(sessionRetention, taskEvents, args);
    case "tasks-list":
      return listCliTasks(tasks, args);
    case "tasks-cancel":
      return cancelCliTask(tasks, new TaskEventRepository(db), args);
    case "tasks-attach":
      return await attachCliTask(tasks, new TaskEventRepository(db), args);
    case "tasks-stale":
      return listStaleCliTasks(tasks, args);
    case "tasks-cleanup":
      return cleanupStaleCliTasks(tasks, new TaskEventRepository(db), args);
    case "logs-latest":
    case "logs-tail":
    case "logs-grep":
      return await logsCommand(args);
    case "tools-list":
    case "tools-info":
    case "tools-enable":
    case "tools-disable":
      return toolsCommand(args);
    case "mcp-list":
    case "mcp-add":
    case "mcp-remove":
    case "mcp-enable":
    case "mcp-disable":
      return mcpSettingsCommand(args);
    case "mcp-test":
      return await mcpTestCommand(args);
    case "skills-list":
    case "skills-info":
    case "skills-audit":
      return await skillsCommand(new SkillRepository(db), args);
    case "models-list":
      return modelsCommand(new LLMModelRepository(db), args);
    case "providers-fallback-list":
    case "providers-fallback-add":
    case "providers-fallback-remove":
      return providerFallbackCommand(args);
    case "backup-create":
      return await createBackup(dbManager, args);
    case "backup-restore":
      return await restoreBackup(args);
    case "security-audit":
      return securityAuditCommand(db, args);
    case "security-rules-list":
      return securityRulesListCommand(db, args);
    case "security-rules-remove":
      return securityRulesRemoveCommand(db, args);
    case "prompt-size":
    case "prompt-preview":
      return promptCommand(args);
    default:
      return null;
  }
}

function listSessions(sessionRetention: SessionRetentionService, args: DirectRunArgs): number {
  const limited = sessionRetention.listSessions({
    limit: args.limit || 50,
    includeArchived: args.includeArchived,
  });
  writeEvent(
    args,
    { type: "sessions", sessions: limited },
    limited.length
      ? limited
          .map(formatSessionSummaryLine)
          .join("\n")
      : "No local sessions found.",
  );
  return 0;
}

function showSession(
  sessionRetention: SessionRetentionService,
  sessionMetadata: TaskSessionMetadataRepository,
  args: DirectRunArgs,
): number {
  const sessionId = requireSessionId(args);
  const rows = sessionRetention.tasksForSession(sessionId, args.limit || 200);
  const metadata = sessionMetadata.findBySessionId(sessionId);
  if (rows.length === 0) throw new Error(`Session not found: ${sessionId}`);
  writeEvent(
    args,
    { type: "session", sessionId, metadata: metadata || null, tasks: rows },
    [
      `Session: ${sessionId}`,
      ...(metadata?.name ? [`Name: ${metadata.name}`] : []),
      ...(metadata?.archivedAt ? [`Archived: ${formatDate(metadata.archivedAt)}`] : []),
      ...rows.map((task) => `${formatDate(task.updatedAt || task.createdAt)}  ${task.status}  ${task.id}  ${task.title}`),
    ].join("\n"),
  );
  return 0;
}

async function exportSession(
  sessionRetention: SessionRetentionService,
  args: DirectRunArgs,
): Promise<number> {
  const sessionId = requireSessionId(args);
  const rows = sessionRetention.tasksForSession(sessionId, args.limit || 1000);
  if (rows.length === 0) throw new Error(`Session not found: ${sessionId}`);
  const payload = {
    type: "session_export",
    exportedAt: new Date().toISOString(),
    sessionId,
    tasks: rows,
  };
  if (args.output) {
    await fs.writeFile(path.resolve(args.output), JSON.stringify(payload, null, 2));
    writeEvent(args, payload, `Exported session ${sessionId} to ${path.resolve(args.output)}.`);
  } else {
    writeEvent(args, payload, JSON.stringify(payload, null, 2));
  }
  return 0;
}

function renameSession(sessionRetention: SessionRetentionService, args: DirectRunArgs): number {
  const sessionId = requireSessionId(args);
  const name = (args.name || args.title || "").trim();
  if (!name) throw new Error("Usage: cowork sessions rename <sessionId> <name>");
  sessionRetention.renameSession(sessionId, name);
  writeEvent(args, { type: "session_renamed", sessionId, name }, `Renamed session ${sessionId} to "${name}".`);
  return 0;
}

function archiveSession(sessionRetention: SessionRetentionService, args: DirectRunArgs): number {
  const sessionId = requireSessionId(args);
  const rows = sessionRetention.tasksForSession(sessionId, 10000);
  if (rows.length === 0) throw new Error(`Session not found: ${sessionId}`);
  if (args.command === "sessions-delete" && !args.yes) {
    writeEvent(
      args,
      { type: "session_archive_preview", sessionId, taskCount: rows.length, requiresYes: true },
      `Session ${sessionId} has ${rows.length} task(s). Re-run with --yes to archive it.`,
    );
    return 1;
  }
  const result = sessionRetention.archiveSession(sessionId);
  writeEvent(
    args,
    { type: "session_archived", sessionId, taskCount: result.taskCount, metadata: result.metadata },
    `Archived session ${sessionId}. No task data was deleted.`,
  );
  return 0;
}

function buildSessionRetentionFilters(args: DirectRunArgs): SessionRetentionFilters {
  const hasExplicitWindowOrSelection = Boolean(
    args.all ||
      args.olderThan ||
      args.newerThan ||
      args.after ||
      args.before ||
      args.title ||
      args.source ||
      args.cwdFilter ||
      args.providerType ||
      args.model ||
      args.endReason ||
      typeof args.minTokens === "number" ||
      typeof args.maxTokens === "number" ||
      typeof args.minCost === "number" ||
      typeof args.maxCost === "number",
  );
  const olderThanMs =
    args.all
      ? undefined
      : parseDurationMs(args.olderThan) ??
        (hasExplicitWindowOrSelection
          ? undefined
          : (args.days || 30) * 24 * 60 * 60 * 1000);

  return {
    limit: args.limit || 10000,
    includeArchived: args.includeArchived,
    all: args.all,
    olderThanMs,
    newerThanMs: parseDurationMs(args.newerThan),
    afterMs: parseTimestampMs(args.after),
    beforeMs: parseTimestampMs(args.before),
    title: args.title,
    source: args.source,
    cwd: args.cwdFilter,
    provider: args.providerType,
    model: args.model,
    endReason: args.endReason,
    minTokens: args.minTokens,
    maxTokens: args.maxTokens,
    minCost: args.minCost,
    maxCost: args.maxCost,
  };
}

function formatSessionSummaryLine(session: TaskSessionSummary): string {
  const archived = session.archivedAt ? "  archived" : "";
  const pinned = session.pinned ? "  pinned" : "";
  const tokenPart = session.totalTokens > 0 ? `  tokens=${session.totalTokens}` : "";
  const costPart = session.totalCost > 0 ? `  cost=${session.totalCost.toFixed(4)}` : "";
  return `${session.id}  ${session.title || "Untitled"}  tasks=${session.count}  latest=${session.latestStatus}  updated=${formatDate(session.updatedAt)}${tokenPart}${costPart}${pinned}${archived}`;
}

async function pruneSessions(
  sessionRetention: SessionRetentionService,
  taskEvents: TaskEventRepository,
  args: DirectRunArgs,
): Promise<number> {
  const filters = buildSessionRetentionFilters(args);
  const preview = await sessionRetention.pruneSessions(filters, { dryRun: !args.yes || args.dryRun });
  if (!args.yes || args.dryRun) {
    writeEvent(
      args,
      { type: "sessions_prune_preview", ...preview, requiresYes: !args.yes },
      preview.sessions.length
        ? [
            `Would delete ${preview.sessionCount} terminal session(s) (${preview.taskCount} task(s)).`,
            ...preview.sessions.slice(0, 20).map(formatSessionSummaryLine),
            ...(preview.sessions.length > 20 ? [`...and ${preview.sessions.length - 20} more.`] : []),
            ...(args.yes ? [] : ["Re-run with --yes to delete the listed sessions."]),
          ].join("\n")
        : "No matching terminal sessions found.",
    );
    return preview.sessions.length && !args.yes ? 1 : 0;
  }
  const result = await sessionRetention.pruneSessions(filters, { dryRun: false });
  const vacuumed = args.vacuum ? taskEvents.vacuumIfNeeded(0) : false;
  writeEvent(
    args,
    { type: "sessions_pruned", ...result, vacuumed },
    `Deleted ${result.sessionCount} session(s) and ${result.taskCount} task(s).${vacuumed ? " Vacuum completed." : ""}`,
  );
  return 0;
}

function listCliTasks(taskRepo: TaskRepository, args: DirectRunArgs): number {
  const rows = taskRepo.findAll(args.limit || 1000)
    .filter((task) => !args.activeOnly || !isTerminalTaskStatus(task.status))
    .filter((task) => !args.cliOnly || Boolean(getCliOwnership(task)))
    .slice(0, args.limit || 50);
  writeEvent(
    args,
    { type: "tasks", tasks: rows },
    rows.length
      ? rows.map(formatCliTaskLine).join("\n")
      : "No matching local tasks found.",
  );
  return 0;
}

function cancelCliTask(
  taskRepo: TaskRepository,
  eventRepo: TaskEventRepository,
  args: DirectRunArgs,
): number {
  const taskId = (args.taskId || args.name || args.prompt || "").trim();
  if (!taskId) throw new Error("Usage: cowork tasks cancel <taskId>");
  const task = taskRepo.findById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (isTerminalTaskStatus(task.status)) {
    writeEvent(args, { type: "task_cancel_noop", task }, `Task ${task.id} is already ${task.status}.`);
    return 0;
  }
  if (!getCliOwnership(task)) {
    throw new Error(
      "Local task cancellation is limited to CLI-owned tasks. Use `cowork tasks cancel <taskId> --remote` to cancel a task owned by the desktop app.",
    );
  }
  terminateCliOwner(task);
  markTaskCancelled(taskRepo, eventRepo, task, "Task was stopped by CLI command", 130);
  writeEvent(args, { type: "task_cancelled", taskId: task.id }, `Cancelled task ${task.id}.`);
  return 0;
}

async function attachCliTask(
  taskRepo: TaskRepository,
  eventRepo: TaskEventRepository,
  args: DirectRunArgs,
): Promise<number> {
  const taskId = (args.taskId || args.name || args.prompt || "").trim();
  if (!taskId) throw new Error("Usage: cowork tasks attach <taskId>");
  const task = taskRepo.findById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const seen = new Set<string>();
  const printNewEvents = () => {
    const events = eventRepo.findRecentByTaskId(taskId, args.limit || 200);
    for (const event of events) {
      const key = event.id || `${event.timestamp}:${event.type}:${JSON.stringify(event.payload || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      writeEvent(args, { type: "task_event", taskId, event }, formatTaskEventLine(event));
    }
  };
  printNewEvents();
  if (isTerminalTaskStatus(task.status)) return task.status === "failed" || task.status === "cancelled" ? 1 : 0;

  return await new Promise((resolve) => {
    const interval = setInterval(() => {
      printNewEvents();
      const latest = taskRepo.findById(taskId);
      if (!latest || isTerminalTaskStatus(latest.status)) {
        clearInterval(interval);
        resolve(!latest || latest.status === "failed" || latest.status === "cancelled" ? 1 : 0);
      }
    }, 1000);
    const onSignal = () => {
      clearInterval(interval);
      resolve(130);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function listStaleCliTasks(taskRepo: TaskRepository, args: DirectRunArgs): number {
  const rows = findStaleCliTasks(taskRepo, args.limit || 1000);
  writeEvent(
    args,
    { type: "stale_cli_tasks", tasks: rows },
    rows.length
      ? rows.map(formatCliTaskLine).join("\n")
      : "No stale attached CLI tasks found.",
  );
  return rows.length ? 1 : 0;
}

function cleanupStaleCliTasks(
  taskRepo: TaskRepository,
  eventRepo: TaskEventRepository,
  args: DirectRunArgs,
): number {
  if (!args.interruptedCli) {
    throw new Error("Usage: cowork tasks cleanup --interrupted-cli --yes");
  }
  const rows = findStaleCliTasks(taskRepo, args.limit || 1000);
  if (!args.yes) {
    writeEvent(
      args,
      { type: "stale_cli_tasks_cleanup_preview", tasks: rows, requiresYes: true },
      rows.length
        ? `Would cancel ${rows.length} stale attached CLI task(s). Re-run with --yes.`
        : "No stale attached CLI tasks found.",
    );
    return rows.length ? 1 : 0;
  }
  for (const task of rows) {
    markTaskCancelled(taskRepo, eventRepo, task, "CLI task owner exited before completion", 130);
  }
  writeEvent(
    args,
    { type: "stale_cli_tasks_cleaned", taskIds: rows.map((task) => task.id) },
    rows.length
      ? `Cancelled ${rows.length} stale attached CLI task(s).`
      : "No stale attached CLI tasks found.",
  );
  return 0;
}

async function logsCommand(args: DirectRunArgs): Promise<number> {
  const root = await findPackageRoot();
  const latest = path.join(root, "logs", "dev-latest.log");
  let text = "";
  try {
    text = await fs.readFile(latest, "utf8");
  } catch {
    writeEvent(args, { type: "logs", path: latest, exists: false }, `No development log found at ${latest}.`);
    return 1;
  }
  const limit = args.limit || 80;
  let lines = text.split(/\r?\n/).filter(Boolean);
  if (args.command === "logs-grep") {
    const query = (args.query || args.prompt || "").trim();
    if (!query) throw new Error("Usage: cowork logs grep <query>");
    lines = lines.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
  }
  const tail = lines.slice(-limit);
  writeEvent(args, { type: "logs", path: latest, lines: tail }, tail.length ? tail.join("\n") : "No matching log lines.");
  return 0;
}

function toolsCommand(args: DirectRunArgs): number {
  const settings = BuiltinToolsSettingsManager.loadSettings();
  if (args.command === "tools-list") {
    const categories = Object.entries(settings.categories).map(([name, config]) => ({
      name,
      enabled: config.enabled,
      priority: config.priority,
      tools: BuiltinToolsSettingsManager.getToolsByCategory()[name] || [],
    }));
    writeEvent(
      args,
      { type: "tools", categories, overrides: settings.toolOverrides },
      categories
        .map((category) => `${category.name}  ${category.enabled ? "enabled" : "disabled"}  ${category.priority}  tools=${category.tools.length}`)
        .join("\n"),
    );
    return 0;
  }
  const target = args.category || args.tool || args.name || args.prompt;
  if (!target) throw new Error("Usage: cowork tools info|enable|disable <category-or-tool>");
  const categories = settings.categories as Any;
  const isCategory = Boolean(categories[target]);
  if (args.command === "tools-info") {
    const payload = isCategory
      ? { type: "tool_category", name: target, ...categories[target], tools: BuiltinToolsSettingsManager.getToolsByCategory()[target] || [] }
      : {
          type: "tool",
          name: target,
          enabled: BuiltinToolsSettingsManager.isToolEnabled(target),
          category: BuiltinToolsSettingsManager.getToolCategory(target),
          priority: BuiltinToolsSettingsManager.getToolPriority(target),
          autoApprove: BuiltinToolsSettingsManager.getToolAutoApprove(target),
          timeoutMs: BuiltinToolsSettingsManager.getToolTimeoutMs(target),
        };
    writeEvent(args, payload, JSON.stringify(payload, null, 2));
    return 0;
  }
  const enabled = args.command === "tools-enable";
  if (isCategory) {
    BuiltinToolsSettingsManager.setCategoryEnabled(target as keyof typeof settings.categories, enabled);
  } else {
    BuiltinToolsSettingsManager.setToolOverride(target, { enabled, priority: BuiltinToolsSettingsManager.getToolPriority(target) });
  }
  writeEvent(args, { type: "tool_updated", target, enabled }, `${enabled ? "Enabled" : "Disabled"} ${isCategory ? "category" : "tool"} ${target}.`);
  return 0;
}

function mcpSettingsCommand(args: DirectRunArgs): number {
  MCPSettingsManager.initialize();
  if (args.command === "mcp-list") {
    const settings = MCPSettingsManager.getSettingsForDisplay();
    writeEvent(
      args,
      { type: "mcp_servers", servers: settings.servers },
      settings.servers.length
        ? settings.servers
            .map((server) => `${server.id}  ${server.name}  ${server.enabled ? "enabled" : "disabled"}  ${server.transport}  ${server.command || server.url || ""}`)
            .join("\n")
        : "No MCP servers configured.",
    );
    return 0;
  }
  if (args.command === "mcp-add") {
    const name = (args.name || "").trim();
    if (!name) throw new Error("Usage: cowork mcp add --name <name> (--command <cmd> | --url <url>)");
    const transport = normalizeMcpTransport(args.transport || (args.url ? "streamable-http" : "stdio"));
    const commandParts = args.commandLine ? splitCommandLine(args.commandLine) : [];
    if (transport === "stdio" && commandParts.length === 0) throw new Error("stdio MCP servers require --command.");
    if (transport !== "stdio" && !args.url) throw new Error(`${transport} MCP servers require --url.`);
    const server = MCPSettingsManager.addServer({
      name,
      enabled: true,
      transport,
      ...(transport === "stdio"
        ? { command: commandParts[0], args: commandParts.slice(1), cwd: path.resolve(args.cwd) }
        : { url: args.url }),
    });
    writeEvent(args, { type: "mcp_server_added", server }, `Added MCP server ${server.name} (${server.id}).`);
    return 0;
  }
  const id = args.name || args.prompt || "";
  if (!id) throw new Error("Usage: cowork mcp remove|enable|disable <serverId>");
  if (args.command === "mcp-remove") {
    const removed = MCPSettingsManager.removeServer(id);
    writeEvent(args, { type: "mcp_server_removed", id, removed }, removed ? `Removed MCP server ${id}.` : `MCP server not found: ${id}.`);
    return removed ? 0 : 1;
  }
  const enabled = args.command === "mcp-enable";
  const server = MCPSettingsManager.toggleServer(id, enabled);
  writeEvent(args, { type: "mcp_server_updated", id, enabled, server }, server ? `${enabled ? "Enabled" : "Disabled"} MCP server ${id}.` : `MCP server not found: ${id}.`);
  return server ? 0 : 1;
}

async function mcpTestCommand(args: DirectRunArgs): Promise<number> {
  MCPSettingsManager.initialize();
  const manager = MCPClientManager.getInstance();
  const target = args.name || args.prompt || "";
  if (target) {
    const result = await manager.testServer(target);
    writeEvent(args, { type: "mcp_test", id: target, ...result }, result.success ? `MCP server ${target} connected. tools=${result.tools || 0}` : `MCP server ${target} failed: ${result.error}`);
    return result.success ? 0 : 1;
  }
  const statuses = manager.getStatus();
  writeEvent(
    args,
    { type: "mcp_status", statuses },
    statuses.length
      ? statuses.map((status) => `${status.id}  ${status.name}  ${status.status}  tools=${status.tools.length}${status.error ? `  error=${status.error}` : ""}`).join("\n")
      : "No MCP servers configured.",
  );
  return statuses.some((status) => status.status === "error") ? 1 : 0;
}

async function skillsCommand(skillRepo: SkillRepository, args: DirectRunArgs): Promise<number> {
  const dbSkills = skillRepo.findAll();
  const status = await readOnlySkillStatus(args);
  const skills = status.skills;
  if (args.command === "skills-list") {
    const limited = skills.slice(0, args.limit || 200);
    writeEvent(
      args,
      { type: "skills", skills: limited, summary: status.summary, databaseSkills: dbSkills },
      limited.length ? limited.map((skill) => `${skill.id}  ${skill.name}  ${skill.source}  ${skill.category || "uncategorized"}`).join("\n") : "No local skills registered.",
    );
    return 0;
  }
  if (args.command === "skills-info") {
    const query = (args.name || args.prompt || "").toLowerCase();
    if (!query) throw new Error("Usage: cowork skills info <skillId-or-name>");
    const skill = skills.find((candidate) => candidate.id === query || candidate.name.toLowerCase() === query || candidate.name.toLowerCase().includes(query));
    if (!skill) throw new Error(`Skill not found: ${query}`);
    writeEvent(args, { type: "skill", skill }, JSON.stringify(skill, null, 2));
    return 0;
  }
  const invalid = skills.filter((skill) => !skill.id || !skill.name || (!skill.prompt && !skill.filePath));
  writeEvent(
    args,
    { type: "skills_audit", summary: status.summary, invalid, databaseSkills: dbSkills },
    invalid.length
      ? `Skill audit found ${invalid.length} issue(s).`
      : `Skill audit passed. ${skills.length} skill(s) registered.`,
  );
  return invalid.length ? 1 : 0;
}

function modelsCommand(modelRepo: LLMModelRepository, args: DirectRunArgs): number {
  const status = LLMProviderFactory.getConfigStatus();
  const configuredModels = status.models;
  const dbModels = modelRepo.findAll();
  writeEvent(
    args,
    { type: "models", currentProvider: status.currentProvider, currentModel: status.currentModel, models: configuredModels, databaseModels: dbModels },
    [
      `Current provider: ${status.currentProvider}`,
      `Current model: ${status.currentModel || "default"}`,
      ...configuredModels.slice(0, args.limit || 100).map((model) => `${model.key}  ${model.displayName || model.key}`),
      ...(dbModels.length ? [`Database model presets: ${dbModels.length}`] : []),
    ].join("\n"),
  );
  return 0;
}

function providerFallbackCommand(args: DirectRunArgs): number {
  const settings = LLMProviderFactory.loadSettings() as Any;
  const fallbacks = Array.isArray(settings.fallbackProviders) ? settings.fallbackProviders : [];
  if (args.command === "providers-fallback-list") {
    writeEvent(
      args,
      { type: "provider_fallbacks", fallbackProviders: fallbacks },
      fallbacks.length
        ? fallbacks.map((fallback: Any, index: number) => `${index + 1}. ${fallback.providerType}${fallback.modelKey ? ` (${fallback.modelKey})` : ""}`).join("\n")
        : "No global provider fallbacks configured.",
    );
    return 0;
  }
  if (args.command === "providers-fallback-add") {
    if (!args.providerType) throw new Error("Usage: cowork providers fallback add <provider> [--model <model>]");
    const next = [...fallbacks, { providerType: normalizeProviderType(args.providerType), ...(args.model ? { modelKey: args.model } : {}) }];
    settings.fallbackProviders = next;
    LLMProviderFactory.saveSettings(settings as ReturnType<typeof LLMProviderFactory.loadSettings>);
    writeEvent(args, { type: "provider_fallback_added", fallbackProviders: next }, `Added fallback provider ${args.providerType}.`);
    return 0;
  }
  const provider = normalizeProviderType(args.providerType || args.name || args.prompt || "");
  if (!provider) throw new Error("Usage: cowork providers fallback remove <provider>");
  const next = fallbacks.filter((fallback: Any) => fallback.providerType !== provider);
  settings.fallbackProviders = next;
  LLMProviderFactory.saveSettings(settings as ReturnType<typeof LLMProviderFactory.loadSettings>);
  writeEvent(args, { type: "provider_fallback_removed", provider, fallbackProviders: next }, `Removed fallback provider ${provider}.`);
  return fallbacks.length === next.length ? 1 : 0;
}

async function createBackup(dbManager: DatabaseManager, args: DirectRunArgs): Promise<number> {
  if (args.includeSecrets && !args.yes) {
    throw new Error("Refusing to export secrets without --yes. Re-run with --include-secrets --yes if you really need them.");
  }
  const db = dbManager.getDatabase();
  const payload = {
    type: "cowork_backup",
    version: (await readPackageInfo()).version,
    exportedAt: new Date().toISOString(),
    includeSecrets: Boolean(args.includeSecrets),
    contentMode: args.includeSecrets ? "full_sensitive" : "redacted_metadata",
    userData: getUserDataDir(),
    workspaces: new WorkspaceRepository(db).findAll(),
    tasks: sanitizeTasksForBackup(new TaskRepository(db).findAll(args.limit || 500), Boolean(args.includeSecrets)),
    approvals: sanitizeApprovalsForBackup(new ApprovalRepository(db).findPending(1000), Boolean(args.includeSecrets)),
    providers: redactObject(LLMProviderFactory.loadSettings(), !args.includeSecrets),
    tools: BuiltinToolsSettingsManager.loadSettings(),
    mcp: sanitizeMcpForBackup(args.includeSecrets ? MCPSettingsManager.loadSettings() : MCPSettingsManager.getSettingsForDisplay(), Boolean(args.includeSecrets)),
    skills: new SkillRepository(db).findAll(),
  };
  const output = args.output || path.resolve(process.cwd(), `cowork-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(path.resolve(output), JSON.stringify(payload, null, 2));
  writeEvent(args, { type: "backup_created", output: path.resolve(output) }, `Created backup: ${path.resolve(output)}`);
  return 0;
}

async function restoreBackup(args: DirectRunArgs): Promise<number> {
  const input = args.output || args.prompt;
  if (!input) throw new Error("Usage: cowork backup restore <backup.json> [--dry-run] [--yes]");
  const parsed = JSON.parse(await fs.readFile(path.resolve(input), "utf8")) as Any;
  if (parsed.type !== "cowork_backup") throw new Error("Not a CoWork backup file.");
  const summary = {
    workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.length : 0,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
    skills: Array.isArray(parsed.skills) ? parsed.skills.length : 0,
    hasProviders: Boolean(parsed.providers),
    hasTools: Boolean(parsed.tools),
    hasMcp: Boolean(parsed.mcp),
  };
  if (args.dryRun || !args.yes) {
    writeEvent(args, { type: "backup_restore_preview", input: path.resolve(input), summary, requiresYes: true }, `Backup is valid. Restore preview: ${JSON.stringify(summary)}. Re-run with --yes to restore settings.`);
    return args.dryRun ? 0 : 1;
  }
  if (parsed.providers) LLMProviderFactory.saveSettings(LLMSettingsSchema.parse(parsed.providers) as ReturnType<typeof LLMProviderFactory.loadSettings>);
  if (parsed.tools) BuiltinToolsSettingsManager.saveSettings(validateBuiltinToolsSettings(parsed.tools));
  if (parsed.mcp) MCPSettingsManager.saveSettings(disableRestoredMcpServers(MCPSettingsSchema.parse(parsed.mcp)) as ReturnType<typeof MCPSettingsManager.loadSettings>);
  writeEvent(args, { type: "backup_restored", input: path.resolve(input), summary }, "Restored provider, tool, and MCP settings from backup.");
  return 0;
}

function securityAuditCommand(db: Database.Database, args: DirectRunArgs): number {
  const providerStatus = LLMProviderFactory.getConfigStatus();
  const tools = BuiltinToolsSettingsManager.loadSettings();
  const workspaces = new WorkspaceRepository(db).findAll();
  const permissionRepo = new WorkspacePermissionRuleRepository(db);
  const rules = workspaces.flatMap((workspace) => permissionRepo.listByWorkspaceId(workspace.id));
  const warnings: string[] = [];
  if (providerStatus.providers.filter((provider) => provider.configured).length === 0) warnings.push("No configured LLM provider.");
  if (tools.categories.shell?.enabled && tools.runCommandApprovalMode === "single_bundle") warnings.push("Shell tools are enabled with bundled approval mode.");
  if (tools.categories.computer_use?.enabled) warnings.push("Computer-use tools are enabled.");
  if (Object.keys(tools.toolAutoApprove || {}).length > 0) warnings.push("Some tools have auto-approval overrides.");
  const allowRules = rules.filter((rule) => rule.effect === "allow");
  if (allowRules.length > 0) warnings.push(`${allowRules.length} workspace allow rule(s) configured.`);
  const payload = { type: "security_audit", ok: warnings.length === 0, warnings, providerStatus, permissionRules: rules.length };
  writeEvent(
    args,
    payload,
    warnings.length ? ["Security audit warnings:", ...warnings.map((warning) => `- ${warning}`)].join("\n") : "Security audit passed with no local warnings.",
  );
  return warnings.length ? 1 : 0;
}

function securityRulesListCommand(db: Database.Database, args: DirectRunArgs): number {
  const repo = new WorkspacePermissionRuleRepository(db);
  const workspaces = new WorkspaceRepository(db).findAll();
  const workspaceRows = args.workspaceId
    ? workspaces.filter((workspace) => workspace.id === args.workspaceId)
    : workspaces;
  const rules = workspaceRows.flatMap((workspace) =>
    repo.listByWorkspaceId(workspace.id).map((rule) => ({ ...rule, workspaceName: workspace.name, workspacePath: workspace.path })),
  );
  writeEvent(
    args,
    { type: "security_rules", rules },
    rules.length
      ? rules.map((rule) => `${rule.id}  ${rule.effect}  ${rule.scope.kind}  ${rule.workspaceName}`).join("\n")
      : "No workspace permission rules found.",
  );
  return 0;
}

function securityRulesRemoveCommand(db: Database.Database, args: DirectRunArgs): number {
  const id = args.ruleId || args.name || args.prompt || "";
  if (!id) throw new Error("Usage: cowork security rules remove <ruleId> --yes");
  if (!args.yes) {
    writeEvent(args, { type: "security_rule_remove_preview", id, requiresYes: true }, `Re-run with --yes to remove permission rule ${id}.`);
    return 1;
  }
  const repo = new WorkspacePermissionRuleRepository(db);
  const removed = repo.deleteById(id);
  writeEvent(args, { type: "security_rule_removed", id, removed }, removed ? `Removed permission rule ${id}.` : `Permission rule not found: ${id}.`);
  return removed ? 0 : 1;
}

function promptCommand(args: DirectRunArgs): number {
  const text = args.prompt || "";
  if (!text) throw new Error(`Usage: cowork ${args.command === "prompt-size" ? "prompt-size" : "prompt-preview"} <prompt text>`);
  const chars = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const estimatedTokens = Math.max(1, Math.ceil(chars / 4));
  const payload = { type: args.command, chars, words, estimatedTokens, preview: truncate(text, 500) };
  writeEvent(
    args,
    payload,
    args.command === "prompt-preview"
      ? [`Chars: ${chars}`, `Estimated tokens: ${estimatedTokens}`, "", truncate(text, 1200)].join("\n")
      : `Chars: ${chars}\nWords: ${words}\nEstimated tokens: ${estimatedTokens}`,
  );
  return 0;
}

function configureLocalProvider(args: DirectRunArgs): { providerType: string; model?: string } {
  const rawProviderType = (args.providerType || "").trim();
  const providerType = normalizeProviderType(rawProviderType);
  if (!providerType) throw new Error("Provider is required.");

  const settings = LLMProviderFactory.loadSettings() as Any;
  const apiKey = args.apiKey?.trim();
  const model = args.model?.trim();
  const baseUrl = args.baseUrl?.trim();
  const status = LLMProviderFactory.getConfigStatus();
  const providerIsConfigured = status.providers.some(
    (provider) => provider.type === providerType && provider.configured,
  );
  const switchingProvider = settings.providerType !== providerType;
  if (switchingProvider && !providerIsConfigured && !apiKey && !baseUrl) {
    throw new Error(
      `Provider "${providerType}" is not configured. Pass --api-key/--base-url, configure it in the desktop app, or configure the active provider instead.`,
    );
  }

  settings.providerType = providerType;
  if (model) settings.modelKey = model;

  const ensureNode = (key: string): Any => {
    const existing = settings[key];
    if (existing && typeof existing === "object") return existing;
    settings[key] = {};
    return settings[key];
  };

  switch (providerType) {
    case "anthropic": {
      const node = ensureNode("anthropic");
      if (apiKey) {
        node.apiKey = apiKey;
        node.authMethod = "api_key";
      }
      break;
    }
    case "openai": {
      const node = ensureNode("openai");
      if (apiKey) {
        node.apiKey = apiKey;
        node.authMethod = "api_key";
      }
      if (model) node.model = model;
      break;
    }
    case "gemini":
    case "openrouter":
    case "deepseek":
    case "groq":
    case "xai":
    case "kimi":
    case "ollama": {
      const node = ensureNode(providerType);
      if (apiKey) node.apiKey = apiKey;
      if (model) node.model = model;
      if (baseUrl) node.baseUrl = baseUrl;
      break;
    }
    case "openai-compatible": {
      const node = ensureNode("openaiCompatible");
      if (apiKey) node.apiKey = apiKey;
      if (model) node.model = model;
      if (baseUrl) node.baseUrl = baseUrl;
      break;
    }
    case "azure": {
      const node = ensureNode("azure");
      if (apiKey) node.apiKey = apiKey;
      if (model) node.deployment = model;
      if (baseUrl) node.endpoint = baseUrl;
      break;
    }
    case "azure-anthropic": {
      const node = ensureNode("azureAnthropic");
      if (apiKey) node.apiKey = apiKey;
      if (model) node.deployment = model;
      if (baseUrl) node.endpoint = baseUrl;
      break;
    }
    case "bedrock": {
      const node = ensureNode("bedrock");
      if (apiKey) node.accessKeyId = apiKey;
      if (model) node.model = model;
      break;
    }
    default: {
      const customProviders = settings.customProviders && typeof settings.customProviders === "object"
        ? settings.customProviders
        : {};
      settings.customProviders = customProviders;
      const node = customProviders[providerType] && typeof customProviders[providerType] === "object"
        ? customProviders[providerType]
        : {};
      customProviders[providerType] = node;
      if (apiKey) node.apiKey = apiKey;
      if (model) node.model = model;
      if (baseUrl) node.baseUrl = baseUrl;
      break;
    }
  }

  LLMProviderFactory.saveSettings(settings as ReturnType<typeof LLMProviderFactory.loadSettings>);
  return { providerType, model };
}

function normalizeProviderType(providerType: string): string {
  switch (providerType) {
    case "claude":
      return "anthropic";
    case "azure_anthropic":
      return "azure-anthropic";
    case "openai_compatible":
      return "openai-compatible";
    default:
      return providerType;
  }
}

function shouldImportEnvForCommand(command: DirectRunArgs["command"]): boolean {
  return command === "run" || command === "providers-configure";
}

function getCliOwnership(task: Task | undefined | null): CliTaskOwnership | undefined {
  const cli = task?.agentConfig?.cli;
  if (!cli || cli.owner !== "cowork-run" || typeof cli.runId !== "string") return undefined;
  return cli;
}

function findStaleCliTasks(taskRepo: TaskRepository, limit: number): Task[] {
  const now = Date.now();
  return taskRepo.findAll(limit)
    .filter((task) => {
      if (isTerminalTaskStatus(task.status)) return false;
      const cli = getCliOwnership(task);
      if (!cli || cli.mode !== "attached") return false;
      if (cli.endedAt) return false;
      if (isPidAlive(cli.pid)) return false;
      const lastSeenAt = cli.lastSeenAt || cli.startedAt || task.updatedAt || task.createdAt;
      return now - lastSeenAt > 30_000;
    });
}

function markTaskCancelled(
  taskRepo: TaskRepository,
  eventRepo: TaskEventRepository,
  task: Task,
  message: string,
  exitCode: number,
): void {
  const completedAt = Date.now();
  const cli = getCliOwnership(task);
  taskRepo.update(task.id, {
    status: "cancelled",
    completedAt,
    lastRunDurationMs: Math.max(0, completedAt - (task.createdAt || completedAt)),
    error: null,
    terminalStatus: undefined,
    failureClass: undefined,
    ...(cli
      ? {
          agentConfig: {
            ...(task.agentConfig || {}),
            cli: {
              ...cli,
              endedAt: completedAt,
              exitCode,
            },
          },
        }
      : {}),
  });
  eventRepo.create({
    taskId: task.id,
    timestamp: completedAt,
    type: "task_status",
    legacyType: "task_status",
    schemaVersion: 2,
    status: "cancelled",
    payload: { status: "cancelled", message },
  });
  eventRepo.create({
    taskId: task.id,
    timestamp: completedAt,
    type: "task_cancelled",
    legacyType: "task_cancelled",
    schemaVersion: 2,
    status: "cancelled",
    payload: { message },
  });
}

function terminateCliOwner(task: Task): void {
  const cli = getCliOwnership(task);
  if (!cli || cli.pid === process.pid || cli.endedAt) return;
  if (!isPidAlive(cli.pid)) return;
  try {
    process.kill(cli.pid, "SIGTERM");
  } catch {
    // Best-effort; the database cancellation still prevents stale UI state.
  }
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

function formatCliTaskLine(task: Task): string {
  const cli = getCliOwnership(task);
  const mode = cli ? `cli:${cli.mode}` : "app";
  const updatedAt = formatDate(task.updatedAt || task.createdAt);
  return `${task.id}  ${task.status}  ${mode}  updated=${updatedAt}  ${task.title}`;
}

function requireSessionId(args: DirectRunArgs): string {
  const sessionId = (args.sessionId || args.name || args.prompt || "").trim();
  if (!sessionId) throw new Error("Missing session id.");
  return sessionId;
}

type SessionMetadata = Record<string, { name?: string; updatedAt?: number; archivedAt?: number }>;

async function migrateLegacySessionMetadata(
  metadataRepo: TaskSessionMetadataRepository,
): Promise<void> {
  const metadata = await readSessionMetadata();
  const entries = Object.entries(metadata);
  if (entries.length === 0) return;

  let imported = 0;
  for (const [sessionId, value] of entries) {
    if (!sessionId || metadataRepo.findBySessionId(sessionId)) continue;
    metadataRepo.upsert(sessionId, {
      name: value?.name,
      archivedAt: value?.archivedAt,
    });
    imported += 1;
  }

  if (imported === 0) return;
  try {
    const file = sessionMetadataPath();
    await fs.rename(file, `${file}.migrated`);
  } catch {
    // Leaving the legacy file in place is harmless; existing database rows win.
  }
}

async function readSessionMetadata(): Promise<SessionMetadata> {
  try {
    const text = await fs.readFile(sessionMetadataPath(), "utf8");
    const parsed = JSON.parse(text) as SessionMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sessionMetadataPath(): string {
  return path.join(getUserDataDir(), "cli-session-metadata.json");
}

function countTasksByStatus(db: Database.Database): Record<string, number> {
  try {
    const rows = db.prepare("SELECT status, COUNT(1) as count FROM tasks GROUP BY status").all() as Any[];
    return Object.fromEntries(rows.map((row) => [String(row.status || "unknown"), Number(row.count || 0)]));
  } catch {
    return {};
  }
}

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatDate(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  return new Date(timestamp).toISOString();
}

async function writeDetachedReadyFile(file: string, task: Task): Promise<void> {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(
    resolved,
    JSON.stringify(
      {
        taskId: task.id,
        title: task.title,
        status: task.status,
        workspaceId: task.workspaceId,
      },
      null,
      2,
    ),
  );
}

async function readPackageInfo(): Promise<{ name: string; version: string }> {
  const root = await findPackageRoot();
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { name?: string; version?: string };
    return { name: pkg.name || "cowork-os", version: pkg.version || "dev" };
  } catch {
    return { name: "cowork-os", version: "dev" };
  }
}

async function findPackageRoot(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "..", "..", ".."),
    path.resolve(__dirname, "..", ".."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(path.join(candidate, "package.json"), "utf8");
      const pkg = JSON.parse(text) as { name?: string };
      if (pkg.name === "cowork-os" || pkg.name === "@cowork/os") return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return process.cwd();
}

function normalizeMcpTransport(value: string): "stdio" | "sse" | "websocket" | "streamable-http" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "stdio" || normalized === "sse" || normalized === "websocket" || normalized === "streamable-http") {
    return normalized;
  }
  if (normalized === "http") return "streamable-http";
  throw new Error(`Unsupported MCP transport: ${value}`);
}

function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function redactObject(value: unknown, redact: boolean): unknown {
  if (!redact) return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, redact));
  if (!value || typeof value !== "object") return value;
  const out: Any = {};
  for (const [key, child] of Object.entries(value as Any)) {
    if (/api.?key|token|secret|password|credential|accessKeyId|sessionToken/i.test(key)) {
      out[key] = child ? "[redacted]" : child;
    } else {
      out[key] = redactObject(child, redact);
    }
  }
  return out;
}

function sanitizeTasksForBackup(tasks: Task[], includeSensitiveContent: boolean): unknown[] {
  if (includeSensitiveContent) return tasks;
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    sessionId: task.sessionId,
    parentTaskId: task.parentTaskId,
    source: task.source,
    labels: task.labels,
    resultSummary: task.resultSummary ? "[redacted]" : undefined,
    prompt: task.prompt ? "[redacted]" : undefined,
    rawPrompt: task.rawPrompt ? "[redacted]" : undefined,
    userPrompt: task.userPrompt ? "[redacted]" : undefined,
    error: task.error ? "[redacted]" : undefined,
  }));
}

function sanitizeApprovalsForBackup(approvals: unknown[], includeSensitiveContent: boolean): unknown[] {
  if (includeSensitiveContent) return approvals;
  return approvals.map((approval) => {
    if (!approval || typeof approval !== "object") return approval;
    const row = approval as Any;
    return {
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      description: row.description ? "[redacted]" : undefined,
      payload: row.payload ? "[redacted]" : undefined,
    };
  });
}

function sanitizeMcpForBackup(settings: unknown, includeSensitiveContent: boolean): unknown {
  if (includeSensitiveContent) return settings;
  const cloned = redactObject(settings, true) as Any;
  if (Array.isArray(cloned?.servers)) {
    cloned.servers = cloned.servers.map((server: Any) => ({
      ...server,
      env: server.env ? redactObject(server.env, true) : undefined,
      headers: server.headers ? redactObject(server.headers, true) : undefined,
      auth: server.auth ? redactObject(server.auth, true) : undefined,
    }));
  }
  return cloned;
}

interface CliSkillEntry {
  id: string;
  name: string;
  description?: string;
  category?: string;
  prompt?: string;
  filePath: string;
  source: "bundled" | "managed" | "workspace";
  disabled?: boolean;
}

async function readOnlySkillStatus(args: DirectRunArgs): Promise<{
  skills: CliSkillEntry[];
  summary: { total: number; bundled: number; managed: number; workspace: number; disabled: number };
}> {
  const root = await findPackageRoot();
  const dirs = [
    { source: "bundled" as const, dir: path.join(root, "resources", "skills") },
    { source: "managed" as const, dir: path.join(getUserDataDir(), "skills") },
    { source: "workspace" as const, dir: path.join(path.resolve(args.cwd), ".cowork", "skills") },
  ];
  const byId = new Map<string, CliSkillEntry>();
  for (const entry of dirs) {
    const skills = await scanSkillDir(entry.dir, entry.source);
    for (const skill of skills) byId.set(skill.id, skill);
  }
  const skills = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills,
    summary: {
      total: skills.length,
      bundled: skills.filter((skill) => skill.source === "bundled").length,
      managed: skills.filter((skill) => skill.source === "managed").length,
      workspace: skills.filter((skill) => skill.source === "workspace").length,
      disabled: skills.filter((skill) => skill.disabled).length,
    },
  };
}

async function scanSkillDir(
  dir: string,
  source: CliSkillEntry["source"],
): Promise<CliSkillEntry[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: CliSkillEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const parsed = JSON.parse(await fs.readFile(fullPath, "utf8")) as Any;
        const id = String(parsed.id || path.basename(entry.name, ".json")).trim();
        const name = String(parsed.name || id).trim();
        if (!id || !name) continue;
        skills.push({
          id,
          name,
          description: typeof parsed.description === "string" ? parsed.description : undefined,
          category: typeof parsed.category === "string" ? parsed.category : undefined,
          prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
          disabled: parsed.enabled === false || parsed.disabled === true,
          filePath: fullPath,
          source,
        });
        continue;
      }
      if (entry.isDirectory()) {
        const skillMd = path.join(fullPath, "SKILL.md");
        const text = await fs.readFile(skillMd, "utf8");
        const id = path.basename(fullPath);
        const frontmatter = parseSkillMarkdownFrontmatter(text);
        skills.push({
          id,
          name: frontmatter.name || id,
          description: frontmatter.description,
          category: frontmatter.category,
          prompt: text,
          filePath: skillMd,
          source,
        });
      }
    } catch {
      // Ignore unreadable or malformed entries; audit reports only parseable skills.
    }
  }
  return skills;
}

function parseSkillMarkdownFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const result: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

function validateBuiltinToolsSettings(value: unknown): ReturnType<typeof BuiltinToolsSettingsManager.loadSettings> {
  const defaults = BuiltinToolsSettingsManager.getDefaultSettings();
  if (!value || typeof value !== "object") throw new Error("Invalid built-in tools settings in backup.");
  const raw = value as Any;
  if (!raw.categories || typeof raw.categories !== "object") {
    throw new Error("Invalid built-in tools settings: missing categories.");
  }
  const next = {
    ...defaults,
    ...raw,
    categories: {
      ...defaults.categories,
      ...raw.categories,
    },
    toolOverrides: typeof raw.toolOverrides === "object" && raw.toolOverrides ? raw.toolOverrides : {},
    toolTimeouts: typeof raw.toolTimeouts === "object" && raw.toolTimeouts ? raw.toolTimeouts : {},
    toolAutoApprove: typeof raw.toolAutoApprove === "object" && raw.toolAutoApprove ? raw.toolAutoApprove : {},
    runCommandApprovalMode: raw.runCommandApprovalMode === "per_command" ? "per_command" : defaults.runCommandApprovalMode,
    codexRuntimeMode: raw.codexRuntimeMode === "acpx" ? "acpx" : "native",
  } as ReturnType<typeof BuiltinToolsSettingsManager.loadSettings>;

  for (const [name, category] of Object.entries(next.categories)) {
    if (!category || typeof category !== "object") throw new Error(`Invalid tool category in backup: ${name}`);
    if (typeof category.enabled !== "boolean") throw new Error(`Invalid enabled flag for tool category: ${name}`);
    if (!["high", "normal", "low"].includes(category.priority)) {
      throw new Error(`Invalid priority for tool category: ${name}`);
    }
  }
  return next;
}

function disableRestoredMcpServers(settings: Any): Any {
  return {
    ...settings,
    servers: Array.isArray(settings.servers)
      ? settings.servers.map((server: Any) => ({
          ...server,
          enabled: false,
          lastError: "Restored by CLI backup restore; disabled until re-enabled.",
        }))
      : [],
  };
}

function sanitizeLimit(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(2000, Math.floor(value));
}

function sanitizeDays(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(36500, Math.floor(value));
}

function sanitizeNonNegativeNumber(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function parseDurationMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (!text) return undefined;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|mo|y)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2] || "d";
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return Math.floor(value * multipliers[unit]);
}

function parseTimestampMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDoctor(payload: Record<string, unknown>): string {
  const providers = Array.isArray(payload.configuredProviders)
    ? payload.configuredProviders as Array<{ name?: string; type?: string }>
    : [];
  return [
    "CoWork CLI doctor",
    "- runtime: local direct runner",
    "- control plane: not required for local CLI",
    `- cwd: ${payload.cwd || process.cwd()}`,
    `- workspaces: ${payload.workspaceCount ?? 0}`,
    `- current provider: ${payload.currentProvider || "unknown"} (${payload.currentModel || "default model"})`,
    providers.length
      ? `- configured providers: ${providers.map((provider) => provider.name || provider.type).join(", ")}`
      : "- configured providers: none found",
  ].join("\n");
}

function formatTaskEventLine(event: {
  timestamp?: number;
  ts?: number;
  type: string;
  legacyType?: string;
  payload?: unknown;
}): string {
  const at = new Date(event.ts || event.timestamp || Date.now()).toISOString();
  const type = event.legacyType || event.type;
  return `${at}  ${type}  ${summarizeEventPayload(event.payload)}`;
}

function summarizeEventPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const candidates = [
    obj.message,
    obj.content,
    obj.text,
    obj.summary,
    obj.error,
    obj.path,
    obj.tool,
    obj.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return truncate(candidate.trim(), 240);
  }
  try {
    return truncate(JSON.stringify(obj), 240);
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function writeLine(args: DirectRunArgs, message: string): void {
  const text = message.trim();
  if (!text) return;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ message: text })}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function writeEvent(
  args: DirectRunArgs,
  event: Record<string, unknown>,
  text: string,
): void {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    writeLine(args, text);
  }
}

function writeError(args: DirectRunArgs, message: string, taskId?: string): void {
  const text = message.trim();
  if (!text) return;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ type: "error", taskId, message: text })}\n`);
  } else {
    process.stderr.write(`${text}\n`);
  }
}

function stringifyMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function hasProviderEnv(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.OPENROUTER_API_KEY,
  );
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (process.env.COWORK_CLI_DEBUG === "1" || process.env.COWORK_CLI_DEBUG === "true") {
    return error.stack || error.message;
  }
  return error.message;
}

function installCliLogFilter(): () => void {
  if (process.env.COWORK_CLI_DEBUG === "1" || process.env.COWORK_CLI_DEBUG === "true") {
    return () => {};
  }

  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const noisyPrefixes = [
    "[AgentDaemon]",
    "[AppearanceManager]",
    "[DatabaseManager]",
    "[GuardrailManager]",
    "[LLM:",
    "[MCP",
    "[MemoryFeaturesManager]",
    "[MemoryService]",
    "[OpenAI]",
    "[PersonalityManager]",
    "[SearchProviderFactory]",
    "[SecureSettingsRepository]",
    "[TaskExecutor]",
    "[TaskQueueManager]",
    "[ToolRegistry]",
    "[VoiceSettingsManager]",
  ];

  const shouldSuppress = (items: unknown[]): boolean => {
    const text = items.map(formatLogItem).join(" ");
    return (
      text === "Agent daemon shutdown complete" ||
      noisyPrefixes.some((prefix) => text.startsWith(prefix))
    );
  };

  console.log = (...items: unknown[]) => {
    if (!shouldSuppress(items)) original.log(...items);
  };
  console.warn = (...items: unknown[]) => {
    if (!shouldSuppress(items)) original.warn(...items);
  };
  console.error = (...items: unknown[]) => {
    if (!shouldSuppress(items)) original.error(...items);
  };

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

function formatLogItem(item: unknown): string {
  if (typeof item === "string") return item;
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function shouldRunEntrypoint(): boolean {
  if (typeof require !== "undefined" && require.main === module) return true;
  if (!process.versions.electron) return false;
  return path.basename(process.argv[1] || "") === "direct-run.js";
}

if (shouldRunEntrypoint()) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
