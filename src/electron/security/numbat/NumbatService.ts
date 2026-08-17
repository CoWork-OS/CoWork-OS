import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type {
  AgentSecurityEvaluationResult,
  AgentSecurityFindingQuery,
  AgentSecurityFindingStatus,
  AgentSecurityHookPayload,
  AgentSecurityHookEventName,
  AgentSecurityPolicy,
  AgentSecurityRuntimeStatus,
} from "../../../shared/agent-security";
import { getPoliciesFileVersion, loadPolicies, watchPolicies } from "../../admin/policies";
import { getUserDataDir } from "../../utils/user-data-dir";
import { createLogger } from "../../utils/logger";
import { AgentSecurityRepository } from "./AgentSecurityRepository";
import { buildAgentSecurityHookPayload } from "./NumbatEventAdapter";
import { resolveNumbatBinary, type ResolvedNumbatBinary } from "./NumbatBinaryResolver";
import { materializeStableNumbatBinary } from "./NumbatBinaryResolver";
import { runNumbatCommand } from "./NumbatCommandClient";
import { invokeNumbatHook } from "./NumbatHookClient";
import { NumbatRecordIngestor, type NumbatIngestResult } from "./NumbatRecordIngestor";
import { redactAgentSecurityRecord, redactAgentSecurityString } from "./NumbatRedaction";

const logger = createLogger("NumbatService");
const GENERIC_DENY_REASON = "Action denied. Do not retry or attempt an equivalent action.";

export interface AgentSecurityToolEvaluationInput {
  taskId: string;
  sessionId?: string;
  workspacePath: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  highRisk: boolean;
  provider?: string;
  model?: string;
  permissionMode?: string;
  subAgent?: boolean;
}

export interface AgentSecurityPostToolInput extends AgentSecurityToolEvaluationInput {
  success: boolean;
  durationMs: number;
  exitCode?: number;
  outputBytes?: number;
  errorType?: string;
  decisionId?: string;
}

export interface AgentSecurityLifecycleInput {
  taskId: string;
  sessionId?: string;
  workspacePath?: string;
  hookEventName: Exclude<
    AgentSecurityHookEventName,
    "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  >;
  actor?: "user" | "assistant" | "system" | "tool";
}

type TaskEventEmitter = (
  taskId: string,
  type: "security_finding" | "security_action_denied" | "security_runtime_degraded",
  payload: Record<string, unknown>,
) => void;

export class NumbatService {
  private static instance: NumbatService | null = null;
  private readonly repository: AgentSecurityRepository;
  private readonly ingestor: NumbatRecordIngestor;
  private readonly taskChains = new Map<string, Promise<unknown>>();
  private emitter: TaskEventEmitter | null = null;
  private scheduledScanTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private policyWatcherCleanup: (() => void) | null = null;
  private scheduledScanRunning = false;
  private cachedPolicy: AgentSecurityPolicy;
  private policyFileVersion: string;
  private lastStatus: AgentSecurityRuntimeStatus = {
    enabled: false,
    mode: "monitor",
    health: "disabled",
    pendingObservations: 0,
  };

  static initialize(db: Database.Database): NumbatService {
    if (!NumbatService.instance) NumbatService.instance = new NumbatService(db);
    return NumbatService.instance;
  }

  static getInstance(): NumbatService | null {
    return NumbatService.instance;
  }

  static resetForTesting(): void {
    NumbatService.instance?.shutdown();
    NumbatService.instance = null;
  }

  private constructor(db: Database.Database) {
    this.repository = new AgentSecurityRepository(db);
    this.ingestor = new NumbatRecordIngestor(
      this.repository,
      path.join(getUserDataDir(), "security", "numbat", "cursors"),
    );
    this.cachedPolicy = loadPolicies().runtime.agentSecurity;
    this.policyFileVersion = getPoliciesFileVersion();
    this.ensureRuntimeDirectories();
    this.configureScheduledScan();
    this.policyWatcherCleanup = watchPolicies(() => this.configureScheduledScan());
  }

