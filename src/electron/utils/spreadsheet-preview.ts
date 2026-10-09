import { readDocumentArchiveBuffer } from "../security/document-archive";
import ExcelJS from "exceljs";
import * as fs from "fs/promises";
import * as path from "path";
import {
  spreadsheetColumnLetter,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
  type SpreadsheetPreviewValueType,
} from "../../shared/spreadsheet-preview";
import { formatSpreadsheetValue } from "../../shared/spreadsheet-number-format";
import {
  coerceNumericText,
  coerceSpreadsheetDateText,
} from "./document-generators/spreadsheet-cells";
import { computeWorkbookFormulaResults } from "./document-generators/spreadsheet-formulas";

const MAX_PREVIEW_ROWS = 2000;
const MAX_PREVIEW_COLUMNS = 200;

function argbToCssColor(argb?: string): string | undefined {
  if (!argb) return undefined;
  const hex = argb.trim().replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(2)}`;
  if (hex.length === 6) return `#${hex}`;
  return undefined;
}

type PreviewCellContent = Pick<
  SpreadsheetPreviewCell,
  "value" | "displayValue" | "numFmt" | "valueType" | "formulaPending" | "formula"
>;

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return Boolean(
    value && typeof value === "object" && ("formula" in value || "sharedFormula" in value),
  );
}

/** Raw text, type and (for numbers and dates) the typed value a number format applies to. */
function readPlainValue(value: unknown): {
  text: string;
  valueType?: SpreadsheetPreviewValueType;
  typed?: number | Date;
} {
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "number") return { text: String(value), valueType: "number", typed: value };
  if (typeof value === "boolean") return { text: String(value), valueType: "boolean" };
  if (value instanceof Date) {
    return { text: value.toISOString(), valueType: "date", typed: value };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      const text = record.richText
        .map((entry) => (entry && typeof entry === "object" ? String(entry.text ?? "") : ""))
        .join("");
      return { text, valueType: "string" };
    }
    if ("text" in record) return { text: String(record.text ?? ""), valueType: "string" };
    if ("hyperlink" in record) return { text: String(record.hyperlink ?? ""), valueType: "string" };
    if ("error" in record) return { text: String(record.error ?? ""), valueType: "error" };
    if ("result" in record) return readPlainValue(record.result);
  }
  return { text: String(value), valueType: "string" };
}

/**
 * The preview content of one cell: the raw value stays in `value` for editing and saving, and
 * `displayValue` carries what Excel shows (number format applied, or the formula text when the
 * file has no cached result for it and CoWork cannot compute one).
 */
function readPreviewCell(cell: ExcelJS.Cell, date1904: boolean): PreviewCellContent {
  const raw = cell.value;
  const formula = isFormulaValue(raw) ? cell.formula || undefined : undefined;
  const numFmt =
    typeof cell.numFmt === "string" && cell.numFmt.trim() && !/^general$/i.test(cell.numFmt.trim())
      ? cell.numFmt
      : undefined;
  const base = { ...(formula ? { formula } : {}), ...(numFmt ? { numFmt } : {}) };
  // Cell.result, not raw.result: ExcelJS leaves a 0 or FALSE result out of the cell value, which
  // would show a zero total as its formula.
  const result: unknown = isFormulaValue(raw) ? cell.result : undefined;
  if (formula && isFormulaValue(raw) && (result === null || result === undefined)) {
    return { ...base, value: "", displayValue: `=${formula}`, formulaPending: true };
  }
  const plain = readPlainValue(isFormulaValue(raw) ? result : raw);
  const display =
    plain.typed === undefined ? null : formatSpreadsheetValue(plain.typed, numFmt, { date1904 });
  return {
    ...base,
    value: plain.text,
    ...(plain.valueType ? { valueType: plain.valueType } : {}),
    ...(display !== null && display !== plain.text ? { displayValue: display } : {}),
  };
}

function isStyled(cell: ExcelJS.Cell): boolean {
  return Boolean(
    cell.font?.bold ||
    cell.font?.italic ||
    cell.font?.color?.argb ||
    cell.fill?.type === "pattern" ||
    cell.alignment?.horizontal,
  );
}

