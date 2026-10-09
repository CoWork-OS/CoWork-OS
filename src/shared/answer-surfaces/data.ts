import { z } from "zod";
import { isValidIdentifier } from "./expression";

/**
 * Data sources for answer surfaces (see electron/answer-surfaces/answer-data.ts): a block
 * names workspace files by id, the app reads and parses them in main, and the block's
 * logic computes from the rows. Shared by the schema, the IPC contract and the renderer.
 */

export const ANSWER_DATA_EXTENSIONS = [".csv", ".tsv", ".xlsx", ".xlsm", ".json"];
export const MAX_ANSWER_DATA_SOURCES = 4;
export const MAX_ANSWER_DATA_ROWS = 20_000;
export const MAX_ANSWER_DATA_COLUMNS = 50;
/** Cells across all of a block's files, so the data stays cheap to move and copy. */
export const MAX_ANSWER_DATA_CELLS = 200_000;

export type AnswerDataCell = number | string | boolean | null;

/** True when any folder or file name in the path starts with a dot. */
export function hasHiddenSegment(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

export type AnswerDataTable = {
  /** The workspace-relative path, shown as the source of the numbers. */
  file: string;
  columns: string[];
  rows: AnswerDataCell[][];
  /** Data rows in the file, which can exceed `rows.length` when the file was cut. */
  totalRows: number;
  truncated: boolean;
};

export type AnswerDataResult = AnswerDataTable | { file: string; error: string };

export function isAnswerDataError(
  value: AnswerDataResult,
): value is { file: string; error: string } {
  return "error" in value;
}

const dataPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => !/^[a-z][a-z0-9+.-]*:/i.test(value),
    "must be a workspace file path, not a URL",
  )
  // Relative to the workspace and plain: no absolute paths or parent steps.
  .refine(
    (value) => !/^([\\/]|[a-z]:)/i.test(value) && !value.split(/[\\/]+/).includes(".."),
    "must be a path inside the workspace",
  )
  // Hidden folders (.cowork, .git, .env…) hold app state and secrets, never answer data.
  .refine((value) => !hasHiddenSegment(value), "cannot be in a hidden folder")
  .refine(
    (value) => ANSWER_DATA_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension)),
    "must be a .csv, .tsv, .xlsx or .json file",
  );

/** Handles the app gives structured tool results, e.g. "r3f9a2c41" (see tool-data.ts). */
export const TOOL_DATA_HANDLE_PATTERN = /^r[0-9a-f]{8}$/;

/** A saved tool result of this task, by the handle the app told the model about. */
const toolSource = z
  .object({
    tool: z
      .string()
      .trim()
      .regex(TOOL_DATA_HANDLE_PATTERN, "must be a tool result handle like r3f9a2c41"),
  })
  .strict();

export type AnswerSurfaceDataSource = string | { tool: string };

export function isToolDataSource(source: AnswerSurfaceDataSource): source is { tool: string } {
  return typeof source === "object" && source !== null && "tool" in source;
}

/**
 * `"data": {"sales": "uploads/sales.csv", "hits": {"tool": "r3f9a2c41"}}` on a block's outer
 * object: workspace files and saved tool results.
 */
export const AnswerSurfaceDataSchema = z
  .record(
    z.string().trim().refine(isValidIdentifier, "must be a simple identifier"),
    z.union([dataPath, toolSource]),
  )
  .refine((value) => Object.keys(value).length >= 1, "needs at least one file")
  .refine(
    (value) => Object.keys(value).length <= MAX_ANSWER_DATA_SOURCES,
    `at most ${MAX_ANSWER_DATA_SOURCES} files`,
  );

export type AnswerSurfaceData = Record<string, AnswerSurfaceDataSource>;

/** How a table is described next to the numbers computed from it. */
export function describeAnswerData(table: AnswerDataTable): string {
  // The full workspace-relative path, so it is clear exactly which file was read.
  const name = table.file;
  const count = new Intl.NumberFormat("en-US").format(table.totalRows);
  if (table.truncated && table.totalRows > table.rows.length) {
    const used = new Intl.NumberFormat("en-US").format(table.rows.length);
    return `${name} (first ${used} of ${count} rows)`;
  }
  return `${name} (${count} ${table.totalRows === 1 ? "row" : "rows"})`;
}
