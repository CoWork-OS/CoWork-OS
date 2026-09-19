import type { Task, TaskEvent, TaskTimelinePageCursor } from "../../shared/types";
import type { ComposerDraft } from "../../shared/composer-drafts";
import type { SharedTaskEventUiState } from "../utils/task-event-derived";
import type { DisclosureIntentState } from "../utils/disclosure-state";

export interface TaskSurfaceKey {
  scope: "local" | "remote";
  workspaceId: string;
  taskId: string;
  deviceId?: string;
  surface: "main" | "side-chat";
}

export interface TaskViewSnapshot {
  task: Task | null;
  timeline: {
    events: TaskEvent[];
    cursor: TaskTimelinePageCursor | null;
    hasMoreHistory: boolean;
    revision: number;
  };
  projection?: SharedTaskEventUiState;
  composerDraft?: ComposerDraft;
  disclosureState: DisclosureIntentState;
  scrollAnchor?: {
    eventId?: string;
    offset: number;
    followingBottom: boolean;
  };
  switchGeneration: number;
  lastAccessedAt: number;
}

export function serializeTaskSurfaceKey(key: TaskSurfaceKey): string {
  return [
    key.scope,
    key.workspaceId.trim(),
    key.deviceId?.trim() || "local",
    key.taskId.trim(),
    key.surface,
  ].join(":");
}

export function normalizeTaskSurfaceKey(key: TaskSurfaceKey): TaskSurfaceKey {
  return {
    scope: key.scope,
    workspaceId: key.workspaceId.trim(),
    taskId: key.taskId.trim(),
    surface: key.surface,
    ...(key.deviceId?.trim() ? { deviceId: key.deviceId.trim() } : {}),
  };
}

export function createEmptyTaskViewSnapshot(now = Date.now()): TaskViewSnapshot {
  return {
    task: null,
    timeline: {
      events: [],
      cursor: null,
      hasMoreHistory: false,
      revision: 0,
    },
    disclosureState: { groups: {}, activities: {} },
    switchGeneration: 0,
    lastAccessedAt: now,
  };
}

export interface TaskViewCacheOptions {
  maxTasks?: number;
  maxBytes?: number;
}

type CacheEntry = { snapshot: TaskViewSnapshot; bytes: number };

export class TaskViewCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxTasks: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(options: TaskViewCacheOptions = {}) {
    this.maxTasks = Math.max(1, Math.floor(options.maxTasks ?? 32));
    this.maxBytes = Math.max(64 * 1024, Math.floor(options.maxBytes ?? 8 * 1024 * 1024));
  }

  get(key: TaskSurfaceKey | string): TaskViewSnapshot | null {
    const serialized = typeof key === "string" ? key : serializeTaskSurfaceKey(key);
    const entry = this.entries.get(serialized);
    if (!entry) return null;
    entry.snapshot.lastAccessedAt = Date.now();
    this.entries.delete(serialized);
    this.entries.set(serialized, entry);
    return entry.snapshot;
  }

  set(key: TaskSurfaceKey, snapshot: TaskViewSnapshot): void {
    const serialized = serializeTaskSurfaceKey(key);
    const bytes = estimateTaskViewSnapshotBytes(snapshot);
    const previous = this.entries.get(serialized);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(serialized);

    if (bytes > this.maxBytes) {
      if (previous) {
        this.entries.set(serialized, previous);
        this.totalBytes += previous.bytes;
      }
      return;
    }
    snapshot.lastAccessedAt = Date.now();
    this.entries.set(serialized, { snapshot, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  delete(key: TaskSurfaceKey | string): void {
    const serialized = typeof key === "string" ? key : serializeTaskSurfaceKey(key);
    const previous = this.entries.get(serialized);
    if (!previous) return;
    this.entries.delete(serialized);
    this.totalBytes -= previous.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  has(key: TaskSurfaceKey | string): boolean {
    const serialized = typeof key === "string" ? key : serializeTaskSurfaceKey(key);
    return this.entries.has(serialized);
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    while (this.entries.size > this.maxTasks || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
  }
}

export function estimateTaskViewSnapshotBytes(snapshot: TaskViewSnapshot): number {
  try {
    return new TextEncoder().encode(
      JSON.stringify({
        task: snapshot.task,
        timeline: snapshot.timeline,
        projection: snapshot.projection,
        composerDraft: snapshot.composerDraft,
        disclosureState: snapshot.disclosureState,
        scrollAnchor: snapshot.scrollAnchor,
      }),
    ).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
