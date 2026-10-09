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

/** Format a cell gets when ISO date text becomes a date and no date format was requested. */
export const DEFAULT_DATE_NUMBER_FORMAT = "yyyy-mm-dd";
const DEFAULT_DATE_TIME_NUMBER_FORMAT = "yyyy-mm-dd hh:mm";
const DEFAULT_DATE_TIME_SECONDS_NUMBER_FORMAT = "yyyy-mm-dd hh:mm:ss";

/** "2026-10-05", "2026-10-05T09:30", "2026-10-05 09:30:15", "2026-10-05T09:30:15.250Z". */
const ISO_DATE_TEXT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/;
/** "05/10/2026", "5.10.2026", "10-05-2026": read in the day/month order of the cell's format. */
const NUMERIC_DATE_TEXT_PATTERN = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
/** "2026/10/05", "2026.10.05": year first is never ambiguous. */
const YEAR_FIRST_DATE_TEXT_PATTERN = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})$/;
const MIN_DATE_YEAR = 1900;
const MAX_DATE_YEAR = 9999;

/** A format code without its quoted text, escaped characters and [colour]/[$locale] parts. */
function dateTokensOf(numFmt: string): string {
  return numFmt
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .toLowerCase();
}

/** Whether an Excel number format code displays a calendar date (it has day or year codes). */
export function isDateNumberFormat(numFmt: unknown): boolean {
  if (typeof numFmt !== "string") return false;
  const code = numFmt.trim();
  if (!code || /^general$/i.test(code) || code === "@") return false;
  return /[dy]/.test(dateTokensOf(code));
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  ms = 0,
): Date | null {
  if (year < MIN_DATE_YEAR || year > MAX_DATE_YEAR || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms));
  // Rejects 2026-02-30 and 31/04/2026 instead of rolling them into the next month.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

export interface SpreadsheetDateText {
  /** The date at UTC, which is how ExcelJS turns a Date into an Excel serial. */
  date: Date;
  /** "date", or the precision of the time of day the text carries. */
  precision: "date" | "minutes" | "seconds";
}

/**
 * Reads text that unambiguously names a calendar date: ISO dates (optionally with a time of day)
 * always, and day/month/year text only when `dateNumFmt` is a date format that fixes the order
 * of day and month ("dd/mm/yyyy" reads 05/10/2026 as 5 October). Anything else, including ids
 * such as "00041" or "CR-0041" and impossible dates, returns null.
 */
export function parseSpreadsheetDateText(
  text: string,
  dateNumFmt?: string,
): SpreadsheetDateText | null {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 30) return null;
  const iso = ISO_DATE_TEXT_PATTERN.exec(trimmed);
  if (iso) {
    const [, y, mo, d, h, mi, s, ms] = iso;
    if (!h && trimmed.endsWith("Z")) return null;
    const date = utcDate(
      Number(y),
      Number(mo),
      Number(d),
      Number(h ?? 0),
      Number(mi ?? 0),
      Number(s ?? 0),
      Number((ms ?? "0").padEnd(3, "0")),
    );
    if (!date) return null;
    return { date, precision: !h ? "date" : s ? "seconds" : "minutes" };
  }
  if (!dateNumFmt || !isDateNumberFormat(dateNumFmt)) return null;
  const yearFirst = YEAR_FIRST_DATE_TEXT_PATTERN.exec(trimmed);
  if (yearFirst) {
    const date = utcDate(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
    return date ? { date, precision: "date" } : null;
  }
  const numeric = NUMERIC_DATE_TEXT_PATTERN.exec(trimmed);
  if (!numeric) return null;
  const tokens = dateTokensOf(dateNumFmt);
  const dayIndex = tokens.indexOf("d");
  const monthIndex = tokens.indexOf("m");
  if (dayIndex < 0 || monthIndex < 0) return null;
  const [first, second] = [Number(numeric[1]), Number(numeric[3])];
  const date =
    dayIndex < monthIndex
      ? utcDate(Number(numeric[4]), second, first)
      : utcDate(Number(numeric[4]), first, second);
  return date ? { date, precision: "date" } : null;
}

