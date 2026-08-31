import type { DatabaseManager } from "../database/schema";
import {
  PendingMemoryWriteRepository,
  type PendingMemoryWrite,
  type MemoryType,
  WorkspaceRepository,
} from "../database/repositories";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { createLogger } from "../utils/logger";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import type {
  CuratedMemoryKind,
  CuratedMemoryTarget,
  MemoryWriteApprovalItem,
  Workspace,
} from "../../shared/types";

const logger = createLogger("MemoryWriteGate");

export type MemoryWriteTarget = "archive" | "curated" | "external";
export type MemoryWriteOrigin =
  | "agent_tool"
  | "auto_capture"
  | "background"
  | "dreaming"
  | "distill"
  | "external_mirror"
  | "system";

export type MemoryWriteDecision =
  | { allowed: true }
  | { allowed: false; staged: true; pendingId: string; summary: string }
  | { allowed: false; blocked: true; error: string };

export interface MemoryWriteRequest {
  workspaceId: string;
  taskId?: string;
  target: MemoryWriteTarget;
  action: string;
  origin: MemoryWriteOrigin;
  summary: string;
  payload: Record<string, unknown>;
  oldValue?: string;
  proposedValue?: string;
  reason?: string;
  evidence?: Array<Record<string, unknown>>;
  riskScore?: number;
}

export class MemoryWriteGate {
  private static pendingRepo: PendingMemoryWriteRepository;
  private static db?: import("better-sqlite3").Database;
  private static initialized = false;

  static initialize(dbManager: DatabaseManager): void {
    this.db = dbManager.getDatabase();
    this.pendingRepo = new PendingMemoryWriteRepository(this.db);
    this.initialized = true;
  }

  static evaluate(request: MemoryWriteRequest): MemoryWriteDecision {
    if (!this.initialized) {
      logger.warn("[MemoryWriteGate] Not initialized; allowing memory write.");
      return { allowed: true };
    }
    if (this.shouldBlock(request)) {
      logger.warn(
        `[MemoryWriteGate] Blocked sensitive external memory write target=${request.target} action=${request.action} origin=${request.origin}`,
      );
      return {
        allowed: false,
        blocked: true,
        error: "External memory write contains sensitive content and was blocked.",
      };
    }
    if (!this.shouldStage(request)) {
      return { allowed: true };
    }

    const pending = this.pendingRepo.create({
      ...request,
      summary: this.normalizeSummary(request.summary),
      proposedValue: request.proposedValue ?? this.extractProposedValue(request.payload),
      riskScore: request.riskScore ?? this.estimateRisk(request),
    });

    logger.info(
      `[MemoryWriteGate] Staged memory write ${pending.id} target=${pending.target} action=${pending.action} origin=${pending.origin}`,
    );

    return {
      allowed: false,
      staged: true,
      pendingId: pending.id,
      summary: pending.summary,
    };
  }

  static listPending(workspaceId?: string, limit = 100): PendingMemoryWrite[] {
    this.ensureInitialized();
    return this.pendingRepo.list({ workspaceId, status: "pending", limit });
  }

  static listPendingForDisplay(workspaceId?: string, limit = 100): MemoryWriteApprovalItem[] {
    return this.listPending(workspaceId, limit).map((item) => this.toDisplayItem(item));
  }

  static findPending(id: string): PendingMemoryWrite | undefined {
    this.ensureInitialized();
    return this.pendingRepo.findById(id);
  }

  static findPendingForDisplay(id: string): MemoryWriteApprovalItem | undefined {
    const item = this.findPending(id);
    return item ? this.toDisplayItem(item) : undefined;
  }

  static pendingCount(workspaceId?: string): number {
    this.ensureInitialized();
    return this.pendingRepo.countPending(workspaceId);
  }

