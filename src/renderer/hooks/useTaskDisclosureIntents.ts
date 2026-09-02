import { useCallback, useRef, useState } from "react";

import {
  disclosureIntentReducer,
  getDisclosureIntent,
  type DisclosureIntent,
  type DisclosureIntentState,
  type DisclosureScope,
} from "../utils/disclosure-state";

const MAX_CACHED_TASK_DISCLOSURE_STATES = 20;

export function useTaskDisclosureIntents(taskId: string | null | undefined) {
  const normalizedTaskId = taskId ?? "";
  const [statesByTask, setStatesByTask] = useState<Record<string, DisclosureIntentState>>({});
  const taskOrderRef = useRef<string[]>([]);
  const state = statesByTask[normalizedTaskId] ?? { groups: {}, activities: {} };

  const apply = useCallback(
    (action: Parameters<typeof disclosureIntentReducer>[1]) => {
      if (!normalizedTaskId) return;
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
    [normalizedTaskId],
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
