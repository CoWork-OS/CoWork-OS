/**
 * Tool results as answer data. When a tool returns table-like data (web search results,
 * JSON from an API, an MCP tool or a command), the app keeps it as a table under a short
 * handle and tells the model in one line, so an answer can compute its numbers from the
 * actual result ({"tool": "r3f9a2c41"}) instead of retyping them.
 *
 * This runs on every successful tool call, so the work is lazy and bounded: candidates
 * are parsed one at a time, text over 2 MB is skipped, and a table is only offered when
 * its JSON fits the store, so the note never promises data that was not kept.
 */
import { createHash } from "crypto";
import {
  MAX_ANSWER_DATA_CELLS,
  MAX_ANSWER_DATA_COLUMNS,
  MAX_ANSWER_DATA_ROWS,
  type AnswerDataTable,
} from "../../shared/answer-surfaces/data";
import { tableFromJsonValue } from "./answer-data";
import { MAX_TOOL_DATA_JSON_CHARS } from "./tool-data-sql";

/** JSON text larger than this is not parsed for data (the model sees it truncated anyway). */
const MAX_JSON_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_TOOL_CELL_CHARS = 200;
/** Fields that commonly hold a tool's rows or its JSON payload as text. */
const ARRAY_FIELDS = [
  "results",
  "items",
  "rows",
  "records",
  "data",
  "entries",
  "files",
  "structuredContent",
];
const TEXT_FIELDS = ["body", "content", "stdout", "text", "output"];
/**
 * File readers are left out: files have their own data path, which applies the hidden
 * folder, app-data and workspace read-policy checks.
 */
const SKIPPED_TOOLS = new Set(["read_file", "read_files", "parse_document", "read_pdf_visual"]);

let handleSequence = 0;

/**
 * A handle for one kept tool result: 8 hex characters from the task, the call and a
 * per-process sequence, so a provider that reuses call ids (e.g. "call_0" every turn)
 * still gets a new handle and an earlier one is never overwritten.
 */
export function toolDataHandle(taskId: string, toolUseId: string): string {
  handleSequence += 1;
  const seed = `${taskId}\u0000${toolUseId}\u0000${Date.now()}\u0000${handleSequence}`;
  return `r${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  if (value.length < 2 || value.length > MAX_JSON_TEXT_CHARS) return undefined;
  const text = value.trim();
  if (!(text.startsWith("[") || text.startsWith("{"))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Possible table sources, cheapest first, produced one at a time. */
function* candidates(result: unknown): Generator<unknown> {
  if (Array.isArray(result)) yield result;
  if (typeof result === "string") {
    const parsed = parseJsonText(result);
    if (parsed !== undefined) yield parsed;
    return;
  }
  if (!result || typeof result !== "object") return;
  const record = result as Record<string, unknown>;
  for (const field of ARRAY_FIELDS) {
    const value = record[field];
    if (value && typeof value === "object") yield value;
  }
  for (const field of TEXT_FIELDS) {
    const parsed = parseJsonText(record[field]);
    if (parsed !== undefined) yield parsed;
  }
}

function shortenCells(table: AnswerDataTable): AnswerDataTable {
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.map((cell) =>
        typeof cell === "string" && cell.length > MAX_TOOL_CELL_CHARS
          ? cell.slice(0, MAX_TOOL_CELL_CHARS)
          : cell,
      ),
    ),
  };
}

export type ToolDataTable = { table: AnswerDataTable; json: string };

/**
 * The first table-like value in a tool result: at least two rows with at least one
 * column, within the data cell budget, and small enough to keep. Null otherwise.
 */
export function extractToolDataTable(
  toolName: string,
  result: unknown,
  label: string,
): ToolDataTable | null {
  if (SKIPPED_TOOLS.has(toolName)) return null;
  if (!result || (result as { success?: unknown }).success === false) return null;
  const rowLimit = Math.min(
    MAX_ANSWER_DATA_ROWS,
    Math.floor(MAX_ANSWER_DATA_CELLS / MAX_ANSWER_DATA_COLUMNS),
  );
  for (const value of candidates(result)) {
    const table = tableFromJsonValue(value, label, rowLimit);
    const filled = table.rows.filter((row) => row.some((cell) => cell !== null)).length;
    if (table.columns.length < 1 || filled < 2) continue;
    const kept = shortenCells(table);
    const json = JSON.stringify(kept);
    if (json.length > MAX_TOOL_DATA_JSON_CHARS) return null;
    return { table: kept, json };
  }
  return null;
}

/** A column name as plain words: no brackets, quotes or line breaks, at most 30 characters. */
function noteColumn(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029[\]{}"`<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
}

/**
 * The one line appended to the tool result the model sees. Column names come from the
 * tool's output (possibly a web page), so they are reduced to plain words: they cannot
 * close the note or pose as app text.
 */
export function toolDataNote(handle: string, table: AnswerDataTable): string {
  const columns = table.columns.slice(0, 12).map(noteColumn).filter(Boolean);
  const more = table.columns.length > 12 ? ` and ${table.columns.length - 12} more` : "";
  const rows = table.truncated
    ? `${table.rows.length} of ${table.totalRows}`
    : `${table.rows.length}`;
  return `[CoWork data: this result is available to answer components as {"tool": "${handle}"} (${rows} rows; columns: ${JSON.stringify(columns)}${more})]`;
}
