import type {
  SupermemoryConfigStatus,
  SupermemoryCustomContainer,
  SupermemorySearchMode,
  SupermemorySettings,
} from "../../shared/types";
import type { Workspace } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";
import { containsNoMemoryDirective } from "./no-memory-directive";
import { REDACTED_SECRET, redactSecrets } from "./sensitive-content";
import { SupermemoryRemoteRefRepository } from "./SupermemoryRemoteRefRepository";
import type { SupermemoryRemoteRef } from "./supermemory-remote-refs-sql";

const STORAGE_KEY = "supermemory";
const DEFAULT_BASE_URL = "https://api.supermemory.ai";
const DEFAULT_CONTAINER_TEMPLATE = "cowork:{workspaceId}";
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_FAILURES_BEFORE_OPEN = 3;

interface SupermemoryFailureState {
  consecutiveFailures: number;
  firstFailureAt: number | null;
  circuitBreakerUntil: number | null;
  lastError: string | null;
}

type SupermemoryWorkspaceRef = Pick<Workspace, "id" | "name">;

interface SupermemoryProfileResponse {
  profile?: {
    static?: string[];
    dynamic?: string[];
  };
  searchResults?: {
    results?: Array<{
      id?: string;
      memory?: string;
      chunk?: string;
      similarity?: number;
      metadata?: Record<string, unknown>;
      updatedAt?: string;
    }>;
    total?: number;
    timing?: number;
  };
}

interface SupermemorySearchResponse {
  results?: Array<{
    id?: string;
    memory?: string;
    chunk?: string;
    similarity?: number;
    metadata?: Record<string, unknown>;
    updatedAt?: string;
  }>;
  total?: number;
  timing?: number;
}

interface SupermemoryRememberResponse {
  memories?: Array<{
    id?: string;
    memory?: string;
    version?: number;
  }>;
}

interface SupermemoryForgetResponse {
  id?: string;
  forgotten?: boolean;
}

interface SupermemoryDocumentResponse {
  id?: string;
  status?: string;
}

/** A Supermemory HTTP error, with the status code when the server answered. */
export class SupermemoryRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SupermemoryRequestError";
  }
}

/**
 * Whether a failure says the service is unhealthy (and counts toward the circuit breaker).
 * A 4xx is about the request — a bad id, a deleted document, a rejected key — and must not
 * pause every other call; 408 and 429 are the server asking to slow down, so they count.
 */