  static async applyPending(
    id: string,
    opts: { workspaceId?: string; reviewedBy?: string } = {},
  ): Promise<MemoryWriteApprovalItem> {
    this.ensureInitialized();
    const pending = this.pendingRepo.findById(id);
    if (!pending) {
      throw new Error(`Pending memory write not found: ${id}`);
    }
    if (opts.workspaceId && pending.workspaceId !== opts.workspaceId) {
      throw new Error("Pending memory write does not belong to this workspace.");
    }
    if (pending.status !== "pending") {
      throw new Error(`Pending memory write is already ${pending.status}.`);
    }

    const claimed = this.pendingRepo.updateStatusIfCurrent(id, "pending", "applying", {
      reviewedBy: opts.reviewedBy,
      resolution: "Applying approved memory write.",
    });
    if (!claimed) {
      const current = this.pendingRepo.findById(id);
      throw new Error(`Pending memory write is already ${current?.status || "changed"}.`);
    }

    try {
      await this.replay(claimed);
      const applied = this.pendingRepo.updateStatusIfCurrent(id, "applying", "applied", {
        reviewedBy: opts.reviewedBy,
        resolution: "Applied approved memory write.",
      });
      return this.toDisplayItem(applied || this.pendingRepo.findById(id) || claimed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed =
        this.pendingRepo.updateStatusIfCurrent(id, "applying", "failed", {
          reviewedBy: opts.reviewedBy,
          resolution: message,
        }) ||
        this.pendingRepo.updateStatus(id, "failed", {
          reviewedBy: opts.reviewedBy,
          resolution: message,
        });
      logger.warn(`[MemoryWriteGate] Failed to apply pending write ${id}: ${message}`);
      return this.toDisplayItem(failed || claimed);
    }
  }

  static markApplied(
    id: string,
    resolution = "Applied approved memory write.",
  ): PendingMemoryWrite | undefined {
    this.ensureInitialized();
    return this.pendingRepo.updateStatusIfCurrent(id, "applying", "applied", { resolution });
  }

  static reject(id: string, resolution = "Rejected memory write."): PendingMemoryWrite | undefined {
    this.ensureInitialized();
    return this.pendingRepo.updateStatusIfCurrent(id, "pending", "rejected", { resolution });
  }

  static rejectForDisplay(
    id: string,
    opts: { workspaceId?: string; reviewedBy?: string; resolution?: string } = {},
  ): MemoryWriteApprovalItem {
    this.ensureInitialized();
    const pending = this.pendingRepo.findById(id);
    if (!pending) {
      throw new Error(`Pending memory write not found: ${id}`);
    }
    if (opts.workspaceId && pending.workspaceId !== opts.workspaceId) {
      throw new Error("Pending memory write does not belong to this workspace.");
    }
    if (pending.status !== "pending") {
      throw new Error(`Pending memory write is already ${pending.status}.`);
    }
    const rejected = this.pendingRepo.updateStatusIfCurrent(id, "pending", "rejected", {
      reviewedBy: opts.reviewedBy,
      resolution: opts.resolution || "Rejected memory write.",
    });
    if (!rejected) {
      const current = this.pendingRepo.findById(id);
      throw new Error(`Pending memory write is already ${current?.status || "changed"}.`);
    }
    return this.toDisplayItem(rejected);
  }

  static markFailed(id: string, resolution: string): PendingMemoryWrite | undefined {
    this.ensureInitialized();
    return (
      this.pendingRepo.updateStatusIfCurrent(id, "applying", "failed", { resolution }) ||
      this.pendingRepo.updateStatusIfCurrent(id, "pending", "failed", { resolution })
    );
  }

  private static shouldStage(request: MemoryWriteRequest): boolean {
    const envMode = this.normalizeMode(process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE);
    const mode = envMode || MemoryFeaturesManager.loadSettings().memoryWriteApprovalMode || "off";
    switch (mode) {
      case "all":
        return true;
      case "curated_only":
        return request.target === "curated";
      case "external_only":
        return request.target === "external";
      case "background_only":
        return (
          request.origin === "auto_capture" ||
          request.origin === "background" ||
          request.origin === "dreaming" ||
          request.origin === "distill" ||
          request.origin === "external_mirror"
        );
      default:
        return false;
    }
  }

  private static shouldBlock(request: MemoryWriteRequest): boolean {
    return request.target === "external" && this.containsSensitiveDisplayContent(request.payload);
  }

  private static async replay(pending: PendingMemoryWrite): Promise<void> {
    if (pending.target === "archive") {
      await this.replayArchive(pending);
      return;
    }
    if (pending.target === "curated") {
      await this.replayCurated(pending);
      return;
    }
    if (pending.target === "external") {
      await this.replayExternal(pending);
      return;
    }
    throw new Error(`Unsupported memory write target: ${pending.target}`);
  }

  private static async replayArchive(pending: PendingMemoryWrite): Promise<void> {
    const { MemoryService } = await import("./MemoryService");
    const payload = pending.payload;
    const type = this.asMemoryType(payload.type);
    const content = this.asString(payload.content);
    if (!type || !content) {
      throw new Error("Pending archive memory payload is missing type or content.");
    }
    const options = this.asPlainObject(payload.options);
    const workspace = this.getStoredWorkspace(pending.workspaceId);
    const memory = await MemoryService.capture(
      pending.workspaceId,
      pending.taskId,
      type,
      content,
      payload.isPrivate === true,
      {
        ...options,
        skipMemoryWriteGate: true,
        allowExternalMirror: this.isExternalMemoryReplayAllowed(workspace),
      },
    );
    if (!memory) {
      throw new Error("Approved archive memory write was filtered or memory capture is disabled.");
    }
  }

  private static async replayCurated(pending: PendingMemoryWrite): Promise<void> {
    const { CuratedMemoryService } = await import("./CuratedMemoryService");
    const payload = pending.payload;
    const filesystemGuards = this.getCuratedFilesystemGuards(
      this.getStoredWorkspace(pending.workspaceId),
    );
    const action = this.asString(payload.action);
    const target = this.asCuratedTarget(payload.target);
    if (action === "upsert") {
      const kind = this.asCuratedKind(payload.kind);
      const content = this.asString(payload.content);
      if (!target || !kind || !content) {
        throw new Error("Pending curated upsert payload is missing target, kind, or content.");
      }
      const source =
        payload.source === "agent_tool" ||
        payload.source === "user_edit" ||
        payload.source === "migration" ||
        payload.source === "distill"
          ? payload.source
          : "distill";
      const entry = await CuratedMemoryService.upsertDistilledEntry({
        workspaceId: pending.workspaceId,
        taskId: pending.taskId,
        target,
        kind,
        content,
        confidence: typeof payload.confidence === "number" ? payload.confidence : 0.8,
        source,
        skipMemoryWriteGate: true,
        ...filesystemGuards,
      });
      if (!entry) {
        throw new Error("Approved curated upsert did not produce an entry.");
      }
      return;
    }
    if (action !== "add" && action !== "replace" && action !== "remove") {
      throw new Error(`Unsupported curated memory action: ${action || pending.action}`);
    }
    if (!target) {
      throw new Error(`Unsupported curated memory target: ${this.asString(payload.target)}`);
    }
    const kind = this.asCuratedKind(payload.kind);
    const result = await CuratedMemoryService.curate({
      workspaceId: pending.workspaceId,
      taskId: pending.taskId,
      action,
      target,
      id: this.asString(payload.id),
      kind,
      content: this.asString(payload.content),
      match: this.asString(payload.match),
      reason: this.asString(payload.reason) || pending.reason,
      skipMemoryWriteGate: true,
      ...filesystemGuards,
    });
    if (!result.success) {
      throw new Error(result.error || "Approved curated memory write failed.");
    }
  }

  private static async replayExternal(pending: PendingMemoryWrite): Promise<void> {
    const { SupermemoryService } = await import("./SupermemoryService");
    const payload = pending.payload;
    const storedWorkspace = this.getStoredWorkspace(pending.workspaceId);
    if (!this.isExternalMemoryReplayAllowed(storedWorkspace)) {
      throw new Error(
        "Approved external memory write was blocked because the workspace no longer permits automatic network access.",
      );
    }
    const workspace = this.getWorkspaceRef(pending.workspaceId);
    if (pending.action === "remember") {
      const content = this.asString(payload.content);
      if (!content) throw new Error("Pending Supermemory remember payload is missing content.");
      const result = await SupermemoryService.remember({
        workspace,
        content,
        containerTag: this.asString(payload.containerTag),
        metadata: this.asPlainObject(payload.metadata),
        taskId: pending.taskId,
        skipMemoryWriteGate: true,
      });
      if (result.staged) {
        throw new Error("Approved Supermemory write was staged again unexpectedly.");
      }
      return;
    }
    if (pending.action === "mirror") {
      const content = this.asString(payload.content);
      const memoryType = this.asString(payload.memoryType);
      if (!content || !memoryType) {
        throw new Error("Pending Supermemory mirror payload is missing content or memory type.");
      }
      await SupermemoryService.mirrorMemory({
        workspace,
        taskId: pending.taskId,
        memoryType,
        content,
        createdAt: typeof payload.createdAt === "number" ? payload.createdAt : pending.createdAt,
        skipMemoryWriteGate: true,
      });
      return;
    }
    throw new Error(`Unsupported external memory action: ${pending.action}`);
  }

  private static getWorkspaceRef(workspaceId: string): { id: string; name: string } {
    try {
      if (this.db) {
        const workspace = new WorkspaceRepository(this.db).findById(workspaceId);
        if (workspace) {
          return { id: workspace.id, name: workspace.name || workspace.id };
        }
      }
    } catch {
      // Fall through to a stable fallback; the provider metadata still carries the workspace id.
    }
    return { id: workspaceId, name: workspaceId };
  }

  private static getStoredWorkspace(workspaceId: string): Workspace | undefined {
    try {
      if (!this.db) return undefined;
      return new WorkspaceRepository(this.db).findById(workspaceId);
    } catch {
      return undefined;
    }
  }

  private static getCuratedFilesystemGuards(workspace: Workspace | undefined): {
    filesystemReadGuard?: (candidatePath: string) => boolean;
    filesystemWriteGuard?: (candidatePath: string) => boolean;
  } {
    if (!workspace?.path) return {};
    return {
      filesystemReadGuard: (candidatePath) =>
        evaluateWorkspaceFilesystemAccess(workspace, candidatePath, "read").decision === "allow",
      filesystemWriteGuard: (candidatePath) =>
        evaluateWorkspaceFilesystemAccess(workspace, candidatePath, "write").decision === "allow",
    };
  }

  private static isExternalMemoryReplayAllowed(workspace: Workspace | undefined): boolean {
    if (!workspace?.permissions) return true;
    return (
      workspace.permissions.network === true &&
      workspace.permissions.accessProfileUnavailable !== true &&
      workspace.permissions.accessNetworkMode !== "disabled" &&
      workspace.permissions.accessNetworkMode !== "on-request"
    );
  }

  private static normalizeMode(value: unknown) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized === "curated_only" ||
      normalized === "external_only" ||
      normalized === "background_only" ||
      normalized === "all" ||
      normalized === "off"
      ? normalized
      : null;
  }

