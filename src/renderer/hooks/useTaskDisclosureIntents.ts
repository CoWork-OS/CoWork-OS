import { useCallback, useRef, useState } from "react";

import {
  disclosureIntentReducer,
  getDisclosureIntent,
  type DisclosureIntent,
  type DisclosureIntentState,
  type DisclosureScope,
} from "../utils/disclosure-state";
import { taskSurfaceStore, useTaskSurface } from "../state/task-surface-store";
import type { TaskSurfaceKey } from "../state/task-view-cache";

const MAX_CACHED_TASK_DISCLOSURE_STATES = 20;

export function useTaskDisclosureIntents(
  taskId: string | null | undefined,
  surfaceKey: TaskSurfaceKey | null = null,
) {
  const normalizedTaskId = taskId ?? "";
  const cachedSurface = useTaskSurface(taskSurfaceStore, surfaceKey);
  const [statesByTask, setStatesByTask] = useState<Record<string, DisclosureIntentState>>({});
  const taskOrderRef = useRef<string[]>([]);
  const state = surfaceKey
    ? (cachedSurface?.disclosureState ?? { groups: {}, activities: {} })
    : (statesByTask[normalizedTaskId] ?? { groups: {}, activities: {} });

  const apply = useCallback(
    (action: Parameters<typeof disclosureIntentReducer>[1]) => {
      if (!normalizedTaskId && !surfaceKey) return;
      if (surfaceKey) {
        taskSurfaceStore.update(surfaceKey, (snapshot) => ({
          ...snapshot,
          disclosureState: disclosureIntentReducer(snapshot.disclosureState, action),
        }));
        return;
      }
      setStatesByTask((current) => {
        const nextTaskState = disclosureIntentReducer(
          current[normalizedTaskId] ?? { groups: {}, activities: {} },
          action,
        );
        const next = { ...current, [normalizedTaskId]: nextTaskState };
        taskOrderRef.current = [
          ...taskOrderRef.current.filter((id) => id !== normalizedTaskId),
          normalizedTaskId,
        ];
        while (taskOrderRef.current.length > MAX_CACHED_TASK_DISCLOSURE_STATES) {
          const staleTaskId = taskOrderRef.current.shift();
          if (staleTaskId) delete next[staleTaskId];
        }
        return next;
      });
    },
    [normalizedTaskId, surfaceKey],
  );

  const intentFor = useCallback(
    (scope: DisclosureScope, id: string): DisclosureIntent => getDisclosureIntent(state, scope, id),
    [state],
  );
  const toggle = useCallback(
    (scope: DisclosureScope, id: string, isCurrent = false) => {
      apply({ type: "toggle", scope, id, isCurrent });
    },
    [apply],
  );
  const setIntent = useCallback(
    (scope: DisclosureScope, id: string, intent: DisclosureIntent) => {
      apply({ type: "set", scope, id, intent });
    },
    [apply],
  );

  return { state, intentFor, toggle, setIntent };
}
