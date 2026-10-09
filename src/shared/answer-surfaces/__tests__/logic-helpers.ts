import { readLogicOutputs } from "../logic";
import type { AnswerSurfaceSpec } from "../schema";

/** Runs a spec's logic directly (tests only; the app runs it in a sandboxed worker). */
export function runLogicForTest(spec: AnswerSurfaceSpec, state: Record<string, unknown>) {
  if (!spec.logic) return { scope: {}, data: {} };
  const compute = new Function(`${spec.logic.code}\nreturn compute;`)() as (s: unknown) => unknown;
  return readLogicOutputs(compute(Object.freeze({ ...state })), spec.logic.outputs);
}
