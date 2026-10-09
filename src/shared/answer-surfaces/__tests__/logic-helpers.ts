import type { AnswerDataTable } from "../data";
import { LOGIC_DATA_HELPERS, readLogicOutputs } from "../logic";
import type { AnswerSurfaceSpec } from "../schema";

/** Runs a spec's logic directly (tests only; the app runs it in a sandboxed worker). */
export function runLogicForTest(
  spec: AnswerSurfaceSpec,
  state: Record<string, unknown>,
  tables: Record<string, AnswerDataTable> = {},
) {
  if (!spec.logic) return { scope: {}, data: {} };
  const compute = new Function(`${LOGIC_DATA_HELPERS}\n${spec.logic.code}\nreturn compute;`)() as (
    s: unknown,
    d: unknown,
  ) => unknown;
  return readLogicOutputs(compute(Object.freeze({ ...state }), tables), spec.logic.outputs);
}

/** A small sales table for examples that read `uploads/sales.csv`. */
export const SAMPLE_SALES: AnswerDataTable = {
  file: "uploads/sales.csv",
  columns: ["Date", "Region", "Product", "Revenue"],
  rows: [
    ["2026-09-01", "North", "Kettle", 120],
    ["2026-09-02", "South", "Toaster", 80],
    ["2026-09-03", "North", "Toaster", 95.5],
    ["2026-09-04", "West", "Kettle", 140],
    ["2026-09-05", "South", "Kettle", null],
  ],
  totalRows: 5,
  truncated: false,
};
