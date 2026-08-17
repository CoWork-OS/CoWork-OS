import type { TaskEvent, TaskTimelinePageCursor } from "../../shared/types";
import {
  TASK_TIMELINE_CACHE_BYTE_LIMIT,
  TASK_TIMELINE_CACHE_TASK_LIMIT,
} from "../../shared/task-timeline-limits";

export interface CachedTaskTimeline {
  taskId: string;
  events: TaskEvent[];
  cursor: TaskTimelinePageCursor | null;
  hasMoreHistory: boolean;
  latestSequence: number;
  payloadBytes: number;
  cachedAt: number;
}

function estimateEventsPayloadBytes(events: TaskEvent[]): number {
  let bytes = 0;
  for (const event of events) {
    try {
      bytes += new Blob([JSON.stringify(event.payload ?? {})]).size;
    } catch {
      bytes += String(event.payload ?? "").length * 2;
    }
  }
  return bytes;
}

function latestSequence(events: TaskEvent[]): number {
  return events.reduce(
    (latest, event) => Math.max(latest, Number(event.seq ?? event.ts ?? event.timestamp) || 0),
    0,
  );
}

export class TaskTimelineCache {
  private entries = new Map<string, CachedTaskTimeline>();

  constructor(
    private readonly taskLimit = TASK_TIMELINE_CACHE_TASK_LIMIT,
    private readonly byteLimit = TASK_TIMELINE_CACHE_BYTE_LIMIT,
  ) {}

  get(key: string): CachedTaskTimeline | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    const touched = { ...entry, cachedAt: Date.now() };
    this.entries.set(key, touched);
    return touched;
  }

  peek(key: string): CachedTaskTimeline | null {
    return this.entries.get(key) ?? null;
  }

  set(
    key: string,
    value: Omit<CachedTaskTimeline, "latestSequence" | "payloadBytes" | "cachedAt"> & {
      payloadBytes?: number;
    },
  ): CachedTaskTimeline {
    const entry: CachedTaskTimeline = {
      ...value,
      events: [...value.events],
      latestSequence: latestSequence(value.events),
      payloadBytes: value.payloadBytes ?? estimateEventsPayloadBytes(value.events),
      cachedAt: Date.now(),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
    return entry;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.payloadBytes;
    return total;
  }

  private evict(): void {
    while (this.entries.size > this.taskLimit || this.totalBytes > this.byteLimit) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}
