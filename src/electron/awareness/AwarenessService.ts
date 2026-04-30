import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash, randomUUID } from "crypto";
import { clipboard } from "electron";
import {
  AwarenessBelief,
  AwarenessBeliefType,
  AwarenessConfig,
  AwarenessEvent,
  AwarenessSensitivity,
  AwarenessSnapshot,
  AwarenessSource,
  AwarenessSummary,
  AwarenessSummaryItem,
  AwarenessWakeReason,
  AddUserFactRequest,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { loadNotificationStoreSync } from "../notifications/store";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { UserProfileService } from "../memory/UserProfileService";

const execFileAsync = promisify(execFile);
const STORAGE_KEY = "awareness-state";
const DEFAULT_TTL_MINUTES = 240;
const DEVICE_POLL_MS = 20_000;
const EVENT_BUFFER_LIMIT = 500;
const HIGH_SENSITIVITY_SOURCES = new Set<AwarenessSource>([
  "clipboard",
  "notifications",
  "browser",
]);
const BROWSER_APPS = new Set([
  "Google Chrome",
  "Chrome",
  "Safari",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Firefox",
]);

interface PersistedAwarenessState {
  config: AwarenessConfig;
  beliefs: AwarenessBelief[];
}

interface AwarenessServiceDeps {
  getDefaultWorkspaceId?: () => string | undefined;
  onWakeHeartbeats?: (params: { text: string; mode?: "now" | "next-heartbeat" }) => void;
  onEventCaptured?: (event: AwarenessEvent) => void;
  log?: (...args: unknown[]) => void;
}

function buildDefaultPolicy(
  overrides: Partial<AwarenessConfig["sources"][AwarenessSource]> = {},
): AwarenessConfig["sources"][AwarenessSource] {
  return {
    enabled: true,
    ttlMinutes: DEFAULT_TTL_MINUTES,
    allowPromotion: true,
    allowPromptInjection: true,
    allowHeartbeat: true,
    ...overrides,
  };
}

export const DEFAULT_AWARENESS_CONFIG: AwarenessConfig = {
  privateModeEnabled: false,
  defaultTtlMinutes: DEFAULT_TTL_MINUTES,
  sources: {
    conversation: buildDefaultPolicy({ ttlMinutes: 12 * 60 }),
    feedback: buildDefaultPolicy({ ttlMinutes: 24 * 60 }),
    files: buildDefaultPolicy(),
    git: buildDefaultPolicy(),
    apps: buildDefaultPolicy(),
    browser: buildDefaultPolicy({ ttlMinutes: 120 }),
    calendar: buildDefaultPolicy({ ttlMinutes: 12 * 60 }),
    notifications: buildDefaultPolicy({ ttlMinutes: 120, allowPromptInjection: false }),
    clipboard: buildDefaultPolicy({ ttlMinutes: 30, allowPromptInjection: false }),
    tasks: buildDefaultPolicy({ ttlMinutes: 24 * 60 }),
  },
};

function defaultPersistedState(): PersistedAwarenessState {
  return {
    config: JSON.parse(JSON.stringify(DEFAULT_AWARENESS_CONFIG)) as AwarenessConfig,
    beliefs: [],
  };
}

function truncate(value: string, max = 180): string {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function fingerprint(parts: Array<string | number | undefined>): string {
  return createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function redactSensitiveText(text: string): { summary: string; sensitivity: AwarenessSensitivity } {
  const normalized = truncate(text, 160);
  if (!normalized) {
    return { summary: "Clipboard updated", sensitivity: "medium" };
  }
  if (
    /sk-[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]+|token|password|secret|-----BEGIN/i.test(normalized) ||
    normalized.length > 200
  ) {
    return {
      summary: `Clipboard updated (${normalized.length} chars, redacted)`,
      sensitivity: "high",
    };
  }
  return {
    summary: `Clipboard updated: ${truncate(normalized, 80)}`,
    sensitivity: "medium",
  };
}

function normalizeProjectHint(filePath: string): string | null {
  const parts = String(filePath || "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const idx = parts.findIndex((part) => part === "src" || part === ".cowork" || part === "app");
  if (idx > 0) return parts[idx - 1] || null;
  return parts[0] || null;
}

function isHighSensitivitySource(source: AwarenessSource): boolean {
  return HIGH_SENSITIVITY_SOURCES.has(source);
}

export class AwarenessService {
  private static instance: AwarenessService | null = null;
  private deps: AwarenessServiceDeps;
  private events: AwarenessEvent[] = [];
  private state: PersistedAwarenessState = defaultPersistedState();
  private loaded = false;
  private started = false;
  private devicePollTimer: NodeJS.Timeout | null = null;
  private lastClipboardFingerprint = "";
  private lastForegroundFingerprint = "";
  private lastNotificationFingerprint = "";

  constructor(deps: AwarenessServiceDeps = {}) {
    this.deps = deps;
  }

  static initialize(deps: AwarenessServiceDeps = {}): AwarenessService {
    if (!this.instance) {
      this.instance = new AwarenessService(deps);
    } else {
      this.instance.deps = deps;
    }
    return this.instance;
  }

  static getInstance(): AwarenessService {
    return this.instance || this.initialize();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.ensureLoaded();
    this.pollDeviceContext().catch(() => {});
    this.devicePollTimer = setInterval(() => {
      void this.pollDeviceContext().catch(() => {});
    }, DEVICE_POLL_MS);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.devicePollTimer) clearInterval(this.devicePollTimer);
    this.devicePollTimer = null;
  }

  getConfig(): AwarenessConfig {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.state.config)) as AwarenessConfig;
  }

  saveConfig(config: AwarenessConfig): AwarenessConfig {
    this.ensureLoaded();
    this.state.config = {
      ...DEFAULT_AWARENESS_CONFIG,
      ...config,
      sources: {
        ...DEFAULT_AWARENESS_CONFIG.sources,
        ...config.sources,
      },
    };
    this.save();
    return this.getConfig();
  }

  listBeliefs(workspaceId?: string): AwarenessBelief[] {
    this.ensureLoaded();
    return this.state.beliefs
      .filter((belief) => !workspaceId || belief.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((belief) => ({ ...belief, evidenceRefs: [...belief.evidenceRefs] }));
  }

  updateBelief(
    id: string,
    patch: Partial<Pick<AwarenessBelief, "confidence" | "promotionStatus" | "value">>,
  ): AwarenessBelief | null {
    this.ensureLoaded();
    const belief = this.state.beliefs.find((entry) => entry.id === id);
    if (!belief) return null;
    if (typeof patch.value === "string" && patch.value.trim()) belief.value = truncate(patch.value, 220);
    if (typeof patch.confidence === "number" && Number.isFinite(patch.confidence)) {
      belief.confidence = Math.max(0, Math.min(1, patch.confidence));
    }
    if (
      patch.promotionStatus === "observed" ||
      patch.promotionStatus === "promoted" ||
      patch.promotionStatus === "confirmed"
    ) {
      belief.promotionStatus = patch.promotionStatus;
      if (patch.promotionStatus === "confirmed") {
        belief.lastConfirmedAt = Date.now();
      }
    }
    belief.updatedAt = Date.now();
    this.save();
    return { ...belief, evidenceRefs: [...belief.evidenceRefs] };
  }

  deleteBelief(id: string): boolean {
    this.ensureLoaded();
    const before = this.state.beliefs.length;
    this.state.beliefs = this.state.beliefs.filter((belief) => belief.id !== id);
    const deleted = this.state.beliefs.length !== before;
    if (deleted) this.save();
    return deleted;
  }

  listEvents(params: { workspaceId?: string; limit?: number } = {}): AwarenessEvent[] {
    this.pruneExpiredEvents();
    const limit = Math.max(1, params.limit ?? 50);
    return this.events
      .filter((event) => !params.workspaceId || event.workspaceId === params.workspaceId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((event) => ({ ...event, payload: event.payload ? { ...event.payload } : undefined }));
  }

  getSnapshot(workspaceId?: string): AwarenessSnapshot {
    const summary = this.getSummary(workspaceId);
    const recentEvents = this.listEvents({ workspaceId, limit: 40 }).filter(
      (event) => this.state.config.sources[event.source]?.allowPromptInjection,
    );
    const activeAppEvent = recentEvents.find((event) => event.source === "apps");
    const browserEvent = recentEvents.find((event) => event.source === "browser");
    const recentFiles = recentEvents
      .filter((event) => event.source === "files")
      .map((event) => String(event.payload?.path || event.summary))
      .filter(Boolean)
      .slice(0, 6);
    const recentProjects = recentFiles
      .map((filePath) => normalizeProjectHint(filePath))
      .filter((value): value is string => !!value)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .slice(0, 4);
    const recentIntents = recentEvents
      .filter((event) => event.source === "conversation" || event.source === "feedback")
      .map((event) => event.summary)
      .slice(0, 4);
    const dueSoon = summary.dueSoon.map((item) => item.title).slice(0, 4);
    const beliefLines = summary.beliefs
      .slice(0, 6)
      .map((belief) => `- ${belief.subject}: ${belief.value}`)
      .join("\n");
    const text = [
      "<cowork_awareness_snapshot>",
      summary.currentFocus ? `Current focus: ${summary.currentFocus}` : "",
      activeAppEvent ? `Active app: ${activeAppEvent.title}` : "",
      browserEvent ? `Browser context: ${browserEvent.summary}` : "",
      recentFiles.length > 0 ? `Recent files: ${recentFiles.join(" | ")}` : "",
      recentProjects.length > 0 ? `Recent projects: ${recentProjects.join(" | ")}` : "",
      dueSoon.length > 0 ? `Due soon: ${dueSoon.join(" | ")}` : "",
      beliefLines ? `Beliefs:\n${beliefLines}` : "",
      "</cowork_awareness_snapshot>",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      generatedAt: Date.now(),
      workspaceId,
      currentFocus: summary.currentFocus,
      activeApp: activeAppEvent?.title,
      activeWindowTitle: typeof activeAppEvent?.payload?.windowTitle === "string"
        ? String(activeAppEvent.payload.windowTitle)
        : undefined,
      browserContext: browserEvent?.summary,
      recentFiles,
      recentProjects,
      recentIntents,
      dueSoon,
      beliefs: summary.beliefs.slice(0, 8),
      text,
    };
  }

  getSummary(workspaceId?: string): AwarenessSummary {
    this.pruneExpiredEvents();
    const events = this.events
      .filter((event) => !workspaceId || event.workspaceId === workspaceId)
      .sort((a, b) => b.timestamp - a.timestamp);
    const beliefs = this.listBeliefs(workspaceId).slice(0, 10);
    const whatChanged = events.slice(0, 6).map((event) => this.toSummaryItem(event));
    const whatMattersNow = whatChanged
      .filter((item) => item.score >= 0.65 || item.tags.includes("focus"))
      .slice(0, 5);
    // RelationshipMemoryItem has no workspaceId; show all due-soon (we cannot filter by workspace)
    const dueSoonCommitments = RelationshipMemoryService.listDueSoonCommitments(72)
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        title: item.text,
        detail: item.dueAt ? `Due ${new Date(item.dueAt).toLocaleString()}` : "Due soon",
        source: "tasks" as AwarenessSource,
        workspaceId,
        score: 0.9,
        tags: ["due_soon", "commitment"],
        requiresHeartbeat: true,
      }));
    const wakeReasons = new Set<AwarenessWakeReason>();
    for (const item of [...whatMattersNow, ...dueSoonCommitments]) {
      for (const tag of item.tags) {
        if (tag === "focus") wakeReasons.add("focus_shift");
        if (tag === "context") wakeReasons.add("context_shift");
        if (tag === "due_soon" || tag === "deadline") wakeReasons.add("deadline_risk");
        if (tag === "workflow") wakeReasons.add("repeated_workflow");
      }
      if (item.requiresHeartbeat) wakeReasons.add("due_soon");
    }
    const currentFocus = events.find((event) =>
      event.source === "apps" ||
      event.source === "browser" ||
      event.source === "tasks" ||
      event.source === "conversation"
    )?.summary;

    return {
      generatedAt: Date.now(),
      workspaceId,
      currentFocus,
      whatChanged,
      whatMattersNow,
      dueSoon: dueSoonCommitments,
      beliefs,
      wakeReasons: Array.from(wakeReasons),
    };
  }

  captureEvent(input: Omit<AwarenessEvent, "id" | "fingerprint" | "timestamp"> & {
    timestamp?: number;
  }): AwarenessEvent | null {
    this.ensureLoaded();
    const policy = this.state.config.sources[input.source];
    if (!policy?.enabled) return null;
    if (this.state.config.privateModeEnabled && isHighSensitivitySource(input.source)) {
      return null;
    }

    const timestamp = input.timestamp ?? Date.now();
    const summary = truncate(input.summary, 220);
    const title = truncate(input.title, 120) || summary || input.source;
    const id = randomUUID();
    const event: AwarenessEvent = {
      id,
      source: input.source,
      timestamp,
      workspaceId: input.workspaceId,
      title,
      summary,
      sensitivity: input.sensitivity,
      fingerprint: fingerprint([input.source, input.workspaceId, title, summary]),
      payload: input.payload ? { ...input.payload } : undefined,
      tags: input.tags ? [...input.tags] : [],
    };

    const existingIndex = this.events.findIndex(
      (entry) =>
        entry.fingerprint === event.fingerprint &&
        Math.abs(entry.timestamp - event.timestamp) < 30_000,
    );
    if (existingIndex >= 0) {
      this.events[existingIndex] = event;
    } else {
      this.events.push(event);
      if (this.events.length > EVENT_BUFFER_LIMIT) {
        this.events = this.events.sort((a, b) => b.timestamp - a.timestamp).slice(0, EVENT_BUFFER_LIMIT);
      }
    }

    if (policy.allowPromotion) {
      this.promoteEvent(event);
    }

    if (policy.allowHeartbeat && this.shouldWakeFromEvent(event)) {
      this.deps.onWakeHeartbeats?.({
        text: `Awareness detected ${event.source}: ${event.summary}`,
        mode: "next-heartbeat",
      });
    }

    this.deps.onEventCaptured?.(event);

    return event;
  }

  captureConversation(message: string, workspaceId?: string, taskId?: string): void {
    const text = truncate(message, 220);
    if (!text) return;
    this.captureEvent({
      source: "conversation",
      workspaceId,
      title: "User message",
      summary: text,
      sensitivity: "low",
      payload: taskId ? { taskId } : undefined,
      tags: ["intent"],
    });
  }

  captureFeedback(reason?: string, workspaceId?: string, taskId?: string): void {
    const text = truncate(reason || "", 220);
    if (!text) return;
    this.captureEvent({
      source: "feedback",
      workspaceId,
      title: "User feedback",
      summary: text,
      sensitivity: "low",
      payload: taskId ? { taskId } : undefined,
      tags: ["feedback"],
    });
  }

  captureTaskCompletion(workspaceId: string, title: string, resultSummary?: string, taskId?: string): void {
    const summary = truncate(resultSummary || title, 220);
    this.captureEvent({
      source: "tasks",
      workspaceId,
      title: `Task completed: ${truncate(title, 100)}`,
      summary,
      sensitivity: "low",
      payload: taskId ? { taskId } : undefined,
      tags: ["workflow"],
    });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!SecureSettingsRepository.isInitialized()) {
      this.state = defaultPersistedState();
      return;
    }
    try {
      const repo = SecureSettingsRepository.getInstance();
      const stored = repo.load<PersistedAwarenessState>(STORAGE_KEY);
      this.state = stored
        ? {
            config: {
              ...DEFAULT_AWARENESS_CONFIG,
              ...stored.config,
              sources: {
                ...DEFAULT_AWARENESS_CONFIG.sources,
                ...stored.config?.sources,
              },
            },
            beliefs: Array.isArray(stored.beliefs) ? stored.beliefs : [],
          }
        : defaultPersistedState();
    } catch {
      this.state = defaultPersistedState();
    }
  }

  private save(): void {
    if (!SecureSettingsRepository.isInitialized()) return;
    try {
      const repo = SecureSettingsRepository.getInstance();
      repo.save(STORAGE_KEY, this.state);
    } catch {
      // best-effort
    }
  }

  private pruneExpiredEvents(): void {
    this.ensureLoaded();
    const now = Date.now();
    this.events = this.events.filter((event) => {
      const ttlMinutes = this.state.config.sources[event.source]?.ttlMinutes ?? this.state.config.defaultTtlMinutes;
      return now - event.timestamp <= ttlMinutes * 60 * 1000;
    });
  }

  private toSummaryItem(event: AwarenessEvent): AwarenessSummaryItem {
    const tags = [...(event.tags || [])];
    let score = 0.55;
    if (event.source === "apps" || event.source === "browser") {
      score = 0.72;
      tags.push("focus");
    }
    if (event.source === "calendar") {
      score = 0.8;
      tags.push("deadline");
    }
    if (event.source === "tasks") {
      score = 0.7;
      tags.push("workflow");
    }
    if (event.source === "files" || event.source === "git") {
      score = 0.68;
      tags.push("context");
    }
    return {
      id: event.id,
      title: event.title,
      detail: event.summary,
      source: event.source,
      workspaceId: event.workspaceId,
      score,
      tags,
      requiresHeartbeat: score >= 0.75,
    };
  }

  private shouldWakeFromEvent(event: AwarenessEvent): boolean {
    if (event.source === "calendar") return true;
    if (event.source === "apps" || event.source === "browser") return true;
    if ((event.tags || []).includes("workflow")) return true;
    return false;
  }

  private promoteEvent(event: AwarenessEvent): void {
    if (event.source === "conversation" || event.source === "feedback") {
      for (const candidate of this.extractBeliefsFromText(event)) {
        this.upsertBelief(candidate);
      }
      return;
    }

    if (event.source === "apps") {
      const appName = String(event.payload?.appName || event.title || "").trim();
      if (appName) {
        this.maybePromoteRepeatedEvent(event, "device_context", "active_app", `Frequently active in ${appName}`);
      }
      return;
    }

    if (event.source === "browser") {
      this.maybePromoteRepeatedEvent(
        event,
        "workflow_habit",
        "browser_context",
        `Repeated browser research context: ${event.summary}`,
      );
      return;
    }

    if (event.source === "files") {
      const project = normalizeProjectHint(String(event.payload?.path || ""));
      if (project) {
        this.maybePromoteRepeatedEvent(
          event,
          "project_affinity",
          "project",
          `Frequently active in project ${project}`,
        );
      }
      return;
    }

    if (event.source === "tasks") {
      this.maybePromoteRepeatedEvent(
        event,
        "workflow_habit",
        "task_pattern",
        `Recurring workflow: ${event.summary}`,
      );
    }
  }

  private maybePromoteRepeatedEvent(
    event: AwarenessEvent,
    beliefType: AwarenessBeliefType,
    subject: string,
    value: string,
  ): void {
    const now = Date.now();
    const matches = this.events.filter(
      (entry) =>
        entry.source === event.source &&
        entry.fingerprint === event.fingerprint &&
        now - entry.timestamp <= 24 * 60 * 60 * 1000,
    );
    if (matches.length < 2) return;
    this.upsertBelief({
      beliefType,
      subject,
      value,
      confidence: Math.min(0.92, 0.55 + matches.length * 0.1),
      evidenceRefs: matches.map((item) => item.id).slice(0, 6),
      workspaceId: event.workspaceId,
      source: event.source,
      promotionStatus: "promoted",
    });
  }

  private extractBeliefsFromText(event: AwarenessEvent): AwarenessBelief[] {
    const text = event.summary;
    const beliefs: AwarenessBelief[] = [];
    const push = (data: Omit<AwarenessBelief, "id" | "createdAt" | "updatedAt">) => {
      beliefs.push({
        ...data,
        id: randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    };

    // Match names: single word (capitalized), multi-word, hyphenated (O'Brien), non-ASCII
    const preferredNameMatch = text.match(
      /\b(?:call me|my name is|i'm|i am)\s+([A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z\u00C0-\u024F\u1E00-\u1EFF'\s-]{1,50})\b/u,
    );
    if (preferredNameMatch) {
      const name = preferredNameMatch[1].trim().replace(/\s+/g, " ");
      if (name) {
        push({
          beliefType: "user_fact",
          subject: "preferred_name",
          value: `Preferred name: ${truncate(name, 80)}`,
          confidence: 0.85,
          evidenceRefs: [event.id],
          workspaceId: event.workspaceId,
          source: event.source,
          promotionStatus: "promoted",
        });
      }
    }

    const preferenceMatch = text.match(/\b(?:i prefer|please always|please don't|i like|i dislike)\s+([^.!?\n]{3,120})/i);
    if (preferenceMatch) {
      push({
        beliefType: "user_preference",
        subject: "style_or_preference",
        value: truncate(preferenceMatch[0], 180),
        confidence: event.source === "feedback" ? 0.9 : 0.78,
        evidenceRefs: [event.id],
        workspaceId: event.workspaceId,
        source: event.source,
        promotionStatus: "promoted",
      });
    }

    const goalMatch = text.match(/\b(?:my goal is|i want to|i need to)\s+([^.!?\n]{3,120})/i);
    if (goalMatch) {
      push({
        beliefType: "user_goal",
        subject: "current_goal",
        value: `Goal: ${truncate(goalMatch[1], 150)}`,
        confidence: 0.72,
        evidenceRefs: [event.id],
        workspaceId: event.workspaceId,
        source: event.source,
        promotionStatus: "promoted",
      });
    }

    if (/\b(concise|shorter|brief|too long)\b/i.test(text)) {
      push({
        beliefType: "user_preference",
        subject: "response_length",
        value: "Prefers concise responses.",
        confidence: 0.88,
        evidenceRefs: [event.id],
        workspaceId: event.workspaceId,
        source: event.source,
        promotionStatus: "promoted",
      });
    }

    if (/\b(more detail|detailed|deeper)\b/i.test(text)) {
      push({
        beliefType: "user_preference",
        subject: "response_length",
        value: "Prefers detailed explanations when needed.",
        confidence: 0.88,
        evidenceRefs: [event.id],
        workspaceId: event.workspaceId,
        source: event.source,
        promotionStatus: "promoted",
      });
    }

    return beliefs;
  }

  private upsertBelief(input: Omit<AwarenessBelief, "id" | "createdAt" | "updatedAt">): void {
    this.ensureLoaded();
    const now = Date.now();
    const existing = this.state.beliefs.find(
      (belief) =>
        belief.beliefType === input.beliefType &&
        belief.subject === input.subject &&
        belief.value.toLowerCase() === input.value.toLowerCase(),
    );

    if (existing) {
      existing.updatedAt = now;
      existing.confidence = Math.max(existing.confidence, input.confidence);
      existing.evidenceRefs = Array.from(new Set([...existing.evidenceRefs, ...input.evidenceRefs])).slice(-8);
      existing.promotionStatus =
        existing.promotionStatus === "confirmed" ? "confirmed" : input.promotionStatus;
      this.applyLegacyMemorySideEffects(existing);
      this.save();
      return;
    }

    const belief: AwarenessBelief = {
      id: randomUUID(),
      beliefType: input.beliefType,
      subject: input.subject,
      value: truncate(input.value, 220),
      confidence: Math.max(0, Math.min(1, input.confidence)),
      evidenceRefs: [...input.evidenceRefs].slice(-8),
      workspaceId: input.workspaceId,
      source: input.source,
      promotionStatus: input.promotionStatus,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: input.promotionStatus === "confirmed" ? now : undefined,
    };
    this.state.beliefs.push(belief);
    this.state.beliefs = this.state.beliefs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 250);
    this.applyLegacyMemorySideEffects(belief);
    this.save();
  }

  private applyLegacyMemorySideEffects(belief: AwarenessBelief): void {
    try {
      if (
        belief.beliefType === "user_fact" ||
        belief.beliefType === "user_preference" ||
        belief.beliefType === "user_goal"
      ) {
        const request: AddUserFactRequest = {
          category:
            belief.beliefType === "user_goal"
              ? "goal"
              : belief.beliefType === "user_preference"
                ? "preference"
                : "identity",
          value: belief.value,
          confidence: belief.confidence,
          source: belief.source === "feedback" ? "feedback" : "conversation",
        };
        UserProfileService.addFact(request);
      }
    } catch {
      // best-effort compatibility bridge
    }
  }

  private async pollDeviceContext(): Promise<void> {
    const workspaceId = this.deps.getDefaultWorkspaceId?.();
    await Promise.all([
      this.pollForegroundApp(workspaceId),
      this.pollClipboard(workspaceId),
      this.pollNotifications(workspaceId),
    ]);
  }

  private async pollForegroundApp(workspaceId?: string): Promise<void> {
    const context = await this.readForegroundContext();
    if (!context) return;
    const nextFingerprint = fingerprint([context.appName, context.windowTitle]);
    if (nextFingerprint === this.lastForegroundFingerprint) return;
    this.lastForegroundFingerprint = nextFingerprint;
    this.captureEvent({
      source: "apps",
      workspaceId,
      title: context.appName,
      summary: truncate(`${context.appName}${context.windowTitle ? ` — ${context.windowTitle}` : ""}`, 180),
      sensitivity: "low",
      payload: { appName: context.appName, windowTitle: context.windowTitle },
      tags: ["focus"],
    });
    if (BROWSER_APPS.has(context.appName) && context.windowTitle) {
      this.captureEvent({
        source: "browser",
        workspaceId,
        title: context.appName,
        summary: truncate(context.windowTitle, 180),
        sensitivity: "medium",
        payload: { appName: context.appName, windowTitle: context.windowTitle },
        tags: ["focus", "context"],
      });
    }
  }

  private async pollClipboard(workspaceId?: string): Promise<void> {
    const text = String(clipboard.readText() || "").trim();
    if (!text) return;
    const nextFingerprint = fingerprint([text.slice(0, 120), text.length]);
    if (nextFingerprint === this.lastClipboardFingerprint) return;
    this.lastClipboardFingerprint = nextFingerprint;
    const { summary, sensitivity } = redactSensitiveText(text);
    this.captureEvent({
      source: "clipboard",
      workspaceId,
      title: "Clipboard",
      summary,
      sensitivity,
      payload: { charCount: text.length },
      tags: ["context"],
    });
  }

  private async pollNotifications(workspaceId?: string): Promise<void> {
    try {
      const store = loadNotificationStoreSync();
      const latest = [...(store.notifications || [])]
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((notification) => !notification.read);
      if (!latest) return;
      const nextFingerprint = fingerprint([latest.id, latest.createdAt]);
      if (nextFingerprint === this.lastNotificationFingerprint) return;
      this.lastNotificationFingerprint = nextFingerprint;
      this.captureEvent({
        source: "notifications",
        workspaceId,
        title: truncate(latest.title || latest.type, 100),
        summary: truncate(latest.message || latest.title || latest.type, 180),
        sensitivity: "medium",
        payload: { notificationId: latest.id, type: latest.type },
        tags: ["context"],
      });
    } catch {
      // optional
    }
  }

  private async readForegroundContext(): Promise<{ appName: string; windowTitle?: string } | null> {
    if (os.platform() !== "darwin") return null;
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
          set winTitle to name of front window of frontApp
        end try
        return appName & "||" & winTitle
      end tell
    `;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        timeout: 4_000,
        maxBuffer: 128 * 1024,
      });
      const [appNameRaw, windowTitleRaw] = String(stdout || "").trim().split("||");
      const appName = truncate(appNameRaw || "", 80);
      const windowTitle = truncate(windowTitleRaw || "", 160);
      if (!appName) return null;
      return { appName, windowTitle: windowTitle || undefined };
    } catch {
      return null;
    }
  }
}

export function getAwarenessService(): AwarenessService {
  return AwarenessService.getInstance();
}
