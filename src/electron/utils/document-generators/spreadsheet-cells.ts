/**
 * Cell normalisation shared by the spreadsheet writers (create_spreadsheet, generate_spreadsheet).
 *
 * Models usually send every cell as a string. Written as-is, "1200" is stored as text and
 * "=SUM(B2:B3)" as a literal string, so Excel, Google Sheets and LibreOffice compute 0 (or
 * nothing) for every formula. Formula strings become ExcelJS formulas and unambiguous numeric
 * strings become numbers; anything that only looks numeric (codes, ids, versions) stays text.
 */

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
