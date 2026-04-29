import ExcelJS from "exceljs";
import * as fs from "fs/promises";
import * as path from "path";
import {
  spreadsheetColumnLetter,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
} from "../../shared/spreadsheet-preview";

type ExcelCellValue = ExcelJS.CellValue;

const MAX_PREVIEW_ROWS = 2000;
const MAX_PREVIEW_COLUMNS = 200;

function argbToCssColor(argb?: string): string | undefined {
  if (!argb) return undefined;
  const hex = argb.trim().replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(2)}`;
  if (hex.length === 6) return `#${hex}`;
  return undefined;
}

function getFormulaDisplayValue(value: ExcelCellValue): string | null {
  if (!value || typeof value !== "object" || !("formula" in value)) return null;
  const result = (value as ExcelJS.CellFormulaValue).result;
  if (result === null || result === undefined) return "";
  if (result instanceof Date) return result.toISOString();
  return String(result);
}

function getCellDisplayValue(cell: ExcelJS.Cell): string {
  const formulaValue = getFormulaDisplayValue(cell.value);
  if (formulaValue !== null) return formulaValue;

  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value) {
      return value.richText?.map((entry) => entry.text).join("") ?? "";
    }
    if ("text" in value) return String(value.text ?? "");
    if ("hyperlink" in value) {
      const hyperlinkValue = value as { hyperlink?: unknown; text?: unknown };
      return String(hyperlinkValue.text ?? hyperlinkValue.hyperlink ?? "");
    }
    if ("error" in value) return String(value.error ?? "");
    if ("result" in value) return String(value.result ?? "");
  }
  return String(value);
}

function getCellFormula(cell: ExcelJS.Cell): string | undefined {
  const value = cell.value;
  if (!value || typeof value !== "object" || !("formula" in value)) return undefined;
  return value.formula || undefined;
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
  await workbook.xlsx.readFile(filePath);

  const sheets = workbook.worksheets.map((worksheet) => {
    const rowCount = Math.min(worksheet.actualRowCount || worksheet.rowCount || 0, MAX_PREVIEW_ROWS);
    const columnCount = Math.min(
      worksheet.actualColumnCount || worksheet.columnCount || 0,
      MAX_PREVIEW_COLUMNS,
    );
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
        const value = getCellDisplayValue(cell);
        const formula = getCellFormula(cell);
        const styled = isStyled(cell);
        cells.push({
          address: `${spreadsheetColumnLetter(columnIndex - 1)}${rowIndex}`,
          row: rowIndex,
          column: columnIndex,
          value,
          ...(formula ? { formula } : {}),
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
  if (!/[\"\r\n]/.test(value) && !value.includes(delimiter)) return value;
  return `"${value.replace(/"/g, '""')}"`;
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
  const columnCount = Math.min(
    sheet.columnCount || maxColumns,
    MAX_PREVIEW_COLUMNS,
  );

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

  let originalRows: string[][] = [];
  try {
    originalRows = parseDelimitedRows(await fs.readFile(filePath, "utf-8"), delimiter);
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
    : Math.max(sheet.rowCount || 0, previewRowCount, originalRows.length);
  const previewColumnCount = Math.min(
    sheet.columnCount || Math.max(...sheet.rows.map((row) => row.length), 0),
    MAX_PREVIEW_COLUMNS,
  );

  const lines = Array.from({ length: targetRowCount }, (_, rowIndex) => {
    const previewRow = rowIndex < editableSourceRowCount ? sheet.rows[rowIndex] : undefined;
    const originalRow = originalRows[rowIndex] || [];
    const rowValues = previewRow
      ? Array.from({ length: previewColumnCount }, (_, columnIndex) =>
          previewRow[columnIndex]?.value || "",
        )
      : originalRow.slice();
    if (previewRow && originalRow.length > previewColumnCount) {
      rowValues.push(...originalRow.slice(previewColumnCount));
    }
    return rowValues.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter);
  });
  for (const previewRow of appendedPreviewRows) {
    const rowValues = Array.from({ length: previewColumnCount }, (_, columnIndex) =>
      previewRow[columnIndex]?.value || "",
    );
    lines.push(rowValues.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter));
  }

  await fs.writeFile(filePath, lines.join("\n"), "utf-8");
  const content = await fs.readFile(filePath, "utf-8");
  return buildDelimitedSpreadsheetPreview(content, {
    delimiter,
    sheetName: path.basename(filePath, path.extname(filePath)),
  });
}

function getPreviewCellInput(cell: SpreadsheetPreviewCell): ExcelJS.CellValue {
  if (cell.formula) {
    return {
      formula: cell.formula.replace(/^=/, ""),
      result: cell.value || undefined,
    };
  }
  return cell.value === "" ? null : cell.value;
}

export async function writeSpreadsheetPreviewToFile(
  filePath: string,
  preview: SpreadsheetPreview,
): Promise<SpreadsheetPreview> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    // If the file was removed between preview and save, recreate a workbook.
  }

  for (const sheetPreview of preview.sheets) {
    const worksheet =
      workbook.getWorksheet(sheetPreview.name) || workbook.addWorksheet(sheetPreview.name || "Sheet");
    const rowCount = Math.min(sheetPreview.rowCount || sheetPreview.rows.length || 0, MAX_PREVIEW_ROWS);
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
        cell.value = cellPreview ? getPreviewCellInput(cellPreview) : null;
      }
      row.commit();
    }
  }

  await workbook.xlsx.writeFile(filePath);
  return buildSpreadsheetPreviewFromFile(filePath);
}

export function spreadsheetPreviewToTsv(preview: SpreadsheetPreview): string {
  return preview.sheets
    .map((sheet) => {
      const lines = [`## Sheet: ${sheet.name}`];
      for (const row of sheet.rows) {
        lines.push(row.map((cell) => cell.value).join("\t"));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
