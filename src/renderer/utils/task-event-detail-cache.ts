import type { TaskEvent } from "../../shared/types";

export function buildTaskEventDetailCacheKey(input: {
  deviceId?: string | null;
  taskId: string;
  eventId: string;
}): string {
  const deviceId = input.deviceId?.trim() || "local";
  return `${deviceId}:${input.taskId.trim()}:${input.eventId.trim()}`;
}

export function estimateTaskEventPayloadBytes(event: TaskEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(event.payload ?? null)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function eventMatchesDetailId(event: TaskEvent, eventId: string): boolean {
  return event.id === eventId || event.eventId === eventId;
}