export function countsTowardCircuitBreaker(error: unknown): boolean {
  const status = error instanceof SupermemoryRequestError ? error.status : undefined;
  if (typeof status !== "number") return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

export interface SupermemoryRemoteForgetResult {
  /** Remote copies deleted (or already gone) whose local mapping was dropped. */
  forgotten: number;
  /** Remote copies that could not be deleted; their mapping is kept for a retry. */
  failed: number;
  errors: string[];
}

const ORPHAN_SWEEP_DELAY_MS = 1_500;
const REMOTE_FORGET_PAGE = 200;

const DEFAULT_SETTINGS: Required<
  Omit<SupermemorySettings, "apiKey"> & {
    customContainers: SupermemoryCustomContainer[];
  }
> = {
  enabled: false,
  baseUrl: DEFAULT_BASE_URL,
  containerTagTemplate: DEFAULT_CONTAINER_TEMPLATE,
  includeProfileInPrompt: true,
  mirrorMemoryWrites: true,
  searchMode: "hybrid",
  rerank: true,
  threshold: 0.55,
  customContainers: [],
};

export class SupermemoryService {
  private static cachedSettings: SupermemorySettings | null = null;
  private static failureState: SupermemoryFailureState = {
    consecutiveFailures: 0,
    firstFailureAt: null,
    circuitBreakerUntil: null,
    lastError: null,
  };

  static loadSettings(): SupermemorySettings {
    if (this.cachedSettings) {
      return this.normalizeSettings(this.cachedSettings);
    }

    let settings: SupermemorySettings = { ...DEFAULT_SETTINGS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<SupermemorySettings>(STORAGE_KEY);
        if (stored) {
          settings = { ...settings, ...stored };
        }
      }
    } catch (error) {
      console.error("[SupermemoryService] Failed to load settings:", error);
    }

    this.cachedSettings = this.normalizeSettings(settings);
    return this.cachedSettings;
  }

  static getSettingsView(): Omit<SupermemorySettings, "apiKey"> & { apiKeyConfigured: boolean } {
    const settings = this.loadSettings();
    return {
      enabled: settings.enabled === true,
      apiKeyConfigured: typeof settings.apiKey === "string" && settings.apiKey.trim().length > 0,
      baseUrl: settings.baseUrl || DEFAULT_BASE_URL,
      containerTagTemplate: settings.containerTagTemplate || DEFAULT_CONTAINER_TEMPLATE,
      includeProfileInPrompt: settings.includeProfileInPrompt !== false,
      mirrorMemoryWrites: settings.mirrorMemoryWrites !== false,
      searchMode: settings.searchMode || "hybrid",
      rerank: settings.rerank !== false,
      threshold: this.normalizeThreshold(settings.threshold),
      customContainers: this.normalizeCustomContainers(settings.customContainers),
    };
  }

  static saveSettings(settings: SupermemorySettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }

    const repository = SecureSettingsRepository.getInstance();
    const existing = this.loadSettings();
    const next: SupermemorySettings = this.normalizeSettings({
      ...existing,
      ...settings,
      apiKey:
        typeof settings.apiKey === "string" && settings.apiKey.trim()
          ? settings.apiKey.trim()
          : existing.apiKey,
      customContainers:
        settings.customContainers !== undefined
          ? this.normalizeCustomContainers(settings.customContainers)
          : existing.customContainers,
    });

    repository.save(STORAGE_KEY, next);
    this.cachedSettings = next;
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }

  static getConfigStatus(): SupermemoryConfigStatus {
    const settings = this.loadSettings();
    return {
      enabled: settings.enabled === true,
      apiKeyConfigured: typeof settings.apiKey === "string" && settings.apiKey.trim().length > 0,
      baseUrl: settings.baseUrl || DEFAULT_BASE_URL,
      containerTagTemplate: settings.containerTagTemplate || DEFAULT_CONTAINER_TEMPLATE,
      includeProfileInPrompt: settings.includeProfileInPrompt !== false,
      mirrorMemoryWrites: settings.mirrorMemoryWrites !== false,
      searchMode: settings.searchMode || "hybrid",
      rerank: settings.rerank !== false,
      threshold: this.normalizeThreshold(settings.threshold),
      customContainers: this.normalizeCustomContainers(settings.customContainers),
      circuitBreakerUntil: this.getCircuitBreakerUntil(),
      lastError: this.failureState.lastError,
      isConfigured: this.isConfigured(),
    };
  }

  static isConfigured(): boolean {
    const settings = this.loadSettings();
    return (
      settings.enabled === true &&
      typeof settings.apiKey === "string" &&
      settings.apiKey.trim().length > 0
    );
  }

  static async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request<SupermemoryProfileResponse>(
        "/v4/profile",
        {
          method: "POST",
          body: JSON.stringify({ containerTag: "cowork:healthcheck" }),
        },
        { timeoutMs: 8_000, ignoreCircuitBreaker: true },
      );
      this.recordSuccess();
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error?.message || "Failed to reach Supermemory",
      };
    }
  }

  static async getProfile(args: {
    workspace: SupermemoryWorkspaceRef;
    query?: string;
    containerTag?: string;
    threshold?: number;
  }): Promise<{
    containerTag: string;
    staticFacts: string[];
    dynamicFacts: string[];
    results: Array<{
      id?: string;
      text: string;
      similarity?: number;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }>;
    total: number;
  }> {
    const containerTag = this.resolveContainerTag(args.workspace, args.containerTag);
    const payload: Record<string, unknown> = {
      containerTag,
    };
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query) {
      payload.q = query;
      payload.threshold = this.normalizeThreshold(args.threshold ?? this.loadSettings().threshold);
    }
    const response = await this.request<SupermemoryProfileResponse>("/v4/profile", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const profile = response?.profile || {};
    const results = Array.isArray(response?.searchResults?.results)
      ? response.searchResults.results
          .map((item) => ({
            id: typeof item?.id === "string" ? item.id : undefined,
            text: this.pickResultText(item),
            similarity: typeof item?.similarity === "number" ? item.similarity : undefined,
            updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : undefined,
            metadata:
              item?.metadata && typeof item.metadata === "object"
                ? (item.metadata as Record<string, unknown>)
                : undefined,
          }))
          .filter((item) => item.text)
      : [];

    return {
      containerTag,
      staticFacts: Array.isArray(profile.static) ? profile.static.filter(Boolean) : [],
      dynamicFacts: Array.isArray(profile.dynamic) ? profile.dynamic.filter(Boolean) : [],
      results,
      total:
        typeof response?.searchResults?.total === "number"
          ? response.searchResults.total
          : results.length,
    };
  }

  static async search(args: {
    workspace: SupermemoryWorkspaceRef;
    query: string;
    containerTag?: string;
    limit?: number;
    threshold?: number;
    rerank?: boolean;
    searchMode?: SupermemorySearchMode;
  }): Promise<{
    containerTag: string;
    results: Array<{
      id?: string;
      text: string;
      similarity?: number;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }>;
    total: number;
    timingMs?: number;
  }> {
    const containerTag = this.resolveContainerTag(args.workspace, args.containerTag);
    const settings = this.loadSettings();
    const response = await this.request<SupermemorySearchResponse>("/v4/search", {
      method: "POST",
      body: JSON.stringify({
        q: args.query,
        containerTag,
        threshold: this.normalizeThreshold(args.threshold ?? settings.threshold),
        limit: Math.max(1, Math.min(25, Math.round(args.limit || 8))),
        rerank: args.rerank ?? settings.rerank !== false,
        searchMode: args.searchMode || settings.searchMode || "hybrid",
      }),
    });

    const results = Array.isArray(response?.results)
      ? response.results
          .map((item) => ({
            id: typeof item?.id === "string" ? item.id : undefined,
            text: this.pickResultText(item),
            similarity: typeof item?.similarity === "number" ? item.similarity : undefined,
            updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : undefined,
            metadata:
              item?.metadata && typeof item.metadata === "object"
                ? (item.metadata as Record<string, unknown>)
                : undefined,
          }))
          .filter((item) => item.text)
      : [];

    return {
      containerTag,
      results,
      total: typeof response?.total === "number" ? response.total : results.length,
      timingMs: typeof response?.timing === "number" ? response.timing : undefined,
    };
  }

  static async remember(args: {
    workspace: SupermemoryWorkspaceRef;
    content: string;
    containerTag?: string;
    metadata?: Record<string, unknown>;
    taskId?: string;
    origin?: MemoryWriteOrigin;
    skipMemoryWriteGate?: boolean;
  }): Promise<{
    containerTag: string;
    memoryIds: string[];
    staged?: boolean;
    pendingId?: string;
    blocked?: boolean;
    error?: string;
  }> {
    const containerTag = this.resolveContainerTag(args.workspace, args.containerTag);
    // The shared hygiene before anything leaves the device: `<no-memory>` refuses the write
    // and secret values are redacted (text that was only a secret is refused).
    if (containsNoMemoryDirective(args.content)) {
      return {
        containerTag,
        memoryIds: [],
        blocked: true,
        error: "The content opts out of memory (<no-memory>); nothing was saved externally.",
      };
    }
    const redaction = redactSecrets(args.content);
    if (
      redaction.count > 0 &&
      !/[\p{L}\p{N}]{3,}/u.test(redaction.text.split(REDACTED_SECRET).join(" "))
    ) {
      return {
        containerTag,
        memoryIds: [],
        blocked: true,
        error: "External memory write contained only a secret and was blocked.",
      };
    }
    args = { ...args, content: redaction.text };
    if (!args.skipMemoryWriteGate) {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: args.workspace.id,
        taskId: args.taskId,
        target: "external",
        action: "remember",
        origin: args.origin || "agent_tool",
        summary: "Save memory to Supermemory",
        payload: {
          content: args.content,
          containerTag,
          metadata: args.metadata || {},
        },
        proposedValue: args.content,
        reason:
          typeof args.metadata?.source === "string" ? `source:${args.metadata.source}` : undefined,
      });
      if (!gate.allowed) {
        if ("blocked" in gate) {
          return { containerTag, memoryIds: [], blocked: true, error: gate.error };
        }
        return { containerTag, memoryIds: [], staged: true, pendingId: gate.pendingId };
      }
    }

    const response = await this.request<SupermemoryRememberResponse>("/v4/memories", {
      method: "POST",
      body: JSON.stringify({
        containerTag,
        memories: [
          {
            content: args.content,
            metadata: args.metadata || {},
          },
        ],
      }),
    });

    const memoryIds = Array.isArray(response?.memories)
      ? response.memories
          .map((item) => (typeof item?.id === "string" ? item.id : ""))
          .filter(Boolean)
      : [];
    // Remote-only writes: kept so "Disconnect & purge" and workspace purges reach them.
    for (const memoryId of memoryIds) {
      await this.recordRemoteRef({
        localRef: `external:${memoryId}`,
        remoteId: memoryId,
        remoteKind: "memory",
        containerTag,
        workspaceId: args.workspace.id,
        taskId: args.taskId ?? null,
      });
    }
    return { containerTag, memoryIds };
  }

  static async forget(args: {
    workspace: SupermemoryWorkspaceRef;
    containerTag?: string;
    memoryId?: string;
    content?: string;
    reason?: string;
  }): Promise<{ containerTag: string; id?: string; forgotten: boolean }> {
    const containerTag = this.resolveContainerTag(args.workspace, args.containerTag);
    const response = await this.request<SupermemoryForgetResponse>("/v4/memories", {
      method: "DELETE",
      body: JSON.stringify({
        containerTag,
        ...(args.memoryId ? { id: args.memoryId } : {}),
        ...(args.content ? { content: args.content } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    });

    const forgotten = response?.forgotten === true;
    if (forgotten && args.memoryId) {
      const repository = SupermemoryRemoteRefRepository.get();
      try {
        const rows = (await repository?.findByRemoteIds([args.memoryId])) ?? [];
        await repository?.deleteByIds(rows.map((row) => row.id));
      } catch (error) {
        console.warn("[SupermemoryService] Could not drop the remote id mapping:", error);
      }
    }
    return {
      containerTag,
      id: typeof response?.id === "string" ? response.id : args.memoryId,
      forgotten,
    };
  }

  // ---------------------------------------------------------------------------
  // Remote ids (SEC-17): forget remote copies when the local record goes away.
  // ---------------------------------------------------------------------------

  private static orphanSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private static orphanSweepRunning: Promise<SupermemoryRemoteForgetResult | null> | null = null;

  private static async recordRemoteRef(input: {
    localRef: string;
    remoteId: string;
    remoteKind: "document" | "memory";
    containerTag: string;
    workspaceId?: string | null;
    taskId?: string | null;
  }): Promise<void> {
    const repository = SupermemoryRemoteRefRepository.get();
    if (!repository) return;
    try {
      await repository.record({ ...input, createdAt: Date.now() });
    } catch (error) {
      console.warn("[SupermemoryService] Could not record the remote id:", error);
    }
  }

  /** Delete one remote copy. A 404 means it is already gone, which counts as forgotten. */
  private static async deleteRemoteCopy(ref: SupermemoryRemoteRef): Promise<void> {
    try {
      if (ref.remoteKind === "document") {
        await this.request(`/v3/documents/${encodeURIComponent(ref.remoteId)}`, {
          method: "DELETE",
        });
      } else {
        await this.request<SupermemoryForgetResponse>("/v4/memories", {
          method: "DELETE",
          body: JSON.stringify({ containerTag: ref.containerTag, id: ref.remoteId }),
        });
      }
    } catch (error) {
      if (error instanceof SupermemoryRequestError && error.status === 404) return;
      throw error;
    }
  }

  /** Delete the given remote copies; mappings of the deleted ones are dropped. */
  static async forgetRemoteCopies(refs: SupermemoryRemoteRef[]): Promise<SupermemoryRemoteForgetResult> {
    const result: SupermemoryRemoteForgetResult = { forgotten: 0, failed: 0, errors: [] };
    const repository = SupermemoryRemoteRefRepository.get();
    const done: number[] = [];
    for (const ref of refs) {
      try {
        await this.deleteRemoteCopy(ref);
        done.push(ref.id);
        result.forgotten += 1;
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < 5) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (repository && done.length > 0) await repository.deleteByIds(done);
    return result;
  }

  /**
   * Forget every remote copy whose local record was deleted, suppressed, redacted or made
   * private (supermemory-remote-refs-sql.ts `listOrphans`). Runs only while Supermemory is
   * connected; otherwise the mappings wait for the next connected sweep or a purge.
   */
  static async sweepOrphanedCopies(): Promise<SupermemoryRemoteForgetResult | null> {
    const repository = SupermemoryRemoteRefRepository.get();
    if (!repository || !this.isConfigured()) return null;
    const total: SupermemoryRemoteForgetResult = { forgotten: 0, failed: 0, errors: [] };
    for (let page = 0; page < 20; page += 1) {
      const orphans = await repository.listOrphans(REMOTE_FORGET_PAGE);
      if (orphans.length === 0) break;
      const result = await this.forgetRemoteCopies(orphans);
      total.forgotten += result.forgotten;
      total.failed += result.failed;
      total.errors.push(...result.errors.slice(0, 5 - total.errors.length));
      // Stop when a page made no progress (service down): the rows stay for the next sweep.
      if (result.forgotten === 0 || orphans.length < REMOTE_FORGET_PAGE) break;
    }
    return total;
  }

  /**
   * Schedule an orphan sweep after a local delete (debounced, fire-and-forget). Called by
   * the delete paths: archive deletes and inspector suppression, memory item deletes,
   * task-delete and workspace purges.
   */
  static scheduleOrphanSweep(): void {
    if (!SupermemoryRemoteRefRepository.get() || this.orphanSweepTimer) return;
    this.orphanSweepTimer = setTimeout(() => {
      this.orphanSweepTimer = null;
      if (this.orphanSweepRunning) {
        // A sweep is running; sweep again once it finishes.
        void this.orphanSweepRunning.finally(() => this.scheduleOrphanSweep());
        return;
      }
      this.orphanSweepRunning = this.sweepOrphanedCopies()
        .catch((error) => {
          console.warn("[SupermemoryService] Remote forget sweep failed:", error);
          return null;
        })
        .finally(() => {
          this.orphanSweepRunning = null;
        });
    }, ORPHAN_SWEEP_DELAY_MS);
    this.orphanSweepTimer.unref?.();
  }

  /** Forget every remote copy recorded for one workspace (Clear All Memories). */
  static async forgetWorkspaceCopies(workspaceId: string): Promise<SupermemoryRemoteForgetResult> {
    const repository = SupermemoryRemoteRefRepository.get();
    if (!repository) return { forgotten: 0, failed: 0, errors: [] };
    if (!this.isConfigured()) {
      const pending = await repository.list({ workspaceId, limit: 10_000 });
      return { forgotten: 0, failed: pending.length, errors: [] };
    }
    return this.forgetAllRecorded(workspaceId);
  }

  private static async forgetAllRecorded(
    workspaceId?: string,
  ): Promise<SupermemoryRemoteForgetResult> {
    const total: SupermemoryRemoteForgetResult = { forgotten: 0, failed: 0, errors: [] };
    const repository = SupermemoryRemoteRefRepository.get();
    if (!repository) return total;
    const attempted = new Set<number>();
    for (;;) {
      const rows = (
        await repository.list({ workspaceId: workspaceId ?? null, limit: REMOTE_FORGET_PAGE })
      ).filter((row) => !attempted.has(row.id));
      if (rows.length === 0) break;
      for (const row of rows) attempted.add(row.id);
      const result = await this.forgetRemoteCopies(rows);
      total.forgotten += result.forgotten;
      total.failed += result.failed;
      total.errors.push(...result.errors.slice(0, 5 - total.errors.length));
    }
    return total;
  }

  /**
   * "Disconnect & purge": delete every remote copy CoWork recorded, then disable the
   * integration. When a copy cannot be deleted the integration stays enabled (so the purge
   * can be retried) and the failure is reported.
   */
  static async disconnectAndPurge(): Promise<
    SupermemoryRemoteForgetResult & { success: boolean; disabled: boolean; error?: string }
  > {
    const repository = SupermemoryRemoteRefRepository.get();
    const pending = repository ? await repository.count() : 0;
    if (pending > 0 && !this.isConfigured()) {
      return {
        success: false,
        disabled: false,
        forgotten: 0,
        failed: pending,
        errors: [],
        error:
          "Supermemory is not connected, so its copies cannot be deleted. Reconnect it first, then purge.",
      };
    }
    const result = await this.forgetAllRecorded();
    if (result.failed > 0) {
      return {
        ...result,
        success: false,
        disabled: false,
        error: `${result.failed} remote ${result.failed === 1 ? "copy" : "copies"} could not be deleted; Supermemory stays connected so you can retry.`,
      };
    }
    this.saveSettings({ ...this.loadSettings(), enabled: false });
    return { ...result, success: true, disabled: true };
  }

  static async mirrorMemory(args: {
    workspace: SupermemoryWorkspaceRef;
    taskId?: string;
    memoryType: string;
    content: string;
    createdAt?: number;
    origin?: MemoryWriteOrigin;
    skipMemoryWriteGate?: boolean;
    /** The local record this copies (`archive:<id>`), so deleting it forgets the copy. */
    localRef?: string;
  }): Promise<void> {
    const settings = this.loadSettings();
    if (!this.isConfigured() || settings.mirrorMemoryWrites === false) {
      return;
    }

    const containerTag = this.resolveContainerTag(args.workspace);
    if (!args.skipMemoryWriteGate) {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: args.workspace.id,
        taskId: args.taskId,
        target: "external",
        action: "mirror",
        origin: args.origin || "external_mirror",
        summary: `Mirror ${args.memoryType} memory to Supermemory`,
        payload: {
          content: args.content,
          containerTag,
          memoryType: args.memoryType,
          createdAt: args.createdAt || Date.now(),
          ...(args.localRef ? { localRef: args.localRef } : {}),
        },
        proposedValue: args.content,
      });
      if (!gate.allowed) return;
    }

    const response = await this.request<SupermemoryDocumentResponse>(
      "/v3/documents",
      {
        method: "POST",
        body: JSON.stringify({
          content: args.content,
          containerTag,
          metadata: {
            source: "cowork_memory",
            workspaceId: args.workspace.id,
            workspaceName: args.workspace.name,
            taskId: args.taskId,
            memoryType: args.memoryType,
            createdAt: args.createdAt || Date.now(),
          },
        }),
      },
      { timeoutMs: 10_000 },
    );
    const documentId = typeof response?.id === "string" ? response.id.trim() : "";
    if (documentId && args.localRef) {
      await this.recordRemoteRef({
        localRef: args.localRef,
        remoteId: documentId,
        remoteKind: "document",
        containerTag,
        workspaceId: args.workspace.id,
        taskId: args.taskId ?? null,
      });
    }
  }

  static async buildPromptContext(args: {
    workspace: SupermemoryWorkspaceRef;
    query: string;
    containerTag?: string;
  }): Promise<string> {
    const settings = this.loadSettings();
    if (!this.isConfigured() || settings.includeProfileInPrompt === false) {
      return "";
    }

    const profile = await this.getProfile({
      workspace: args.workspace,
      query: args.query,
      containerTag: args.containerTag,
      threshold: settings.threshold,
    });

    const lines: string[] = [];
    if (profile.staticFacts.length > 0) {
      lines.push("Static facts:");
      for (const entry of profile.staticFacts.slice(0, 5)) {
        lines.push(`- ${entry}`);
      }
    }
    if (profile.dynamicFacts.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("Recent context:");
      for (const entry of profile.dynamicFacts.slice(0, 5)) {
        lines.push(`- ${entry}`);
      }
    }
    if (profile.results.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("Relevant external memories:");
      for (const entry of profile.results.slice(0, 4)) {
        lines.push(`- ${entry.text}`);
      }
    }
    if (lines.length === 0) return "";

    return [
      "SUPERMEMORY PROFILE (external memory, workspace-scoped):",
      "- Treat as helpful prior context, not ground truth over the current user message.",
      `- Container: ${profile.containerTag}`,
      ...lines,
    ].join("\n");
  }

  static resolveContainerTag(workspace: SupermemoryWorkspaceRef, override?: string): string {
    const explicit = typeof override === "string" ? override.trim() : "";
    if (explicit) {
      const explicitTag = this.sanitizeContainerTag(explicit);
      if (!this.isAllowedContainerTagOverride(workspace, explicitTag)) {
        throw new Error("Supermemory containerTag override is not allowed for this workspace.");
      }
      return explicitTag;
    }

    const settings = this.loadSettings();
    const template = settings.containerTagTemplate || DEFAULT_CONTAINER_TEMPLATE;
    const rendered = template
      .replace(/\{workspaceId\}/g, workspace.id || "workspace")
      .replace(/\{workspaceName\}/g, workspace.name || "workspace");
    return this.sanitizeContainerTag(rendered);
  }

  private static normalizeSettings(settings?: SupermemorySettings | null): SupermemorySettings {
    const next: Partial<SupermemorySettings> = settings ?? {};
    return {
      enabled: next.enabled === true,
      apiKey: typeof next.apiKey === "string" ? next.apiKey.trim() : undefined,
      baseUrl: this.normalizeBaseUrl(next.baseUrl),
      containerTagTemplate:
        typeof next.containerTagTemplate === "string" && next.containerTagTemplate.trim()
          ? next.containerTagTemplate.trim()
          : DEFAULT_CONTAINER_TEMPLATE,
      includeProfileInPrompt: next.includeProfileInPrompt !== false,
      mirrorMemoryWrites: next.mirrorMemoryWrites !== false,
      searchMode: next.searchMode === "memories" ? "memories" : "hybrid",
      rerank: next.rerank !== false,
      threshold: this.normalizeThreshold(next.threshold),
      customContainers: this.normalizeCustomContainers(next.customContainers),
    };
  }

  private static normalizeBaseUrl(baseUrl?: string): string {
    const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
    if (!trimmed) return DEFAULT_BASE_URL;
    const normalized = trimmed.replace(/\/+$/, "");
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "https:") {
        return DEFAULT_BASE_URL;
      }
      if (parsed.hostname !== "api.supermemory.ai") {
        return DEFAULT_BASE_URL;
      }
      return parsed.origin;
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  private static normalizeThreshold(value?: number): number {
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.threshold;
    return Math.max(0, Math.min(1, Number(value)));
  }

  private static normalizeCustomContainers(
    containers?: SupermemoryCustomContainer[],
  ): SupermemoryCustomContainer[] {
    if (!Array.isArray(containers)) return [];
    const normalized: SupermemoryCustomContainer[] = [];
    for (const entry of containers) {
      const rawTag = String(entry?.tag || "").trim();
      if (!rawTag) continue;
      normalized.push({
        tag: this.sanitizeContainerTag(rawTag),
        description:
          typeof entry?.description === "string"
            ? entry.description.trim().slice(0, 240)
            : undefined,
      });
    }
    return normalized;
  }

  private static sanitizeContainerTag(input: string): string {
    const safe = String(input || "")
      .trim()
      .replace(/\{[^}]+\}/g, "")
      .replace(/[^a-zA-Z0-9_:-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100);
    return safe || "cowork-workspace";
  }

  private static isAllowedContainerTagOverride(
    workspace: SupermemoryWorkspaceRef,
    explicitTag: string,
  ): boolean {
    const settings = this.loadSettings();
    const defaultTag = this.sanitizeContainerTag(
      (settings.containerTagTemplate || DEFAULT_CONTAINER_TEMPLATE)
        .replace(/\{workspaceId\}/g, workspace.id || "workspace")
        .replace(/\{workspaceName\}/g, workspace.name || "workspace"),
    );
    if (explicitTag === defaultTag) {
      return true;
    }
    return this.normalizeCustomContainers(settings.customContainers).some(
      (container) => container.tag === explicitTag,
    );
  }

  private static pickResultText(item: { memory?: string; chunk?: string }): string {
    return String(item?.memory || item?.chunk || "").trim();
  }

  private static getCircuitBreakerUntil(): number | null {
    const until = this.failureState.circuitBreakerUntil;
    if (!until) return null;
    if (Date.now() >= until) {
      this.failureState.circuitBreakerUntil = null;
      this.failureState.consecutiveFailures = 0;
      this.failureState.firstFailureAt = null;
      return null;
    }
    return until;
  }

  private static recordSuccess(): void {
    this.failureState = {
      consecutiveFailures: 0,
      firstFailureAt: null,
      circuitBreakerUntil: null,
      lastError: null,
    };
  }

  private static recordFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    const now = Date.now();
    const withinWindow =
      this.failureState.firstFailureAt !== null &&
      now - this.failureState.firstFailureAt <= FAILURE_WINDOW_MS;
    const nextFailures = withinWindow ? this.failureState.consecutiveFailures + 1 : 1;
    this.failureState = {
      consecutiveFailures: nextFailures,
      firstFailureAt: withinWindow ? this.failureState.firstFailureAt : now,
      circuitBreakerUntil:
        nextFailures >= MAX_FAILURES_BEFORE_OPEN ? now + CIRCUIT_BREAKER_COOLDOWN_MS : null,
      lastError: message,
    };
  }

  private static async request<T>(
    endpoint: string,
    init: RequestInit,
    options?: { timeoutMs?: number; ignoreCircuitBreaker?: boolean },
  ): Promise<T> {
    const settings = this.loadSettings();
    if (!settings.enabled) {
      throw new Error("Supermemory integration is disabled in Settings > Memory.");
    }
    if (!settings.apiKey) {
      throw new Error("Supermemory API key is not configured.");
    }
    if (!options?.ignoreCircuitBreaker && this.getCircuitBreakerUntil()) {
      throw new Error("Supermemory is temporarily paused after repeated request failures.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs || 5_000);
    try {
      const response = await fetch(`${settings.baseUrl || DEFAULT_BASE_URL}${endpoint}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new SupermemoryRequestError(
          `Supermemory request failed (${response.status}): ${bodyText || response.statusText || "Unknown error"}`,
          response.status,
        );
      }

      const json = (await response.json().catch(() => ({}))) as T;
      this.recordSuccess();
      return json;
    } catch (error) {
      if (!options?.ignoreCircuitBreaker && countsTowardCircuitBreaker(error)) {
        this.recordFailure(error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