export async function buildSpreadsheetPreviewFromFile(
  filePath: string,
): Promise<SpreadsheetPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await readDocumentArchiveBuffer(filePath)) as unknown as ExcelJS.Buffer,
  );

  // Files saved by tools that drop cached formula results (openpyxl, for one) would show every
  // formula as text: compute the missing results for display. The file is not changed, and
  // results the file already carries are shown as saved.
  computeWorkbookFormulaResults(workbook, { onlyMissing: true });

  const date1904 = Boolean(workbook.properties?.date1904);
  const sheets = workbook.worksheets.map((worksheet) => {
    const sourceRowCount = Math.max(worksheet.actualRowCount || 0, worksheet.rowCount || 0);
    const sourceColumnCount = Math.max(
      worksheet.actualColumnCount || 0,
      worksheet.columnCount || 0,
    );
    const rowCount = Math.min(sourceRowCount, MAX_PREVIEW_ROWS);
    const columnCount = Math.min(sourceColumnCount, MAX_PREVIEW_COLUMNS);
    const columnWidths = Array.from({ length: columnCount }, (_, index) => {
      const width = worksheet.getColumn(index + 1).width;
      return typeof width === "number" && Number.isFinite(width) ? width : 10;
    });

    const rows: SpreadsheetPreviewCell[][] = [];
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const row = worksheet.getRow(rowIndex);
      const cells: SpreadsheetPreviewCell[] = [];
      for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        const cell = row.getCell(columnIndex);
        const fill =
          cell.fill?.type === "pattern" ? argbToCssColor(cell.fill.fgColor?.argb) : undefined;
        const fontColor = argbToCssColor(cell.font?.color?.argb);
        const styled = isStyled(cell);
        cells.push({
          address: `${spreadsheetColumnLetter(columnIndex - 1)}${rowIndex}`,
          row: rowIndex,
          column: columnIndex,
          ...readPreviewCell(cell, date1904),
          ...(cell.font?.bold ? { bold: true } : {}),
          ...(cell.font?.italic ? { italic: true } : {}),
          ...(fill ? { backgroundColor: fill } : {}),
          ...(fontColor ? { fontColor } : {}),
          ...(styled && cell.alignment?.horizontal
            ? { horizontalAlignment: String(cell.alignment.horizontal) }
            : {}),
        });
      }
      rows.push(cells);
    }

    return {
      name: worksheet.name,
      rowCount,
      columnCount,
      columnWidths,
      rows,
      sourceRowCount,
      truncated: sourceRowCount > rowCount || sourceColumnCount > columnCount,
    };
  });

  return {
    activeSheetName: sheets[0]?.name,
    sheetCount: sheets.length,
    sheets,
  };
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ""));
}

function escapeDelimitedCell(value: string, delimiter: string): string {
  if (!/["\r\n]/.test(value) && !value.includes(delimiter)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function detectDelimitedRecordLineEnding(content: string, delimiter: string): string {
  let inQuotes = false;
  let atCellStart = true;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inQuotes) {
      if (char === '"' && content[index + 1] === '"') index += 1;
      else if (char === '"') inQuotes = false;
      continue;
    }
    if (char === '"' && atCellStart) inQuotes = true;
    else if (char === delimiter) atCellStart = true;
    else if (char === "\r") return content[index + 1] === "\n" ? "\r\n" : "\r";
    else if (char === "\n") return "\n";
    else atCellStart = false;
  }
  return "\n";
}

export function buildDelimitedSpreadsheetPreview(
  content: string,
  options: {
    delimiter: "," | "\t";
    sheetName?: string;
  },
): SpreadsheetPreview {
  const rawRows = parseDelimitedRows(content, options.delimiter);
  const maxColumns = rawRows.length > 0 ? Math.max(...rawRows.map((row) => row.length)) : 0;
  const columnCount = Math.min(maxColumns, MAX_PREVIEW_COLUMNS);
  const previewRows = rawRows.slice(0, MAX_PREVIEW_ROWS);
  const rows = previewRows.map((row, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => ({
      address: `${spreadsheetColumnLetter(columnIndex)}${rowIndex + 1}`,
      row: rowIndex + 1,
      column: columnIndex + 1,
      value: row[columnIndex] || "",
      ...(rowIndex === 0 ? { bold: true } : {}),
    })),
  );
  const sheetName = options.sheetName || "Sheet";

  return {
    activeSheetName: sheetName,
    sheetCount: 1,
    sheets: [
      {
        name: sheetName,
        rowCount: rows.length,
        columnCount,
        columnWidths: Array.from({ length: columnCount }, () => 12),
        rows,
        sourceRowCount: rawRows.length,
        truncated: rawRows.length > rows.length || maxColumns > columnCount,
      },
    ],
  };
}

