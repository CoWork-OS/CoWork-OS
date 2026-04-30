import type {
  SupermemoryConfigStatus,
  SupermemoryCustomContainer,
  SupermemorySearchMode,
  SupermemorySettings,
} from "../../shared/types";
import type { Workspace } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

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
    return settings.enabled === true && typeof settings.apiKey === "string" && settings.apiKey.trim().length > 0;
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
      total: typeof response?.searchResults?.total === "number" ? response.searchResults.total : results.length,
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
  }): Promise<{ containerTag: string; memoryIds: string[] }> {
    const containerTag = this.resolveContainerTag(args.workspace, args.containerTag);
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

    return {
      containerTag,
      memoryIds: Array.isArray(response?.memories)
        ? response.memories
            .map((item) => (typeof item?.id === "string" ? item.id : ""))
            .filter(Boolean)
        : [],
    };
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

    return {
      containerTag,
      id: typeof response?.id === "string" ? response.id : args.memoryId,
      forgotten: response?.forgotten === true,
    };
  }

  static async mirrorMemory(args: {
    workspace: SupermemoryWorkspaceRef;
    taskId?: string;
    memoryType: string;
    content: string;
    createdAt?: number;
  }): Promise<void> {
    const settings = this.loadSettings();
    if (!this.isConfigured() || settings.mirrorMemoryWrites === false) {
      return;
    }

    const containerTag = this.resolveContainerTag(args.workspace);
    await this.request(
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

  private static pickResultText(item: {
    memory?: string;
    chunk?: string;
  }): string {
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
        throw new Error(
          `Supermemory request failed (${response.status}): ${bodyText || response.statusText || "Unknown error"}`,
        );
      }

      const json = (await response.json().catch(() => ({}))) as T;
      this.recordSuccess();
      return json;
    } catch (error) {
      if (!options?.ignoreCircuitBreaker) {
        this.recordFailure(error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
