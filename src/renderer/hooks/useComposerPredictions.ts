import { useEffect, useRef, useState } from "react";
import type { ComposerPrediction } from "../../shared/composer-predictions";

const KEY = "composer-predictions-enabled";
const CHANGED = "composer-predictions-changed";
const AVAILABLE_KEY = "composer-predictions-available";
const AVAILABLE_CHANGED = "composer-predictions-available-changed";

export function hasComposerPredictionAvailable(): boolean {
  try {
    return localStorage.getItem(AVAILABLE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Announce discovery only after a usable suggestion reaches the current composer. */
export function markComposerPredictionAvailable(): void {
  if (hasComposerPredictionAvailable()) return;
  try {
    localStorage.setItem(AVAILABLE_KEY, "true");
  } catch {
    // The current window can still show the notice when storage is unavailable.
  }
  window.dispatchEvent(new Event(AVAILABLE_CHANGED));
}

export function useComposerPredictionAvailable() {
  const [available, setAvailable] = useState(hasComposerPredictionAvailable);
  useEffect(() => {
    const onAvailable = () => setAvailable(true);
    const onStorage = () => setAvailable(hasComposerPredictionAvailable());
    onStorage();
    window.addEventListener(AVAILABLE_CHANGED, onAvailable);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(AVAILABLE_CHANGED, onAvailable);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return available;
}

export function useComposerPredictionsEnabled() {
  const [enabled, setEnabled] = useState(
    () => typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "false",
  );
  useEffect(() => {
    const update = () =>
      setEnabled(typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "false");
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return [
    enabled,
    (value: boolean) => {
      localStorage.setItem(KEY, String(value));
      window.dispatchEvent(new Event(CHANGED));
      setEnabled(value);
    },
  ] as const;
}

export function useComposerPrediction(
  taskId: string | undefined,
  revision: string,
  eligible: boolean,
) {
  const [enabled] = useComposerPredictionsEnabled();
  const [prediction, setPrediction] = useState<(ComposerPrediction & { taskId: string }) | null>(
    null,
  );
  const dismissed = useRef(new Set<string>());
  const key = `${taskId}:${revision}`;
  useEffect(() => {
    setPrediction(null);
    if (
      !enabled ||
      !eligible ||
      !taskId ||
      !revision ||
      dismissed.current.has(key) ||
      !window.electronAPI?.getComposerPrediction
    )
      return;
    const requestId = crypto.randomUUID();
    return scheduleComposerPrediction(
      () => window.electronAPI.getComposerPrediction!({ taskId, revision, requestId }),
      (result) => {
        if (result?.revision === revision && !dismissed.current.has(key)) {
          setPrediction({ ...result, taskId });
          markComposerPredictionAvailable();
        }
      },
      () => window.electronAPI.cancelComposerPrediction?.(requestId).catch(() => {}),
    );
  }, [taskId, revision, key, enabled, eligible]);
  return {
    prediction:
      enabled &&
      eligible &&
      prediction !== null &&
      prediction.taskId === taskId &&
      prediction.revision === revision &&
      !dismissed.current.has(key)
        ? prediction.text
        : "",
    dismiss: () => {
      if (dismissed.current.size > 100) dismissed.current.clear();
      dismissed.current.add(key);
      setPrediction(null);
    },
  };
}

/** Cancelling fences late provider responses as well as the pending debounce. */
export function scheduleComposerPrediction(
  request: () => Promise<ComposerPrediction | null>,
  onResult: (result: ComposerPrediction | null) => void,
  cancelRequest?: () => void,
) {
  let cancelled = false;
  let started = false;
  let settled = false;
  const timer = setTimeout(() => {
    started = true;
    request()
      .then((result) => {
        if (!cancelled) onResult(result);
      })
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
  }, 700);
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    if (started && !settled) cancelRequest?.();
  };
}
