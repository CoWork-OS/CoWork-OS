/**
 * Cell normalisation shared by the spreadsheet writers (create_spreadsheet, generate_spreadsheet).
 *
 * Models usually send every cell as a string. Written as-is, "1200" is stored as text and
 * "=SUM(B2:B3)" as a literal string, so Excel, Google Sheets and LibreOffice compute 0 (or
 * nothing) for every formula. Formula strings become ExcelJS formulas and unambiguous numeric
 * strings become numbers; anything that only looks numeric (codes, ids, versions) stays text.
 */
import type ExcelJS from "exceljs";

/** Plain or comma-grouped integers/decimals: "1200", "-0.75", "1,234.50". */
const NUMERIC_TEXT_PATTERN = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** Excel keeps 15 significant digits; longer digit strings are ids or card numbers. */
const MAX_NUMERIC_DIGITS = 15;
/** "+" followed by this many digits reads as an international phone number. */
const MIN_PHONE_DIGITS = 8;

/** Converts unambiguous numeric text to a number; returns other values unchanged. */
export function coerceNumericText(value: string): number | string {
  const trimmed = value.trim();
  if (!NUMERIC_TEXT_PATTERN.test(trimmed)) return value;
  const unsigned = trimmed.replace(/^[-+]/, "");
  // A leading zero marks a code that must keep its digits: zip codes, account numbers, "007".
  if (/^0\d/.test(unsigned)) return value;
  const digits = unsigned.replace(/\D/g, "");
  if (digits.replace(/^0+/, "").length > MAX_NUMERIC_DIGITS) return value;
  if (trimmed.startsWith("+") && digits.length >= MIN_PHONE_DIGITS) return value;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * A cell value ExcelJS can only write as plain data. ExcelJS reads object values by shape, as a
 * formula ({ formula }), hyperlink ({ text, hyperlink }), rich text or error cell, and the tool
 * cell schemas do not restrict the type, so an object or array from tool input is written as its
 * JSON text instead.
 */
export function toPlainSpreadsheetValue(
  value: unknown,
): string | number | boolean | Date | null | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalises one cell for ExcelJS: "=..." strings become formulas and, unless disabled (header
 * rows keep their labels as text), numeric text becomes a number. Other values are made plain
 * (see toPlainSpreadsheetValue).
 */
export function normalizeSpreadsheetCell(
  value: unknown,
  options: { coerceNumbers?: boolean } = {},
): unknown {
  if (typeof value !== "string") return toPlainSpreadsheetValue(value);
  const trimmed = value.trim();
  if (trimmed.startsWith("=") && trimmed.length > 1) {
    return { formula: trimmed.slice(1) };
  }
  return options.coerceNumbers === false ? value : coerceNumericText(value);
}

/**
 * A number format requested through tool input: an Excel format code ("€#,##0.00", "0.0%",
 * "yyyy-mm-dd") for a column (letter or header text) or an A1 cell/range. Fields are unknown
 * because tool input is not validated before it reaches the writers.
 */
export interface SpreadsheetNumberFormatInput {
  column?: unknown;
  range?: unknown;
  numFmt?: unknown;
}

/**
 * Tool input schema for a sheet's numberFormats (create_spreadsheet, generate_spreadsheet). An
 * array of { column | range, numFmt } rather than a column-to-format map: Gemini drops
 * additionalProperties, which would leave a map schema empty.
 */
export const SPREADSHEET_NUMBER_FORMATS_SCHEMA = {
  type: "array",
  description:
    'Optional Excel number formats for currency, decimals, percentages and dates. Column formats skip the header row. E.g. [{"column":"Amount EUR","numFmt":"€#,##0.00;[Red]-€#,##0.00"},{"range":"B2:B6","numFmt":"€#,##0.00"}]',
  items: {
    type: "object",
    properties: {
      column: {
        type: "string",
        description: 'Column letter ("D") or exact header text ("Amount EUR")',
      },
      range: {
        type: "string",
        description: 'A cell or range instead of a column, e.g. "B6" or "B2:B6"',
      },
      numFmt: {
        type: "string",
        description:
          'Excel format code: "€#,##0.00", "$#,##0.00", "#,##0", "0.00", "0%", "0.0%", "yyyy-mm-dd"',
      },
    },
    required: ["numFmt"],
  },
};

/** Excel rejects number format codes longer than 255 characters. */
const MAX_NUMBER_FORMAT_LENGTH = 255;
const MAX_FORMATTED_RANGE_CELLS = 100_000;
const MAX_WORKSHEET_ROW = 1_048_576;
const MAX_WORKSHEET_COLUMN = 16_384;
const A1_RANGE_PATTERN = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i;

function columnNumberFromLetters(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function isValidNumberFormat(numFmt: string): boolean {
  if (!numFmt || numFmt.length > MAX_NUMBER_FORMAT_LENGTH) return false;
  for (const ch of numFmt) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** Header text wins over a column letter, so a header named "ID" is not read as column ID. */
function resolveFormatColumn(column: unknown, headerRow: unknown[]): number | null {
  if (typeof column !== "string" || !column.trim()) return null;
  const label = column.trim().toLowerCase();
  const headerIndex = headerRow.findIndex(
    (header) => typeof header === "string" && header.trim().toLowerCase() === label,
  );
  if (headerIndex >= 0) return headerIndex + 1;
  if (!/^[a-z]{1,3}$/.test(label)) return null;
  const index = columnNumberFromLetters(label);
  return index <= MAX_WORKSHEET_COLUMN ? index : null;
}

/**
 * Applies requested number formats to a worksheet. Column formats cover the data rows (not the
 * header); range formats cover exactly the cells named. Requests that cannot be applied are
 * returned as warnings instead of failing the whole workbook.
 */
export function applySpreadsheetNumberFormats(
  worksheet: ExcelJS.Worksheet,
  formats: unknown,
  options: { headerRow?: unknown[]; firstDataRow: number },
): string[] {
  if (formats === undefined || formats === null) return [];
  const sheetLabel = `Sheet "${worksheet.name}"`;
  if (!Array.isArray(formats)) {
    return [`${sheetLabel}: numberFormats must be an array; no number formats were applied.`];
  }
  const warnings: string[] = [];
  const lastRow = Math.max(worksheet.rowCount, options.firstDataRow);
  for (const entry of formats) {
    const spec: SpreadsheetNumberFormatInput = entry && typeof entry === "object" ? entry : {};
    const numFmt = typeof spec.numFmt === "string" ? spec.numFmt.trim() : "";
    if (!isValidNumberFormat(numFmt)) {
      warnings.push(
        `${sheetLabel}: skipped invalid number format ${JSON.stringify(spec.numFmt ?? null)}.`,
      );
      continue;
    }
    if (typeof spec.range === "string" && spec.range.trim()) {
      const match = A1_RANGE_PATTERN.exec(spec.range.trim());
      const c1 = match ? columnNumberFromLetters(match[1]) : 0;
      const r1 = match ? Number(match[2]) : 0;
      const c2 = match?.[3] ? columnNumberFromLetters(match[3]) : c1;
      const r2 = match?.[4] ? Number(match[4]) : r1;
      const [top, bottom] = [Math.min(r1, r2), Math.max(r1, r2)];
      const [left, right] = [Math.min(c1, c2), Math.max(c1, c2)];
      if (
        !match ||
        top < 1 ||
        bottom > MAX_WORKSHEET_ROW ||
        right > MAX_WORKSHEET_COLUMN ||
        (bottom - top + 1) * (right - left + 1) > MAX_FORMATTED_RANGE_CELLS
      ) {
        warnings.push(
          `${sheetLabel}: range ${JSON.stringify(spec.range)} is not a usable A1 range, so "${numFmt}" was not applied.`,
        );
        continue;
      }
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          worksheet.getCell(row, column).numFmt = numFmt;
        }
      }
      continue;
    }
    const column = resolveFormatColumn(spec.column, options.headerRow ?? []);
    if (!column) {
      warnings.push(
        `${sheetLabel}: column ${JSON.stringify(spec.column ?? null)} was not found, so "${numFmt}" was not applied.`,
      );
      continue;
    }
    for (let row = options.firstDataRow; row <= lastRow; row += 1) {
      worksheet.getCell(row, column).numFmt = numFmt;
    }
  }
  return warnings;
}
