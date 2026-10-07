import { useCallback, useEffect, useRef, useState } from "react";
import { summarizeSurfaceChanges } from "../../shared/answer-surfaces/blocks";
import {
  mergeSurfaceState,
  type AnswerSurfaceSpec,
  type AnswerSurfaceState,
  type AnswerSurfaceStateValue,
} from "../../shared/answer-surfaces/schema";

type SavedState = Record<string, unknown>;
type Waiter = (value: SavedState | null) => void;

const SAVE_DELAY_MS = 500;
const LOAD_BATCH_MS = 20;
const MAX_KEYS_PER_LOAD = 40;
const MAX_CACHED = 400;

/**
 * Saved values by `taskId:surfaceKey`. A surface that scrolls out of the virtualized feed
 * unmounts; the cache lets it come back with its values without another round trip.
 */
const savedStates = new Map<string, SavedState>();
const loadBatches = new Map<string, Map<string, Waiter[]>>();

function cacheSaved(cacheKey: string, state: SavedState): void {
  savedStates.delete(cacheKey);
  savedStates.set(cacheKey, state);
  if (savedStates.size > MAX_CACHED) {
    const oldest = savedStates.keys().next().value;
    if (oldest) savedStates.delete(oldest);
  }
}

async function flushLoads(taskId: string): Promise<void> {
  const batch = loadBatches.get(taskId);
  loadBatches.delete(taskId);
  if (!batch) return;
  const keys = [...batch.keys()];
  for (let start = 0; start < keys.length; start += MAX_KEYS_PER_LOAD) {
    const chunk = keys.slice(start, start + MAX_KEYS_PER_LOAD);
    let result: Record<string, SavedState> = {};
    try {
      result = (await window.electronAPI?.getAnswerSurfaceState?.({ taskId, keys: chunk })) ?? {};
    } catch {
      // Unsaved state is not an error: the surface starts from its defaults.
    }
    for (const key of chunk) {
      const saved = result[key] ?? null;
      if (saved) cacheSaved(`${taskId}:${key}`, saved);
      for (const resolve of batch.get(key) ?? []) resolve(saved);
    }
  }
}

/** Loads saved state, coalescing every surface that mounts in the same frame into one call. */
function loadSavedState(taskId: string, key: string): Promise<SavedState | null> {
  return new Promise((resolve) => {
    let batch = loadBatches.get(taskId);
    if (!batch) {
      batch = new Map();
      loadBatches.set(taskId, batch);
      setTimeout(() => void flushLoads(taskId), LOAD_BATCH_MS);
    }
    batch.set(key, [...(batch.get(key) ?? []), resolve]);
  });
}

function saveState(
  taskId: string,
  key: string,
  spec: AnswerSurfaceSpec,
  state: AnswerSurfaceState,
): void {
  cacheSaved(`${taskId}:${key}`, state);
  const summary = summarizeSurfaceChanges(spec, state).join("\n");
  void window.electronAPI?.saveAnswerSurfaceState?.({ taskId, key, state, summary })?.catch(() => {
    // The value stays on screen; it is just not remembered after a restart.
  });
}

/**
 * The control values of one answer surface. With `persist`, values are loaded for the
 * task and saved (debounced) as the user changes them; without it (a streaming draft,
 * a read-only history view) they live only while the surface is mounted.
 */
export function useAnswerSurfaceState(
  spec: AnswerSurfaceSpec,
  options: { taskId?: string; surfaceKey: string; persist: boolean },
): [AnswerSurfaceState, (id: string, value: AnswerSurfaceStateValue) => void] {
  const { taskId, surfaceKey, persist } = options;
  const cacheKey = persist && taskId ? `${taskId}:${surfaceKey}` : null;
  const [state, setState] = useState<AnswerSurfaceState>(() =>
    mergeSurfaceState(spec, cacheKey ? savedStates.get(cacheKey) : null),
  );
  const stateRef = useRef(state);
  const touchedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!cacheKey || !taskId || savedStates.has(cacheKey)) return;
    let cancelled = false;
    void loadSavedState(taskId, surfaceKey).then((saved) => {
      if (cancelled || !saved || touchedRef.current) return;
      const next = mergeSurfaceState(spec, saved);
      stateRef.current = next;
      setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, spec, surfaceKey, taskId]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      pendingSaveRef.current?.();
    },
    [],
  );

  const setValue = useCallback(
    (id: string, value: AnswerSurfaceStateValue) => {
      touchedRef.current = true;
      const next = { ...stateRef.current, [id]: value };
      stateRef.current = next;
      setState(next);
      if (!cacheKey || !taskId) return;
      cacheSaved(cacheKey, next);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const flush = () => {
        saveTimerRef.current = null;
        pendingSaveRef.current = null;
        saveState(taskId, surfaceKey, spec, next);
      };
      pendingSaveRef.current = flush;
      saveTimerRef.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [cacheKey, spec, surfaceKey, taskId],
  );

  return [state, setValue];
}