function defaultDateFormat(precision: SpreadsheetDateText["precision"]): string {
  if (precision === "seconds") return DEFAULT_DATE_TIME_SECONDS_NUMBER_FORMAT;
  return precision === "minutes" ? DEFAULT_DATE_TIME_NUMBER_FORMAT : DEFAULT_DATE_NUMBER_FORMAT;
}

/**
 * The date a text cell should hold instead of its text, and the number format to give it when
 * it has no date format yet. ISO dates qualify unless the cell is formatted as text ("@") or
 * with a non-date number format; day/month text qualifies only under a date format that fixes
 * its order. Returns null for everything else.
 */
export function coerceSpreadsheetDateText(
  text: string,
  numFmt: unknown,
): { date: Date; numFmt?: string } | null {
  const code = typeof numFmt === "string" ? numFmt.trim() : "";
  const dateFormat = isDateNumberFormat(code);
  if (!dateFormat && code && !/^general$/i.test(code)) return null;
  const parsed = parseSpreadsheetDateText(text, dateFormat ? code : undefined);
  if (!parsed) return null;
  return dateFormat
    ? { date: parsed.date }
    : { date: parsed.date, numFmt: defaultDateFormat(parsed.precision) };
}

/**
 * Stores date text in data cells as real Excel dates (see coerceSpreadsheetDateText). Models
 * send dates as text, and a date number format applied to text changes nothing: the cell stays
 * a string that cannot be sorted, filtered or used in date arithmetic, and Excel shows it
 * unformatted. A converted cell keeps its requested date format, or gets an ISO one. Returns how
 * many cells were converted.
 */
export function convertSpreadsheetDateText(
  worksheet: ExcelJS.Worksheet,
  options: { firstDataRow: number },
): number {
  let converted = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < options.firstDataRow) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value !== "string") return;
      const coerced = coerceSpreadsheetDateText(cell.value, cell.numFmt);
      if (!coerced) return;
      cell.value = coerced.date;
      if (coerced.numFmt) cell.numFmt = coerced.numFmt;
      converted += 1;
    });
  });
  return converted;
}

/**
 * Text cells that carry a date number format, such as "2026-10-05" formatted "DD/MM/YYYY":
 * Excel shows them as the raw text and cannot sort, filter or compute with them. Used to report
 * them after a workbook is changed outside the native writer (see restoreXlsxFormulaCaches).
 */
export function findDateFormattedTextCells(worksheet: ExcelJS.Worksheet): string[] {
  const addresses: string[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      const text =
        typeof value === "string"
          ? value
          : value && typeof value === "object" && "richText" in value
            ? value.richText.map((part) => part.text).join("")
            : null;
      if (text !== null && text.trim() && isDateNumberFormat(cell.numFmt)) {
        addresses.push(cell.address);
      }
    });
  });
  return addresses;
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
    'Optional Excel number formats for currency, decimals, percentages and dates. Column formats skip the header row. Send dates as ISO text ("2026-10-05"): they are stored as real Excel dates, shown with the column\'s date format (e.g. "dd/mm/yyyy") or as yyyy-mm-dd. Use "@" to keep a column as text. E.g. [{"column":"Amount EUR","numFmt":"€#,##0.00;[Red]-€#,##0.00"},{"column":"Date","numFmt":"dd/mm/yyyy"},{"range":"B2:B6","numFmt":"€#,##0.00"}]',
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
 * Applies requested number formats to a worksheet, then stores date text in the data rows as
 * real dates (see convertSpreadsheetDateText), so it runs for every sheet the writers create,
 * with or without formats. Column formats cover the data rows (not the header); range formats
 * cover exactly the cells named. Requests that cannot be applied are returned as warnings instead
 * of failing the whole workbook.
 */
export function applySpreadsheetNumberFormats(
  worksheet: ExcelJS.Worksheet,
  formats: unknown,
  options: { headerRow?: unknown[]; firstDataRow: number },
): string[] {
  const warnings = applyRequestedNumberFormats(worksheet, formats, options);
  convertSpreadsheetDateText(worksheet, options);
  return warnings;
}

function applyRequestedNumberFormats(
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