  attachTaskEventEmitter(emitter: TaskEventEmitter): void {
    this.emitter = emitter;
  }

  getRepository(): AgentSecurityRepository {
    return this.repository;
  }

  configureScheduledScan(): void {
    this.cachedPolicy = loadPolicies().runtime.agentSecurity;
    this.policyFileVersion = getPoliciesFileVersion();
    if (this.scheduledScanTimer) {
      clearInterval(this.scheduledScanTimer);
      this.scheduledScanTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    this.runRetentionPrune();
    this.retentionTimer = setInterval(() => this.runRetentionPrune(), 24 * 60 * 60 * 1_000);
    this.retentionTimer.unref?.();

    if (!this.isEnabled()) return;

    const policy = this.cachedPolicy;
    if (!policy.scheduledScan.enabled) return;
    const intervalMs = policy.scheduledScan.intervalHours * 60 * 60 * 1_000;
    this.scheduledScanTimer = setInterval(() => {
      if (this.scheduledScanRunning) return;
      this.scheduledScanRunning = true;
      void this.runScan()
        .catch((error) => {
          this.repository.addDiagnostic({
            level: "error",
            code: "scheduled_scan_failed",
            message: redactAgentSecurityString(
              error instanceof Error ? error.message : String(error),
              512,
            ),
          });
        })
        .finally(() => {
          this.scheduledScanRunning = false;
        });
    }, intervalMs);
    this.scheduledScanTimer.unref?.();
  }

  shutdown(): void {
    if (this.scheduledScanTimer) clearInterval(this.scheduledScanTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.scheduledScanTimer = null;
    this.retentionTimer = null;
    this.policyWatcherCleanup?.();
    this.policyWatcherCleanup = null;
  }

  isEnabled(): boolean {
    this.refreshCachedPolicyIfChanged();
    return process.env.COWORK_AGENT_SECURITY_DISABLED !== "1" && this.cachedPolicy.enabled;
  }

  async getStatus(refresh = false): Promise<AgentSecurityRuntimeStatus> {
    if (!this.isEnabled()) {
      const policy = this.cachedPolicy;
      this.lastStatus = {
        enabled: false,
        mode: policy.mode,
        health: "disabled",
        pendingObservations: this.taskChains.size,
      };
      return this.lastStatus;
    }
    const policy = this.cachedPolicy;
    if (
      !refresh &&
      this.lastStatus.lastCheckedAt &&
      Date.now() - this.lastStatus.lastCheckedAt < 30_000
    ) {
      return { ...this.lastStatus, pendingObservations: this.taskChains.size };
    }
    try {
      const binary = resolveNumbatBinary();
      this.lastStatus = {
        enabled: true,
        mode: policy.mode,
        health: "ok",
        binaryPath: binary.path,
        binaryVersion: binary.version,
        schemaVersion: binary.schemaVersion,
        lastCheckedAt: Date.now(),
        pendingObservations: this.taskChains.size,
      };
    } catch (error) {
      this.lastStatus = {
        enabled: true,
        mode: policy.mode,
        health: "unavailable",
        lastCheckedAt: Date.now(),
        lastError: redactAgentSecurityString(
          error instanceof Error ? error.message : String(error),
          512,
        ),
        pendingObservations: this.taskChains.size,
      };
    }
    return this.lastStatus;
  }

  async evaluatePreTool(
    input: AgentSecurityToolEvaluationInput,
  ): Promise<AgentSecurityEvaluationResult> {
    if (!this.isEnabled()) {
      return { decision: "no_override", health: "disabled", durationMs: 0 };
    }
    return await this.runOrdered(input.taskId, async () => {
      if (!this.isEnabled()) {
        return { decision: "no_override", health: "disabled", durationMs: 0 };
      }
      const policy = this.cachedPolicy;
      const startedAt = Date.now();
      try {
        const binary = resolveNumbatBinary();
        this.validateRuleDirectories(
          policy.ruleProfile === "custom" ? policy.customRuleDirs : [],
          input.workspacePath,
        );
        const payload = buildAgentSecurityHookPayload({
          hookEventName: "PreToolUse",
          taskId: input.taskId,
          sessionId: input.sessionId,
          workspacePath: input.workspacePath,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          toolInput: input.toolInput,
          actor: "assistant",
          provider: input.provider,
          model: input.model,
          permissionMode: input.permissionMode,
          subAgent: input.subAgent,
        });
        const response = await this.invoke(binary, payload, policy);
        const ingested = this.ingestAndEmit(this.recordFile(input.taskId), input.taskId);
        if (response.health === "degraded") {
          throw new Error("Numbat returned a degraded enforcement response");
        }
        const recordedDecision = [...ingested.decisions]
          .reverse()
          .find(
            (decision) =>
              decision.decision === response.decision &&
              (!decision.toolCallId || decision.toolCallId === input.toolCallId),
          );
        const decisionId = response.decision_id || recordedDecision?.decisionId;
        if (response.decision === "deny") {
          this.emitter?.(input.taskId, "security_action_denied", {
            decisionId,
            tool: input.toolName,
            source: "numbat",
          });
        }
        return {
          decision: response.decision,
          health: response.health,
          reason: response.decision === "deny" ? response.reason || GENERIC_DENY_REASON : undefined,
          decisionId,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const message = redactAgentSecurityString(
          error instanceof Error ? error.message : String(error),
          512,
        );
        this.repository.addDiagnostic({
          taskId: input.taskId,
          level: "error",
          code: "pre_tool_evaluation_failed",
          message,
        });
        this.emitter?.(input.taskId, "security_runtime_degraded", {
          code: "pre_tool_evaluation_failed",
        });
        const denyForFailure =
          policy.mode === "enforce" && policy.failurePolicy === "deny_high_risk" && input.highRisk;
        return {
          decision: denyForFailure ? "deny" : "no_override",
          health: "degraded",
          reason: denyForFailure ? GENERIC_DENY_REASON : undefined,
          durationMs: Date.now() - startedAt,
          failureCode: "pre_tool_evaluation_failed",
        };
      }
    });
  }

  observePostTool(input: AgentSecurityPostToolInput): void {
    if (!this.isEnabled()) return;
    void this.runOrdered(input.taskId, async () => {
      if (!this.isEnabled()) return;
      const policy = this.cachedPolicy;
      try {
        const binary = resolveNumbatBinary();
        const payload = buildAgentSecurityHookPayload({
          hookEventName: input.success ? "PostToolUse" : "PostToolUseFailure",
          taskId: input.taskId,
          sessionId: input.sessionId,
          workspacePath: input.workspacePath,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          toolInput: input.toolInput,
          actor: "tool",
          provider: input.provider,
          model: input.model,
          permissionMode: input.permissionMode,
          subAgent: input.subAgent,
          result: {
            success: input.success,
            exit_code: input.exitCode,
            duration_ms: input.durationMs,
            output_bytes: input.outputBytes,
            error_type: input.errorType,
          },
        });
        await this.invoke(binary, payload, policy);
        this.ingestAndEmit(this.recordFile(input.taskId), input.taskId);
        if (input.decisionId) {
          this.repository.updateDecisionHostOutcome(
            input.decisionId,
            input.success ? "executed" : "failed",
          );
        }
      } catch (error) {
        this.repository.addDiagnostic({
          taskId: input.taskId,
          level: "warn",
          code: "post_tool_observation_failed",
          message: redactAgentSecurityString(
            error instanceof Error ? error.message : String(error),
            512,
          ),
        });
      }
    });
  }

  observeLifecycle(input: AgentSecurityLifecycleInput): void {
    if (!this.isEnabled()) return;
    void this.runOrdered(input.taskId, async () => {
      if (!this.isEnabled()) return;
      const policy = this.cachedPolicy;
      try {
        const binary = resolveNumbatBinary();
        const payload = buildAgentSecurityHookPayload({
          hookEventName: input.hookEventName,
          taskId: input.taskId,
          sessionId: input.sessionId,
          workspacePath: input.workspacePath,
          actor: input.actor,
        });
        await this.invoke(binary, payload, policy);
        this.ingestAndEmit(this.recordFile(input.taskId), input.taskId);
      } catch (error) {
        this.repository.addDiagnostic({
          taskId: input.taskId,
          level: "warn",
          code: "lifecycle_observation_failed",
          message: redactAgentSecurityString(
            error instanceof Error ? error.message : String(error),
            512,
          ),
        });
      }
    });
  }

  recordBlockedDecision(decisionId?: string): void {
    if (decisionId) this.repository.updateDecisionHostOutcome(decisionId, "blocked");
  }

  listFindings(query: AgentSecurityFindingQuery = {}) {
    return this.repository.listFindings(query);
  }

  listDecisions(taskId?: string, limit?: number) {
    return this.repository.listDecisions(taskId, limit);
  }

  listDiagnostics(limit?: number) {
    return this.repository.listDiagnostics(limit);
  }

  updateFindingStatus(findingId: string, status: AgentSecurityFindingStatus) {
    return this.repository.updateFindingStatus(findingId, status);
  }

  async refreshInventory(): Promise<ReturnType<AgentSecurityRepository["listInventory"]>> {
    const binary = resolveNumbatBinary();
    const { stdout } = await runNumbatCommand({
      binary,
      args: ["agents", "--all", "--format", "json"],
      timeoutMs: 15_000,
    });
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Any).agents)
        ? (parsed as Any).agents
        : [];
    const checkedAt = Date.now();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const agentId =
        typeof row.agent === "string"
          ? row.agent
          : typeof row.id === "string"
            ? row.id
            : typeof row.name === "string"
              ? row.name
              : "";
      if (!agentId) continue;
      const details = redactAgentSecurityRecord(row) as Record<string, unknown>;
      const setupHint = typeof row.setup_hint === "string" ? row.setup_hint : "";
      const hintedAgent = setupHint.match(/--agent\s+([a-z0-9-]+)/i)?.[1]?.toLowerCase();
      this.repository.upsertInventory({
        agentId: hintedAgent || this.inventoryAgentId(agentId),
        present:
          row.present === true ||
          row.config === true ||
          row.artifacts === true ||
          row.detected === true,
        wired:
          row.wired === true ||
          (typeof row.wired === "string" &&
            ["yes", "installed", "wired"].includes(row.wired.toLowerCase())),
        liveMode:
          typeof row.hook === "string"
            ? row.hook
            : typeof row.live === "string"
              ? row.live
              : typeof row.live_mode === "string"
                ? row.live_mode
                : undefined,
        details,
        checkedAt,
      });
    }
    this.ingestExternalRecords();
    return this.repository.listInventory();
  }

