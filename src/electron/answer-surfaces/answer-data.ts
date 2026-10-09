/**
 * Data sources for answer surfaces: a block can name workspace files (an attached CSV, a
 * spreadsheet the agent wrote) whose rows its logic computes from, so the numbers on
 * screen come from the data rather than being typed in by the model. The caller resolves
 * and polices the path; this module reads an already-checked file within fixed budgets.
 *
 * Every parser stops keeping rows at the limit before building anything large: a hostile
 * file in the workspace must not be able to exhaust the main process.
 */
import ExcelJS from "exceljs";
import * as fs from "fs/promises";
import * as path from "path";
import { Readable } from "stream";
import {
  ANSWER_DATA_EXTENSIONS,
  MAX_ANSWER_DATA_COLUMNS,
  MAX_ANSWER_DATA_ROWS,
  type AnswerDataCell,
  type AnswerDataTable,
} from "../../shared/answer-surfaces/data";
import { readDocumentArchiveBuffer } from "../security/document-archive";
import { coerceNumericText } from "../utils/document-generators/spreadsheet-cells";
import { parseDelimitedRows } from "../utils/spreadsheet-preview";

export const MAX_ANSWER_DATA_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CELL_CHARS = 500;
const CACHE_ENTRIES = 8;

/** A problem that is safe to show the user as-is (no absolute paths, no file contents). */
export class AnswerDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerDataError";
  }
}

function cellFromText(text: string): AnswerDataCell {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = coerceNumericText(trimmed);
  return typeof value === "number" ? value : text.slice(0, MAX_CELL_CHARS);
}

function cellFromUnknown(value: unknown): AnswerDataCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return cellFromText(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record) return cellFromUnknown(record.result);
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (part && typeof part === "object" ? String(part.text ?? "") : ""))
        .join("")
        .slice(0, MAX_CELL_CHARS);
    }
    if ("text" in record) return String(record.text ?? "").slice(0, MAX_CELL_CHARS);
    return null;
  }
  return String(value).slice(0, MAX_CELL_CHARS);
}

function isBlankRow(row: unknown[]): boolean {
  return !row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "");
}

/**
 * The header plus at most `rowLimit` typed rows. `extraRows` counts data rows that were
 * read past the limit without being kept, so `totalRows` stays honest.
 */
function toTable(
  grid: unknown[][],
  file: string,
  fromText: boolean,
  rowLimit: number,
  extraRows = 0,
): AnswerDataTable {
  const nonEmpty = grid.filter((row) => !isBlankRow(row));
  const header = nonEmpty[0] ?? [];
  const width = Math.min(
    MAX_ANSWER_DATA_COLUMNS,
    nonEmpty.slice(0, 50).reduce((widest, row) => Math.max(widest, row.length), 0),
  );
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, index) => {
    const base =
      String(header[index] ?? "")
        .trim()
        .slice(0, 80) || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count > 1 ? `${base} ${count}` : base;
  });
  const body = nonEmpty.slice(1);
  const rows = body
    .slice(0, rowLimit)
    .map((row) =>
      Array.from({ length: width }, (_, index) =>
        fromText ? cellFromText(String(row[index] ?? "")) : cellFromUnknown(row[index]),
      ),
    );
  const totalRows = body.length + extraRows;
  return {
    file,
    columns,
    rows,
    totalRows,
    truncated: totalRows > rows.length || header.length > width,
  };
}

/** A JSON value (records, rows, or a wrapper holding them) as a table; also used for tool results. */
export function tableFromJsonValue(
  value: unknown,
  file: string,
  rowLimit: number,
): AnswerDataTable {
  const list: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? // A wrapper object such as {"items": [...]}: use its first array.
        ((Object.values(value as Record<string, unknown>).find(Array.isArray) as unknown[]) ?? [])
      : [];
  if (list.length > 0 && Array.isArray(list[0])) {
    const arrays = list.filter((item): item is unknown[] => Array.isArray(item));
    const kept = arrays
      .slice(0, rowLimit + 1)
      .map((row) => row.slice(0, MAX_ANSWER_DATA_COLUMNS + 1));
    return toTable(kept, file, false, rowLimit, Math.max(0, arrays.length - kept.length));
  }
  const records = list.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  // Keys from the first records only, into a set capped at the column limit: a record with
  // a million keys or millions of key-less records cost no more than the cap.
  const keys = new Set<string>();
  for (const record of records.slice(0, 200)) {
    for (const key in record) {
      if (keys.size >= MAX_ANSWER_DATA_COLUMNS) break;
      if (Object.prototype.hasOwnProperty.call(record, key)) keys.add(key);
    }
    if (keys.size >= MAX_ANSWER_DATA_COLUMNS) break;
  }
  const columns = [...keys];
  const kept = records.slice(0, rowLimit).map((record) => columns.map((key) => record[key]));
  return toTable([columns, ...kept], file, false, rowLimit, records.length - kept.length);
}