export function spreadsheetPreviewToDelimitedText(
  preview: SpreadsheetPreview,
  delimiter: "," | "\t",
): string {
  const sheet = preview.sheets[0];
  if (!sheet) return "";
  const rowCount = Math.min(sheet.rowCount || sheet.rows.length || 0, MAX_PREVIEW_ROWS);
  const maxColumns = sheet.rows.length > 0 ? Math.max(...sheet.rows.map((row) => row.length)) : 0;
  const columnCount = Math.min(sheet.columnCount || maxColumns, MAX_PREVIEW_COLUMNS);

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = sheet.rows[rowIndex] || [];
    return Array.from({ length: columnCount }, (_, columnIndex) =>
      escapeDelimitedCell(row[columnIndex]?.value || "", delimiter),
    ).join(delimiter);
  }).join("\n");
}

export async function writeDelimitedSpreadsheetPreviewToFile(
  filePath: string,
  preview: SpreadsheetPreview,
  delimiter: "," | "\t",
): Promise<SpreadsheetPreview> {
  const sheet = preview.sheets[0];
  if (!sheet) {
    await fs.writeFile(filePath, "", "utf-8");
    return buildDelimitedSpreadsheetPreview("", {
      delimiter,
      sheetName: path.basename(filePath, path.extname(filePath)),
    });
  }

  let originalContent = "";
  let originalRows: string[][] = [];
  try {
    originalContent = await fs.readFile(filePath, "utf-8");
    originalRows = parseDelimitedRows(originalContent, delimiter);
  } catch {
    originalRows = [];
  }

  const previewRowCount = sheet.rows.length;
  const editableSourceRowCount = sheet.truncated
    ? Math.min(sheet.sourceRowCount || originalRows.length || previewRowCount, MAX_PREVIEW_ROWS)
    : previewRowCount;
  const appendedPreviewRows = sheet.truncated ? sheet.rows.slice(editableSourceRowCount) : [];
  const targetRowCount = sheet.truncated
    ? Math.max(sheet.sourceRowCount || 0, originalRows.length, editableSourceRowCount)
    : previewRowCount;
  const previewColumnCount = Math.min(
    sheet.columnCount || Math.max(...sheet.rows.map((row) => row.length), 0),
    MAX_PREVIEW_COLUMNS,
  );

  const lines = Array.from({ length: targetRowCount }, (_, rowIndex) => {
    const previewRow = rowIndex < editableSourceRowCount ? sheet.rows[rowIndex] : undefined;
    const originalRow = originalRows[rowIndex] || [];
    const rowValues = previewRow
      ? Array.from(
          { length: previewColumnCount },
          (_, columnIndex) => previewRow[columnIndex]?.value || "",
        )
      : originalRow.slice();
    if (sheet.truncated && previewRow && originalRow.length > previewColumnCount) {
      rowValues.push(...originalRow.slice(previewColumnCount));
    }
    return rowValues.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter);
  });
  for (const previewRow of appendedPreviewRows) {
    const rowValues = Array.from(
      { length: previewColumnCount },
      (_, columnIndex) => previewRow[columnIndex]?.value || "",
    );
    lines.push(rowValues.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter));
  }

  const lineEnding = detectDelimitedRecordLineEnding(originalContent, delimiter);
  const finalLineEnding =
    /(?:\r\n|\n|\r)$/.test(originalContent) && lines.length > 0 ? lineEnding : "";
  await fs.writeFile(filePath, lines.join(lineEnding) + finalLineEnding, "utf-8");
  const content = await fs.readFile(filePath, "utf-8");
  return buildDelimitedSpreadsheetPreview(content, {
    delimiter,
    sheetName: path.basename(filePath, path.extname(filePath)),
  });
}

function previewFormula(cell: SpreadsheetPreviewCell): string {
  return typeof cell.formula === "string" ? cell.formula.trim().replace(/^=/, "") : "";
}

