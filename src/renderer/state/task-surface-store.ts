import { useSyncExternalStore } from "react";

import type { Task, TaskEvent, TaskTimelinePageCursor } from "../../shared/types";
import type { ComposerDraft } from "../../shared/composer-drafts";
import type { SharedTaskEventUiState } from "../utils/task-event-derived";
import {
  createEmptyTaskViewSnapshot,
  normalizeTaskSurfaceKey,
  serializeTaskSurfaceKey,
  TaskViewCache,
  type TaskSurfaceKey,
  type TaskViewSnapshot,
} from "./task-view-cache";

export type TaskSurfaceListener = () => void;

export interface TaskSurfaceSwitchResult {
  key: TaskSurfaceKey;
  cacheKey: string;
  generation: number;
  snapshot: TaskViewSnapshot;
}

export class TaskSurfaceStore {
  readonly cache: TaskViewCache;
  private readonly listeners = new Set<TaskSurfaceListener>();
  private activeKey: TaskSurfaceKey | null = null;
  private selectionGeneration = 0;

  constructor(cache = new TaskViewCache()) {
    this.cache = cache;
  }

  subscribe = (listener: TaskSurfaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getActiveKey(): TaskSurfaceKey | null {
    return this.activeKey;
  }

  getSelectionGeneration(): number {
    return this.selectionGeneration;
  }

  getSnapshot(key: TaskSurfaceKey | string | null): TaskViewSnapshot | null {
    if (!key) return null;
    return this.cache.get(key);
  }

  getActiveSnapshot(): TaskViewSnapshot | null {
    return this.getSnapshot(this.activeKey);
  }

  switchTo(key: TaskSurfaceKey): TaskSurfaceSwitchResult {
    const normalizedKey = normalizeTaskSurfaceKey(key);
    this.selectionGeneration += 1;
    this.activeKey = normalizedKey;
    const snapshot = this.cache.get(normalizedKey) ?? createEmptyTaskViewSnapshot(Date.now());
    snapshot.switchGeneration = this.selectionGeneration;
    this.cache.set(normalizedKey, snapshot);
    this.emit();
    return {
      key: normalizedKey,
      cacheKey: serializeTaskSurfaceKey(normalizedKey),
      generation: this.selectionGeneration,
      snapshot,
    };
  }

  clearActive(): void {
    this.activeKey = null;
    this.selectionGeneration += 1;
    this.emit();
  }

  isCurrent(key: TaskSurfaceKey, generation: number): boolean {
    return (
      this.selectionGeneration === generation &&
      this.activeKey !== null &&
      serializeTaskSurfaceKey(this.activeKey) ===
        serializeTaskSurfaceKey(normalizeTaskSurfaceKey(key))
    );
  }

  update(
    key: TaskSurfaceKey,
    updater: (snapshot: TaskViewSnapshot) => TaskViewSnapshot,
    options: { generation?: number; notify?: boolean } = {},
  ): TaskViewSnapshot | null {
    if (options.generation !== undefined && !this.isCurrent(key, options.generation)) {
      return null;
    }
    const normalizedKey = normalizeTaskSurfaceKey(key);
    const current = this.cache.get(normalizedKey) ?? createEmptyTaskViewSnapshot();
    const next = updater(current);
    this.cache.set(normalizedKey, next);
    if (options.notify !== false) this.emit();
    return next;
  }

  setTask(key: TaskSurfaceKey, task: Task | null, generation?: number): TaskViewSnapshot | null {
    return this.update(key, (snapshot) => ({ ...snapshot, task }), { generation });
  }

  setTimeline(
    key: TaskSurfaceKey,
    input: {
      events: TaskEvent[];
      cursor: TaskTimelinePageCursor | null;
      hasMoreHistory: boolean;
      replace?: boolean;
    },
    generation?: number,
  ): TaskViewSnapshot | null {
    return this.update(
      key,
      (snapshot) => ({
        ...snapshot,
        timeline: {
          events: input.replace
            ? input.events
            : mergeTaskSurfaceEvents(snapshot.timeline.events, input.events),
          cursor: input.cursor,
          hasMoreHistory: input.hasMoreHistory,
          revision: snapshot.timeline.revision + 1,
        },
      }),
      { generation },
    );
  }

  setDraft(key: TaskSurfaceKey, composerDraft: ComposerDraft | undefined): TaskViewSnapshot | null {
    return this.update(key, (snapshot) => ({ ...snapshot, composerDraft }));
  }

  setProjection(
    key: TaskSurfaceKey,
    projection: SharedTaskEventUiState | undefined,
  ): TaskViewSnapshot | null {
    return this.update(key, (snapshot) => ({ ...snapshot, projection }));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function getTaskSurfaceEventIdentity(event: TaskEvent): string {
  return event.eventId?.trim() || event.id;
}

export function mergeTaskSurfaceEvents(existing: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const byId = new Map<string, TaskEvent>();
  for (const event of [...existing, ...incoming]) {
    if (!event?.taskId) continue;
    const identity = getTaskSurfaceEventIdentity(event);
    const previous = byId.get(identity);
    if (!previous || compareTaskSurfaceEvents(previous, event) <= 0) byId.set(identity, event);
  }
  return [...byId.values()].sort(compareTaskSurfaceEvents);
}

function compareTaskSurfaceEvents(left: TaskEvent, right: TaskEvent): number {
  const leftSeq = typeof left.seq === "number" ? left.seq : Number.POSITIVE_INFINITY;
  const rightSeq = typeof right.seq === "number" ? right.seq : Number.POSITIVE_INFINITY;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.id.localeCompare(right.id);
}

export function useTaskSurface(
  store: TaskSurfaceStore,
  key: TaskSurfaceKey | null,
): TaskViewSnapshot | null {
  const serializedKey = key ? serializeTaskSurfaceKey(normalizeTaskSurfaceKey(key)) : null;
  return useSyncExternalStore(
    store.subscribe,
    () => (serializedKey ? store.getSnapshot(serializedKey) : null),
    () => null,
  );
}

export const taskSurfaceStore = new TaskSurfaceStore();
