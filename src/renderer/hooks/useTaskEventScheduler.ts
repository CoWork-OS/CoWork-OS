import { useCallback, useSyncExternalStore } from "react";

import type {
  TaskEventScheduler,
  TaskEventSchedulerSnapshot,
  TaskEventTarget,
} from "../state/task-event-scheduler";
import { getTaskEventTargetKey } from "../state/task-event-scheduler";

const EMPTY_SNAPSHOT: TaskEventSchedulerSnapshot = {
  target: null,
  generation: 0,
  version: 0,
  events: [],
};

/**
 * Subscribe a surface to one scheduler buffer without coupling React to the
 * event source. The scheduler remains imperative so local and remote IPC
 * callbacks can share the same ingestion path.
 */
export function useTaskEventScheduler(
  scheduler: TaskEventScheduler,
  target: TaskEventTarget | null | undefined,
): TaskEventSchedulerSnapshot {
  const targetKey = target ? getTaskEventTargetKey(target) : "empty";
  const subscribe = useCallback(
    (listener: () => void) => (target ? scheduler.subscribe(target, listener) : () => undefined),
    [scheduler, targetKey],
  );
  const getSnapshot = useCallback(
    () => (target ? scheduler.getSnapshot(target) : EMPTY_SNAPSHOT),
    [scheduler, targetKey],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