/**
 * Whether a preview cell (which may come from the renderer, so only `value` and `formula` are
 * trusted) still holds what the workbook cell holds. Unchanged cells are left alone on save, so
 * numbers, dates, rich text and shared formulas keep their type.
 */
function isPreviewCellUnchanged(
  cellPreview: SpreadsheetPreviewCell,
  cell: ExcelJS.Cell,
  date1904: boolean,
): boolean {
  const current = readPreviewCell(cell, date1904);
  const formula = previewFormula(cellPreview);
  if (formula || current.formula) return formula === (current.formula ?? "");
  return cellPreview.value === current.value;
}

/**
 * Writes an edited cell. Formulas get no cached result here (it is computed before writing, and
 * never the formula text); numeric text becomes a number and date text a date with the same
 * rules as create_spreadsheet, judged by the workbook cell's own number format. displayValue,
 * numFmt and valueType from the preview are display data and are ignored.
 */
function writePreviewCellInput(target: ExcelJS.Cell, cell: SpreadsheetPreviewCell): void {
  const formula = previewFormula(cell);
  if (formula) {
    target.value = { formula } as ExcelJS.CellFormulaValue;
    return;
  }
  const value = typeof cell.value === "string" ? cell.value : String(cell.value ?? "");
  const date = value === "" ? null : coerceSpreadsheetDateText(value, target.numFmt);
  if (date) {
    target.value = date.date;
    if (date.numFmt) target.numFmt = date.numFmt;
    return;
  }
  target.value = value === "" ? null : coerceNumericText(value);
}

export async function writeSpreadsheetPreviewToFile(
  filePath: string,
  preview: SpreadsheetPreview,
): Promise<SpreadsheetPreview> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      (await readDocumentArchiveBuffer(filePath)) as unknown as ExcelJS.Buffer,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // If the file was removed between preview and save, recreate a workbook.
  }

  const date1904 = Boolean(workbook.properties?.date1904);
  for (const sheetPreview of preview.sheets) {
    const worksheet =
      workbook.getWorksheet(sheetPreview.name) ||
      workbook.addWorksheet(sheetPreview.name || "Sheet");
    const rowCount = Math.min(
      sheetPreview.rowCount || sheetPreview.rows.length || 0,
      MAX_PREVIEW_ROWS,
    );
    const columnCount = Math.min(
      sheetPreview.columnCount || Math.max(...sheetPreview.rows.map((row) => row.length), 0),
      MAX_PREVIEW_COLUMNS,
    );

    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const width = sheetPreview.columnWidths[columnIndex - 1];
      if (typeof width === "number" && Number.isFinite(width)) {
        worksheet.getColumn(columnIndex).width = width;
      }
    }

    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const rowPreview = sheetPreview.rows[rowIndex - 1] || [];
      const row = worksheet.getRow(rowIndex);
      for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        const cellPreview = rowPreview[columnIndex - 1];
        const cell = row.getCell(columnIndex);
        if (cellPreview && isPreviewCellUnchanged(cellPreview, cell, date1904)) continue;
        if (cellPreview) writePreviewCellInput(cell, cellPreview);
        else cell.value = null;
      }
      row.commit();
    }

    if (!sheetPreview.truncated) {
      // Deleted rows/columns shrink the preview; clear what they left behind in
      // the original worksheet. Truncated previews cannot change structure.
      worksheet.eachRow({ includeEmpty: false }, (row, rowIndex) => {
        row.eachCell({ includeEmpty: false }, (cell, columnIndex) => {
          if (rowIndex > rowCount || columnIndex > columnCount) cell.value = null;
        });
        row.commit();
      });
    }
  }

  // Edits change what formulas compute: refresh the results CoWork can evaluate and have Excel
  // recalculate the rest on open.
  computeWorkbookFormulaResults(workbook);
  workbook.calcProperties.fullCalcOnLoad = true;
  await workbook.xlsx.writeFile(filePath);
  return buildSpreadsheetPreviewFromFile(filePath);
}

export function spreadsheetPreviewToTsv(preview: SpreadsheetPreview): string {
  return preview.sheets
    .map((sheet) => {
      const lines = [`## Sheet: ${sheet.name}`];
      for (const row of sheet.rows) {
        lines.push(row.map((cell) => cell.displayValue ?? cell.value).join("\t"));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
