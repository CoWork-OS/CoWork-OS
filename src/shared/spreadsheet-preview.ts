export type SpreadsheetPreviewValueType = "number" | "boolean" | "date" | "string" | "error";

export interface SpreadsheetPreviewCell {
  address: string;
  row: number;
  column: number;
  /** Raw, editable value ("96.5", a formula's cached result); never number-formatted. */
  value: string;
  /** What Excel shows: the value through numFmt ("€96.50"), or "=FORMULA" with no result. */
  displayValue?: string;
  /** Excel number format code of the cell, omitted for General. */
  numFmt?: string;
  /** Type of the stored value (or of a formula's cached result). */
  valueType?: SpreadsheetPreviewValueType;
  /** A formula saved without a cached result, so its value is unknown until Excel recalculates. */
  formulaPending?: boolean;
  formula?: string;
  bold?: boolean;
  italic?: boolean;
  backgroundColor?: string;
  fontColor?: string;
  horizontalAlignment?: string;
}

export interface SpreadsheetPreviewSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  columnWidths: number[];
  rows: SpreadsheetPreviewCell[][];
  sourceRowCount?: number;
  truncated?: boolean;
}

export interface SpreadsheetPreview {
  activeSheetName?: string;
  sheetCount: number;
  sheets: SpreadsheetPreviewSheet[];
}

export function spreadsheetColumnLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}