  private static normalizeSummary(summary: string): string {
    const normalized = String(summary || "")
      .replace(/\s+/g, " ")
      .trim();
    return normalized.slice(0, 240) || "Pending memory write";
  }

  private static extractProposedValue(payload: Record<string, unknown>): string | undefined {
    const value = payload.content ?? payload.proposedValue;
    return typeof value === "string" ? value.slice(0, 2000) : undefined;
  }

  private static estimateRisk(request: MemoryWriteRequest): number {
    let score = 0.2;
    if (request.target === "external") score += 0.45;
    if (request.target === "curated") score += 0.25;
    if (request.origin !== "agent_tool") score += 0.2;
    return Math.min(1, score);
  }

  private static toDisplayItem(item: PendingMemoryWrite): MemoryWriteApprovalItem {
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      taskId: item.taskId,
      target: item.target,
      action: item.action,
      origin: item.origin,
      summary: item.summary,
      payload: this.redactValue(item.payload) as Record<string, unknown>,
      oldValue: this.redactText(item.oldValue),
      proposedValue: this.redactText(item.proposedValue),
      reason: this.redactText(item.reason),
      evidence: this.redactValue(item.evidence) as Array<Record<string, unknown>>,
      riskScore: item.riskScore,
      status: item.status,
      createdAt: item.createdAt,
      reviewedAt: item.reviewedAt,
      reviewedBy: item.reviewedBy,
      resolution: this.redactText(item.resolution),
    };
  }

  private static redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (this.isSensitiveKey(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = this.redactValue(nested);
      }
    }
    return output;
  }

  private static redactText(value: string | undefined): string | undefined {
    if (!value) return value;
    return value
      .replace(/\b(api[_-]?key|secret|password|token|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, "gh_[redacted]")
      .replace(
        /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
        "[redacted private key]",
      );
  }

  private static isSensitiveKey(key: string): boolean {
    return /api[_-]?key|secret|password|token|credential|authorization/i.test(key);
  }

  private static containsSensitiveDisplayContent(value: unknown): boolean {
    if (typeof value === "string") {
      return (
        /\b(api[_-]?key|secret|password|token|credential)\s*[:=]\s*\S+/i.test(value) ||
        /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value) ||
        /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value) ||
        /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/.test(value) ||
        /-----BEGIN [^-]+ PRIVATE KEY-----/.test(value)
      );
    }
    if (Array.isArray(value))
      return value.some((item) => this.containsSensitiveDisplayContent(item));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, nested]) => this.isSensitiveKey(key) || this.containsSensitiveDisplayContent(nested),
    );
  }

  private static asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private static asPlainObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private static asCuratedTarget(value: unknown): CuratedMemoryTarget | undefined {
    return value === "user" || value === "workspace" ? value : undefined;
  }

  private static asCuratedKind(value: unknown): CuratedMemoryKind | undefined {
    return value === "identity" ||
      value === "preference" ||
      value === "constraint" ||
      value === "workflow_rule" ||
      value === "project_fact" ||
      value === "active_commitment"
      ? value
      : undefined;
  }

  private static asMemoryType(value: unknown): MemoryType | undefined {
    return value === "observation" ||
      value === "decision" ||
      value === "error" ||
      value === "insight" ||
      value === "screen_context" ||
      value === "summary" ||
      value === "preference" ||
      value === "constraint" ||
      value === "timing_preference" ||
      value === "workflow_pattern" ||
      value === "correction_rule"
      ? value
      : undefined;
  }

  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("[MemoryWriteGate] Not initialized. Call initialize() first.");
    }
  }
}