/** Streams the first non-empty sheet, keeping rows up to the limit and counting the rest. */
async function tableFromWorkbook(
  buffer: Buffer,
  file: string,
  rowLimit: number,
): Promise<AnswerDataTable> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
    entries: "emit",
  });
  for await (const worksheet of reader) {
    const grid: unknown[][] = [];
    let extra = 0;
    for await (const row of worksheet as unknown as AsyncIterable<ExcelJS.Row>) {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (isBlankRow(values)) continue;
      // The header plus `rowLimit` data rows are kept; later rows are only counted.
      if (grid.length <= rowLimit) grid.push(values.slice(0, MAX_ANSWER_DATA_COLUMNS + 1));
      else extra += 1;
    }
    if (grid.length > 0) return toTable(grid, file, false, rowLimit, extra);
  }
  return toTable([], file, false, rowLimit);
}

type CachedTable = { key: string; table: AnswerDataTable };
const cache: CachedTable[] = [];

/**
 * Reads one resolved, contained and policy-checked workspace file as a table. The file is
 * opened once and checked through that handle (regular file, size) before it is parsed.
 * `maxCells` bounds rows × columns for this file.
 */
export async function readAnswerDataTable(
  filePath: string,
  displayPath: string,
  options: { maxCells?: number } = {},
): Promise<AnswerDataTable> {
  const extension = path.extname(filePath).toLowerCase();
  if (!ANSWER_DATA_EXTENSIONS.includes(extension)) {
    throw new AnswerDataError("Only CSV, TSV, XLSX and JSON files can be used as data");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new AnswerDataError("Not a regular file");
    if (stats.size > MAX_ANSWER_DATA_FILE_BYTES) {
      throw new AnswerDataError("The file is larger than 10 MB");
    }
    const file = displayPath.replace(/\\/g, "/");
    const maxCells = options.maxCells ?? MAX_ANSWER_DATA_ROWS * MAX_ANSWER_DATA_COLUMNS;
    const cacheKey = [
      filePath,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeMs,
      file,
      maxCells,
    ].join("|");
    const hit = cache.findIndex((entry) => entry.key === cacheKey);
    if (hit !== -1) {
      const [entry] = cache.splice(hit, 1);
      cache.push(entry);
      return entry.table;
    }

    // Rows are limited by the cell budget as well: wide files keep fewer rows.
    const rowLimitFor = (width: number) =>
      Math.max(1, Math.min(MAX_ANSWER_DATA_ROWS, Math.floor(maxCells / Math.max(1, width))));
    const parseLimit = rowLimitFor(1);
    let table: AnswerDataTable;
    if (extension === ".xlsx" || extension === ".xlsm") {
      // The archive reader enforces inflated-size, entry-count and time limits.
      const buffer = await readDocumentArchiveBuffer(filePath);
      table = await tableFromWorkbook(buffer, file, parseLimit);
    } else {
      const text = (await handle.readFile("utf8")).replace(/^﻿/, "");
      if (extension === ".json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new AnswerDataError("The file is not valid JSON");
        }
        table = tableFromJsonValue(parsed, file, parseLimit);
      } else {
        let skipped = 0;
        const grid = parseDelimitedRows(text, extension === ".tsv" ? "\t" : ",", {
          // The header row plus the data rows we can keep.
          maxRows: parseLimit + 1,
          onRowsSkipped: (count) => {
            skipped = count;
          },
        });
        table = toTable(grid, file, true, parseLimit, skipped);
      }
    }
    // Apply the cell budget now that the real width is known.
    const limit = rowLimitFor(table.columns.length);
    if (table.rows.length > limit) {
      table = { ...table, rows: table.rows.slice(0, limit), truncated: true };
    }
    cache.push({ key: cacheKey, table });
    if (cache.length > CACHE_ENTRIES) cache.shift();
    return table;
  } finally {
    await handle.close();
  }
}
