import { useEffect, useState } from "react";
import {
  isAnswerDataError,
  type AnswerDataResult,
  type AnswerDataTable,
  type AnswerSurfaceData,
} from "../../shared/answer-surfaces/data";

export type SurfaceDataState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | {
      status: "ready";
      tables: Record<string, AnswerDataTable>;
      errors: Array<{ id: string; file: string; error: string }>;
    };

/** Recent loads, so an answer scrolled back into view does not read its files again. */
const CACHE_MS = 60_000;
const recent = new Map<string, { at: number; result: Promise<Record<string, AnswerDataResult>> }>();

function loadCached(
  key: string,
  load: () => Promise<Record<string, AnswerDataResult>>,
): Promise<Record<string, AnswerDataResult>> {
  const now = Date.now();
  for (const [entryKey, entry] of recent) if (now - entry.at > CACHE_MS) recent.delete(entryKey);
  const hit = recent.get(key);
  if (hit) return hit.result;
  const result = load();
  recent.set(key, { at: now, result });
  // A failed load is not remembered, so the next mount tries again.
  result.catch(() => recent.delete(key));
  return result;
}

/**
 * Loads the workspace files a surface declares as data. Files are read in main, inside
 * the task's workspace; without a task (drafts) or outside the desktop app the surface
 * says where its numbers would come from instead.
 */
export function useSurfaceData(
  sources: AnswerSurfaceData | undefined,
  taskId: string | undefined,
): SurfaceDataState {
  const [state, setState] = useState<SurfaceDataState>(() =>
    sources ? { status: "loading" } : { status: "none" },
  );
  const key = sources ? JSON.stringify(sources) : "";

  useEffect(() => {
    if (!sources) {
      setState({ status: "none" });
      return;
    }
    const load =
      typeof window === "undefined" ? undefined : window.electronAPI?.loadAnswerSurfaceData;
    if (!load) {
      setState({ status: "unavailable", reason: "Data files are read in the desktop app." });
      return;
    }
    if (!taskId) {
      setState({ status: "unavailable", reason: "Data loads once the answer is saved." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadCached(`${taskId}|${key}`, () => load({ taskId, sources }))
      .then((results: Record<string, AnswerDataResult>) => {
        if (cancelled) return;
        const tables: Record<string, AnswerDataTable> = {};
        const errors: Array<{ id: string; file: string; error: string }> = [];
        for (const [id, result] of Object.entries(results ?? {})) {
          if (isAnswerDataError(result)) errors.push({ id, ...result });
          else tables[id] = result;
        }
        setState({ status: "ready", tables, errors });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "unavailable",
          reason: error instanceof Error ? error.message : "The data could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
    // `key` stands for `sources`; the object itself is rebuilt on every parse.
  }, [key, taskId]);

  return state;
}
