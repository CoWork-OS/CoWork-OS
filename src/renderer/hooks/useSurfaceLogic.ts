import { useEffect, useRef, useState } from "react";
import {
  LOGIC_NOT_LOADED_MESSAGE,
  readLogicResultJson,
  type SurfaceLogicOutputs,
} from "../../shared/answer-surfaces/logic";
import type { AnswerDataTable } from "../../shared/answer-surfaces/data";
import type { AnswerSurfaceSpec, AnswerSurfaceState } from "../../shared/answer-surfaces/schema";
import { getSurfaceLogicChannel } from "../utils/surface-logic-runner";

export type SurfaceLogicStatus =
  | "none"
  | "starting"
  | "running"
  | "ready"
  | "error"
  | "unavailable";

const EMPTY: SurfaceLogicOutputs = { scope: {}, data: {} };
const RUN_DEBOUNCE_MS = 60;
let nextInstance = 0;

/**
 * Runs a surface's logic in the sandboxed runner whenever its control values change and
 * returns the latest outputs. Earlier outputs stay on screen while a run is in flight, so
 * dragging a slider never blanks the numbers; only the newest run's result is applied.
 */
export function useSurfaceLogic(
  spec: AnswerSurfaceSpec,
  state: AnswerSurfaceState,
  /** Parsed data sources; null while they load (or failed), so the logic waits. */
  tables?: Record<string, AnswerDataTable> | null,
): { outputs: SurfaceLogicOutputs; status: SurfaceLogicStatus; error?: string } {
  const logic = spec.logic;
  const waitingForData = Boolean(spec.data) && !tables;
  const [outputs, setOutputs] = useState<SurfaceLogicOutputs>(EMPTY);
  const [status, setStatus] = useState<SurfaceLogicStatus>(logic ? "starting" : "none");
  const [error, setError] = useState<string | undefined>();
  const idRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const runRef = useRef<((state: AnswerSurfaceState) => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saved values can load before the runner is ready; the first run reads the latest.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!logic || waitingForData) return;
    let disposed = false;
    let cleanup = () => {};
    // One worker per mounted surface, even when the same answer is shown twice.
    const id = `logic-${(nextInstance += 1)}`;
    idRef.current = id;
    setStatus("starting");
    void getSurfaceLogicChannel().then((channel) => {
      if (disposed) return;
      if (!channel) {
        setStatus("unavailable");
        return;
      }
      const onMessage = (message: Parameters<Parameters<typeof channel.load>[2]>[0]) => {
        if (message.seq !== seqRef.current) return;
        if (message.type === "result") {
          setOutputs(readLogicResultJson(message.json, logic.outputs));
          setStatus("ready");
          setError(undefined);
        } else if (message.message === LOGIC_NOT_LOADED_MESSAGE) {
          // The runner let this surface's worker go (too many open); load it again.
          channel.load(id, logic.code, onMessage, spec.data ? (tables ?? undefined) : undefined);
          runRef.current?.(stateRef.current);
        } else {
          setStatus("error");
          setError(message.message);
        }
      };
      channel.load(id, logic.code, onMessage, spec.data ? (tables ?? undefined) : undefined);
      runRef.current = (current) => {
        seqRef.current += 1;
        setStatus((previous) => (previous === "ready" ? previous : "running"));
        channel.run(id, seqRef.current, current);
      };
      runRef.current(stateRef.current);
      cleanup = () => channel.dispose(id);
    });
    return () => {
      disposed = true;
      runRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
      cleanup();
    };
    // The worker is rebuilt when the code or its data change; state changes are runs (below).
  }, [logic, tables, waitingForData]);

  useEffect(() => {
    if (!logic || !runRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runRef.current?.(state), RUN_DEBOUNCE_MS);
  }, [logic, state]);

  return { outputs, status, error };
}