  listInventory() {
    return this.repository.listInventory();
  }

  async runScan(): Promise<{ outputFile: string; findings: number }> {
    const binary = resolveNumbatBinary();
    const scanDir = path.join(getUserDataDir(), "security", "numbat", "scans");
    fs.mkdirSync(scanDir, { recursive: true, mode: 0o700 });
    const outputFile = path.join(scanDir, `scan-${Date.now()}.ndjson`);
    const args = ["scan", "--emit", "all", "--output", "file", "--output-file", outputFile];
    const policy = this.cachedPolicy;
    if (policy.ruleProfile === "recommended") {
      const recommended = this.recommendedRulesDir();
      if (!recommended) throw new Error("CoWork recommended Numbat rules are missing");
      args.push("--rules-dir", recommended);
    } else if (policy.ruleProfile === "custom") {
      this.validateRuleDirectories(policy.customRuleDirs);
      for (const ruleDir of policy.customRuleDirs) args.push("--rules-dir", ruleDir);
    }
    await runNumbatCommand({ binary, args, timeoutMs: 120_000 });
    const ingested = this.ingestor.ingestFile(outputFile);
    return { outputFile, findings: ingested.findings.length };
  }

  async checkRules(): Promise<{ ok: true; output: string }> {
    const binary = resolveNumbatBinary();
    const args = ["rules", "check"];
    const policy = this.cachedPolicy;
    if (policy.ruleProfile === "recommended") {
      const recommended = this.recommendedRulesDir();
      if (!recommended) throw new Error("CoWork recommended Numbat rules are missing");
      args.push("--rules-dir", recommended);
    } else if (policy.ruleProfile === "custom") {
      this.validateRuleDirectories(policy.customRuleDirs);
      for (const ruleDir of policy.customRuleDirs) args.push("--rules-dir", ruleDir);
    }
    const result = await runNumbatCommand({ binary, args, timeoutMs: 30_000 });
    return {
      ok: true,
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  async hookStatus(agent: string): Promise<{ output: string }> {
    this.validateExternalAgentName(agent);
    const binary = resolveNumbatBinary();
    const result = await runNumbatCommand({
      binary,
      args: ["hook", "status", "--agent", agent],
      timeoutMs: 15_000,
    });
    return {
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  async installHook(agent: string): Promise<{ output: string }> {
    this.validateExternalAgentName(agent);
    const binary = materializeStableNumbatBinary(resolveNumbatBinary());
    const outputFile = path.join(
      getUserDataDir(),
      "security",
      "numbat",
      "external",
      `${agent}.ndjson`,
    );
    fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
    const args = [
      "hook",
      "install",
      "--agent",
      agent,
      "--emit",
      "all",
      "--output",
      "file",
      "--output-file",
      outputFile,
    ];
    const policy = this.cachedPolicy;
    if (policy.ruleProfile === "recommended") {
      const recommended = this.recommendedRulesDir();
      if (!recommended) throw new Error("CoWork recommended Numbat rules are missing");
      args.push("--rules-dir", recommended);
    } else if (policy.ruleProfile === "custom") {
      this.validateRuleDirectories(policy.customRuleDirs);
      for (const ruleDir of policy.customRuleDirs) args.push("--rules-dir", ruleDir);
    }
    if (policy.mode === "enforce") args.push("--enforce");
    const result = await runNumbatCommand({ binary, args, timeoutMs: 30_000 });
    return {
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  async uninstallHook(agent: string): Promise<{ output: string }> {
    this.validateExternalAgentName(agent);
    const binary = materializeStableNumbatBinary(resolveNumbatBinary());
    const result = await runNumbatCommand({
      binary,
      args: ["hook", "uninstall", "--agent", agent],
      timeoutMs: 30_000,
    });
    return {
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  async buildCase(
    caseId: string,
    taskId: string,
  ): Promise<{
    caseId: string;
    taskId: string;
    bundleName: string;
    bundlePath: string;
    output: string;
  }> {
    this.validateCaseIdentifier(caseId, "Case ID");
    this.validateCaseIdentifier(taskId, "Task ID");
    const inputFile = this.recordFile(taskId);
    if (!fs.existsSync(inputFile) || fs.statSync(inputFile).size === 0) {
      throw new Error(`No Numbat records are available for task ${taskId}`);
    }
    const binary = resolveNumbatBinary();
    const bundleName = `${caseId}-${Date.now()}.numbat`;
    const bundlePath = path.join(this.casesDir(), bundleName);
    const result = await runNumbatCommand({
      binary,
      args: ["case", "build", caseId, "--from", inputFile, "--out", bundlePath],
      timeoutMs: 60_000,
    });
    return {
      caseId,
      taskId,
      bundleName,
      bundlePath,
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  async verifyCase(bundleName: string): Promise<{
    bundleName: string;
    bundlePath: string;
    verified: true;
    output: string;
  }> {
    this.validateCaseIdentifier(bundleName, "Case bundle name");
    const casesDir = fs.realpathSync(this.casesDir());
    const candidate = path.join(casesDir, bundleName);
    const bundlePath = fs.realpathSync(candidate);
    const relative = path.relative(casesDir, bundlePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Case bundle must be a direct child of the managed case directory");
    }
    if (!fs.statSync(bundlePath).isDirectory()) {
      throw new Error("Case bundle is not a directory");
    }
    const binary = resolveNumbatBinary();
    const result = await runNumbatCommand({
      binary,
      args: ["case", "verify", bundlePath],
      timeoutMs: 30_000,
    });
    return {
      bundleName,
      bundlePath,
      verified: true,
      output: redactAgentSecurityString(`${result.stdout}\n${result.stderr}`.trim(), 8_192),
    };
  }

  prune(): ReturnType<AgentSecurityRepository["prune"]> {
    this.pruneRuntimeArtifacts(this.cachedPolicy.retentionDays);
    return this.repository.prune(this.cachedPolicy.retentionDays);
  }

  private async invoke(
    binary: ResolvedNumbatBinary,
    payload: AgentSecurityHookPayload,
    policy: AgentSecurityPolicy,
  ) {
    if (policy.ruleProfile === "custom") {
      this.validateRuleDirectories(policy.customRuleDirs, payload.workspace_path);
    }
    const recommendedRulesDir = this.recommendedRulesDir();
    if (policy.ruleProfile === "recommended" && !recommendedRulesDir) {
      throw new Error("CoWork recommended Numbat rules are missing");
    }
    return await invokeNumbatHook({
      binary,
      payload,
      mode: policy.mode,
      ruleProfile: policy.ruleProfile,
      customRuleDirs: policy.customRuleDirs,
      recommendedRulesDir,
      outputFile: this.recordFile(payload.task_id),
      stateDb: this.stateDb(payload.task_id),
      timeoutMs: policy.timeoutMs,
    });
  }

  private ingestAndEmit(filePath: string, taskId: string): NumbatIngestResult {
    const ingested = this.ingestor.ingestFile(filePath, taskId);
    for (const finding of ingested.findings) {
      this.emitter?.(taskId, "security_finding", {
        findingId: finding.findingId,
        ruleId: finding.ruleId,
        severity: finding.severity,
        title: finding.title,
      });
    }
    return ingested;
  }

  private runOrdered<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskChains.get(taskId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.taskChains.set(taskId, current);
    void current.then(
      () => {
        if (this.taskChains.get(taskId) === current) this.taskChains.delete(taskId);
      },
      () => {
        if (this.taskChains.get(taskId) === current) this.taskChains.delete(taskId);
      },
    );
    return current;
  }

  private runRetentionPrune(): void {
    try {
      this.prune();
    } catch (error) {
      this.repository.addDiagnostic({
        level: "warn",
        code: "automatic_retention_prune_failed",
        message: redactAgentSecurityString(
          error instanceof Error ? error.message : String(error),
          512,
        ),
      });
    }
  }

  private pruneRuntimeArtifacts(retentionDays: number): void {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    const protectedTasks = new Set(
      this.repository.listOpenFindingTaskIds().map((taskId) => this.taskKey(taskId)),
    );
    const roots = [
      { dir: path.join(getUserDataDir(), "security", "numbat", "records"), protected: true },
      { dir: path.join(getUserDataDir(), "security", "numbat", "state"), protected: true },
      { dir: path.join(getUserDataDir(), "security", "numbat", "external"), protected: false },
      { dir: path.join(getUserDataDir(), "security", "numbat", "scans"), protected: false },
    ];
    for (const root of roots) {
      if (!fs.existsSync(root.dir)) continue;
      for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(root.dir, entry.name);
        const taskKey = entry.name.replace(/\.(?:ndjson|db)(?:-(?:wal|shm))?$/, "");
        if (root.protected && protectedTasks.has(taskKey)) continue;
        if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
        this.ingestor.forgetFile(filePath);
        fs.rmSync(filePath, { force: true });
      }
    }
  }

  private refreshCachedPolicyIfChanged(): void {
    const currentVersion = getPoliciesFileVersion();
    if (currentVersion === this.policyFileVersion) return;
    this.cachedPolicy = loadPolicies().runtime.agentSecurity;
    this.policyFileVersion = currentVersion;
  }

  private ensureRuntimeDirectories(): void {
    for (const dir of [
      path.join(getUserDataDir(), "security"),
      path.join(getUserDataDir(), "security", "numbat"),
      path.join(getUserDataDir(), "security", "numbat", "records"),
      path.join(getUserDataDir(), "security", "numbat", "state"),
      path.join(getUserDataDir(), "security", "numbat", "cursors"),
      path.join(getUserDataDir(), "security", "numbat", "bin"),
      this.casesDir(),
    ]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    }
  }

  private taskKey(taskId: string): string {
    return taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  }

  private recordFile(taskId: string): string {
    return path.join(
      getUserDataDir(),
      "security",
      "numbat",
      "records",
      `${this.taskKey(taskId)}.ndjson`,
    );
  }

  private stateDb(taskId: string): string {
    return path.join(getUserDataDir(), "security", "numbat", "state", `${this.taskKey(taskId)}.db`);
  }

  private casesDir(): string {
    return path.join(getUserDataDir(), "security", "numbat", "cases");
  }

  private validateCaseIdentifier(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
      throw new Error(`${label} contains invalid characters`);
    }
  }

  private recommendedRulesDir(): string | undefined {
    const candidates = [
      typeof process.resourcesPath === "string"
        ? path.join(process.resourcesPath, "numbat", "rules", "cowork-recommended")
        : "",
      path.resolve(__dirname, "../../../../build/numbat/rules/cowork-recommended"),
      path.resolve(__dirname, "../../../../../build/numbat/rules/cowork-recommended"),
      path.resolve(__dirname, "../../../../resources/numbat/rules/cowork-recommended"),
      path.resolve(__dirname, "../../../../../resources/numbat/rules/cowork-recommended"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const linkStat = fs.lstatSync(candidate);
      if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) continue;
      const resolved = fs.realpathSync(candidate);
      const stat = fs.lstatSync(resolved);
      if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) continue;
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        continue;
      }
      return resolved;
    }
    return undefined;
  }

  private validateRuleDirectories(ruleDirs: string[], workspacePath?: string): void {
    for (const ruleDir of ruleDirs) {
      if (!path.isAbsolute(ruleDir)) {
        throw new Error("Custom Numbat rule directories must be absolute");
      }
      if (workspacePath) {
        const relative = path.relative(path.resolve(workspacePath), path.resolve(ruleDir));
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
          throw new Error("Custom Numbat rules must not be loaded from the active workspace");
        }
      }
      const stat = fs.lstatSync(ruleDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Custom Numbat rule path must be a real directory");
      }
      if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
        throw new Error("Custom Numbat rule directory is group- or world-writable");
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        throw new Error("Custom Numbat rule directory has an unsafe owner");
      }
    }
  }

  private validateExternalAgentName(agent: string): void {
    const supported = new Set([
      "claude",
      "codex",
      "gemini",
      "cursor",
      "windsurf",
      "copilot",
      "vscode",
      "opencode",
      "openclaw",
      "antigravity",
      "factory",
      "grok",
      "devin",
      "hermes",
      "pi",
      "kimi",
      "qwen",
      "cline",
      "amp",
      "auggie",
      "kiro",
      "goose",
      "kilo",
      "openhands",
      "crush",
      "junie",
    ]);
    if (!supported.has(agent)) {
      throw new Error("Invalid external agent name");
    }
  }

  private inventoryAgentId(displayName: string): string {
    if (displayName === "Claude Cowork") return "cowork";
    return displayName
      .toLowerCase()
      .replace(/\s*\/.*$/, "")
      .replace(/\s+(cli|chat|code|droid|agent|ide).*$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  private ingestExternalRecords(): void {
    const externalDir = path.join(getUserDataDir(), "security", "numbat", "external");
    if (!fs.existsSync(externalDir)) return;
    for (const entry of fs.readdirSync(externalDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) continue;
      this.ingestor.ingestFile(path.join(externalDir, entry.name));
    }
  }
}

export function getNumbatService(): NumbatService | null {
  return NumbatService.getInstance();
}
