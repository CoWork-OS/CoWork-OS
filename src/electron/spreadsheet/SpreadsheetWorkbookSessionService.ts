import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  spreadsheetColumnLetter,
  type SpreadsheetPreview,
  type SpreadsheetPreviewCell,
  type SpreadsheetPreviewSheet,
} from "../../shared/spreadsheet-preview";
import type {
  SpreadsheetApplyPatchesResult,
  SpreadsheetCapabilities,
  SpreadsheetCellData,
  SpreadsheetCellInput,
  SpreadsheetCompatibilityWarning,
  SpreadsheetOpenWorkbookResult,
  SpreadsheetPatch,
  SpreadsheetSaveWorkbookResult,
  SpreadsheetViewport,
  SpreadsheetViewportRequest,
  SpreadsheetViewportResult,
  SpreadsheetWorkbookFormat,
  SpreadsheetWorkbookSession,
} from "../../shared/spreadsheet-workbook";
import {
  buildDelimitedSpreadsheetPreview,
  buildSpreadsheetPreviewFromFile,
  spreadsheetPreviewToTsv,
  writeDelimitedSpreadsheetPreviewToFile,
  writeSpreadsheetPreviewToFile,
} from "../utils/spreadsheet-preview";

type SessionRecord = {
  session: SpreadsheetWorkbookSession;
  preview: SpreadsheetPreview;
  filePath: string;
  workspacePath: string;
};

const DEFAULT_VIEWPORT_ROWS = 80;
const DEFAULT_VIEWPORT_COLUMNS = 40;
const MAX_VIEWPORT_ROWS = 500;
const MAX_VIEWPORT_COLUMNS = 200;
const MAX_SESSION_COUNT = 20;
const MAX_PATCHES_PER_APPLY = 10_000;
const MAX_RANGE_PATCH_CELLS = 50_000;
const MAX_WORKSHEET_ROWS = 1_048_576;
const MAX_WORKSHEET_COLUMNS = 16_384;

const BASE_CAPABILITIES: SpreadsheetCapabilities = {
  canEditCells: true,
  canEditStructure: true,
  canEditFormatting: false,
  canRecalculateFormulas: false,
  preservesUnsupportedWorkbookParts: false,
};

function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeFormat(filePath: string): SpreadsheetWorkbookFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".tsv") return "tsv";
  if (ext === ".xlsm") return "xlsm";
  return "xlsx";
}

async function resolveWorkbookPathWithinWorkspace(
  filePath: string,
  workspacePath: string,
): Promise<{ filePath: string; workspacePath: string }> {
  const workspaceRealPath = await fs.realpath(workspacePath);
  const candidatePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspaceRealPath, filePath);
  const fileRealPath = await fs.realpath(candidatePath);
  const relative = path.relative(workspaceRealPath, fileRealPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Spreadsheet workbook path must stay within the workspace");
  }
  return {
    filePath: fileRealPath,
    workspacePath: workspaceRealPath,
  };
}

function clampWorksheetRow(value: number, fallback: number): number {
  return Math.min(MAX_WORKSHEET_ROWS, clampPositiveInteger(value, fallback));
}

function clampWorksheetColumn(value: number, fallback: number): number {
  return Math.min(MAX_WORKSHEET_COLUMNS, clampPositiveInteger(value, fallback));
}

function createCell(row: number, column: number): SpreadsheetPreviewCell {
  return {
    address: `${spreadsheetColumnLetter(column - 1)}${row}`,
    row,
    column,
    value: "",
  };
}

function ensureSheetBounds(
  sheet: SpreadsheetPreviewSheet,
  minRows: number,
  minColumns: number,
): void {
  const targetRows = Math.max(sheet.rowCount || 0, minRows);
  const targetColumns = Math.min(
    MAX_WORKSHEET_COLUMNS,
    Math.max(sheet.columnCount || 0, minColumns),
  );
  if (targetRows > MAX_WORKSHEET_ROWS || minColumns > MAX_WORKSHEET_COLUMNS) {
    throw new Error("Spreadsheet edit exceeds worksheet bounds");
  }
  while (sheet.rows.length < targetRows) {
    const rowNumber = sheet.rows.length + 1;
    sheet.rows.push(
      Array.from({ length: targetColumns }, (_, index) => createCell(rowNumber, index + 1)),
    );
  }
  for (let rowIndex = 0; rowIndex < targetRows; rowIndex += 1) {
    const row = sheet.rows[rowIndex] || [];
    while (row.length < targetColumns) {
      row.push(createCell(rowIndex + 1, row.length + 1));
    }
    sheet.rows[rowIndex] = row;
  }
  while (sheet.columnWidths.length < targetColumns) {
    sheet.columnWidths.push(12);
  }
  sheet.rowCount = targetRows;
  sheet.columnCount = targetColumns;
}

function applyCellInput(cell: SpreadsheetPreviewCell, input: SpreadsheetCellInput): void {
  if (input.formula || input.value.startsWith("=")) {
    cell.formula = (input.formula || input.value.slice(1)).replace(/^=/, "");
    cell.value = input.value.startsWith("=") ? input.value : `=${cell.formula}`;
    return;
  }
  delete cell.formula;
  cell.value = input.value;
}

function cellType(cell: SpreadsheetPreviewCell | undefined): SpreadsheetCellData["type"] {
  if (!cell || cell.value === "") return "blank";
  if (cell.formula) return "formula";
  if (/^#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/.test(cell.value)) return "error";
  if (cell.value === "TRUE" || cell.value === "FALSE") return "boolean";
  if (cell.value.trim() !== "" && Number.isFinite(Number(cell.value))) return "number";
  return "string";
}

function toCellData(
  cell: SpreadsheetPreviewCell | undefined,
  row: number,
  column: number,
): SpreadsheetCellData {
  const base = cell || createCell(row, column);
  return {
    ...base,
    row,
    column,
    address: `${spreadsheetColumnLetter(column - 1)}${row}`,
    type: cellType(base),
    displayValue: base.value || "",
  };
}

function createWarnings(
  preview: SpreadsheetPreview,
  format: SpreadsheetWorkbookFormat,
): SpreadsheetCompatibilityWarning[] {
  const warnings: SpreadsheetCompatibilityWarning[] = [
    {
      code: "compat-preview-backed-session",
      severity: "info",
      message:
        "This workbook is using CoWork's compatibility session layer backed by the existing parser. Unsupported workbook parts may still be rewritten until OOXML patch-save lands.",
    },
  ];

  if (format === "xlsm") {
    warnings.push({
      code: "compat-macro-read-only",
      severity: "warning",
      message:
        "Macro-enabled workbooks are read-only in CoWork's spreadsheet session layer until package-preserving XLSM save is available.",
    });
  }

  if (format === "xlsx" && preview.sheets.some((sheet) => sheet.truncated)) {
    warnings.push({
      code: "compat-truncated-preview",
      severity: "warning",
      message:
        "Only the loaded preview window is editable in this build. Hidden rows or columns are preserved best-effort by the legacy writer only for delimited files.",
    });
  }

  return warnings;
}

function assertPatchWithinLimits(patch: SpreadsheetPatch): void {
  switch (patch.type) {
    case "setCell":
      if (
        patch.row < 1 ||
        patch.row > MAX_WORKSHEET_ROWS ||
        patch.column < 1 ||
        patch.column > MAX_WORKSHEET_COLUMNS
      ) {
        throw new Error("Spreadsheet cell patch is outside worksheet bounds");
      }
      break;
    case "setRange": {
      const rowCount = patch.values.length;
      const columnCount = patch.values.reduce((max, row) => Math.max(max, row.length), 0);
      if (rowCount * Math.max(columnCount, 1) > MAX_RANGE_PATCH_CELLS) {
        throw new Error("Spreadsheet range patch is too large");
      }
      const endRow = patch.startRow + rowCount - 1;
      const endColumn = patch.startColumn + columnCount - 1;
      if (
        patch.startRow < 1 ||
        patch.startColumn < 1 ||
        endRow > MAX_WORKSHEET_ROWS ||
        endColumn > MAX_WORKSHEET_COLUMNS
      ) {
        throw new Error("Spreadsheet range patch is outside worksheet bounds");
      }
      break;
    }
    case "insertRows":
    case "deleteRows":
      if (patch.count < 1 || patch.count > MAX_VIEWPORT_ROWS) {
        throw new Error("Spreadsheet row patch count is too large");
      }
      break;
    case "insertColumns":
    case "deleteColumns":
      if (patch.count < 1 || patch.count > MAX_VIEWPORT_COLUMNS) {
        throw new Error("Spreadsheet column patch count is too large");
      }
      break;
    case "resizeColumn":
      if (patch.width < 1 || patch.width > 500) {
        throw new Error("Spreadsheet column width is outside supported bounds");
      }
      break;
    case "renameSheet":
      if (patch.name.trim().length === 0 || patch.name.length > 31) {
        throw new Error("Spreadsheet sheet name is invalid");
      }
      break;
  }
}

export class SpreadsheetWorkbookSessionService {
  private readonly sessions = new Map<string, SessionRecord>();

  async openWorkbook(input: {
    filePath: string;
    workspacePath: string;
    fileName?: string;
  }): Promise<SpreadsheetOpenWorkbookResult> {
    const safePath = await resolveWorkbookPathWithinWorkspace(input.filePath, input.workspacePath);
    const format = normalizeFormat(safePath.filePath);
    const preview =
      format === "csv" || format === "tsv"
        ? buildDelimitedSpreadsheetPreview(await fs.readFile(safePath.filePath, "utf-8"), {
            delimiter: format === "tsv" ? "\t" : ",",
            sheetName: path.basename(safePath.filePath, path.extname(safePath.filePath)),
          })
        : await buildSpreadsheetPreviewFromFile(safePath.filePath);

    const sessionId = randomUUID();
    const sheets = preview.sheets.map((sheet, index) => ({
      id: `sheet-${index + 1}`,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      columnWidths: sheet.columnWidths,
      sourceRowCount: sheet.sourceRowCount,
      truncated: sheet.truncated,
    }));
    const session: SpreadsheetWorkbookSession = {
      sessionId,
      filePath: safePath.filePath,
      fileName: input.fileName || path.basename(safePath.filePath),
      format,
      sheets,
      activeSheetId: sheets[0]?.id || "sheet-1",
      capabilities: {
        ...BASE_CAPABILITIES,
        canEditCells: format !== "xlsm",
        canEditStructure: format !== "xlsm",
        preservesUnsupportedWorkbookParts: format === "csv" || format === "tsv",
      },
      warnings: createWarnings(preview, format),
    };

    this.sessions.set(sessionId, {
      session,
      preview,
      filePath: safePath.filePath,
      workspacePath: safePath.workspacePath,
    });
    this.trimSessions();

    return {
      success: true,
      session,
      preview,
      viewport: this.buildViewport(sessionId, {
        sheetId: session.activeSheetId,
        startRow: 1,
        endRow: Math.min(sheets[0]?.rowCount || 1, DEFAULT_VIEWPORT_ROWS),
        startColumn: 1,
        endColumn: Math.min(sheets[0]?.columnCount || 1, DEFAULT_VIEWPORT_COLUMNS),
      }),
    };
  }

  getViewport(request: SpreadsheetViewportRequest): SpreadsheetViewportResult {
    try {
      return {
        success: true,
        viewport: this.buildViewport(request.sessionId, request),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get spreadsheet viewport",
      };
    }
  }

  applyPatches(sessionId: string, patches: SpreadsheetPatch[]): SpreadsheetApplyPatchesResult {
    try {
      const record = this.getRecord(sessionId);
      if (!record.session.capabilities.canEditCells) {
        throw new Error("This spreadsheet is read-only in CoWork");
      }
      if (patches.length > MAX_PATCHES_PER_APPLY) {
        throw new Error("Too many spreadsheet changes in one save");
      }
      for (const patch of patches) {
        assertPatchWithinLimits(patch);
        this.applyPatch(record, patch);
      }
      this.refreshSessionFromPreview(record);
      return {
        success: true,
        session: record.session,
        viewport: this.buildViewport(sessionId, {
          sheetId: record.session.activeSheetId,
          startRow: 1,
          endRow: Math.min(
            this.getSheetById(record, record.session.activeSheetId)?.rowCount || 1,
            DEFAULT_VIEWPORT_ROWS,
          ),
          startColumn: 1,
          endColumn: Math.min(
            this.getSheetById(record, record.session.activeSheetId)?.columnCount || 1,
            DEFAULT_VIEWPORT_COLUMNS,
          ),
        }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to apply spreadsheet changes",
      };
    }
  }

  async saveWorkbook(sessionId: string): Promise<SpreadsheetSaveWorkbookResult> {
    try {
      const record = this.getRecord(sessionId);
      if (!record.session.capabilities.canEditCells) {
        throw new Error("This spreadsheet is read-only in CoWork");
      }
      const safePath = await resolveWorkbookPathWithinWorkspace(
        record.filePath,
        record.workspacePath,
      );
      record.filePath = safePath.filePath;
      record.workspacePath = safePath.workspacePath;
      record.session.filePath = safePath.filePath;
      const savedPreview =
        record.session.format === "csv" || record.session.format === "tsv"
          ? await writeDelimitedSpreadsheetPreviewToFile(
              record.filePath,
              record.preview,
              record.session.format === "tsv" ? "\t" : ",",
            )
          : await writeSpreadsheetPreviewToFile(record.filePath, record.preview);
      record.preview = savedPreview;
      this.refreshSessionFromPreview(record);
      const stats = await fs.stat(record.filePath);
      return {
        success: true,
        session: record.session,
        preview: savedPreview,
        size: stats.size,
        viewport: this.buildViewport(sessionId, {
          sheetId: record.session.activeSheetId,
          startRow: 1,
          endRow: Math.min(
            this.getSheetById(record, record.session.activeSheetId)?.rowCount || 1,
            DEFAULT_VIEWPORT_ROWS,
          ),
          startColumn: 1,
          endColumn: Math.min(
            this.getSheetById(record, record.session.activeSheetId)?.columnCount || 1,
            DEFAULT_VIEWPORT_COLUMNS,
          ),
        }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save spreadsheet",
      };
    }
  }

  closeWorkbook(sessionId: string): { success: boolean } {
    this.sessions.delete(sessionId);
    return { success: true };
  }

  getTsv(sessionId: string): string {
    return spreadsheetPreviewToTsv(this.getRecord(sessionId).preview);
  }

  private trimSessions(): void {
    while (this.sessions.size > MAX_SESSION_COUNT) {
      const firstKey = this.sessions.keys().next().value as string | undefined;
      if (!firstKey) return;
      this.sessions.delete(firstKey);
    }
  }

  private getRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error("Spreadsheet session not found");
    }
    return record;
  }

  private getSheetIndex(record: SessionRecord, sheetId: string): number {
    const index = record.session.sheets.findIndex((sheet) => sheet.id === sheetId);
    if (index < 0) {
      throw new Error("Spreadsheet sheet not found");
    }
    return index;
  }

  private getSheetById(
    record: SessionRecord,
    sheetId: string,
  ): SpreadsheetPreviewSheet | undefined {
    const index = record.session.sheets.findIndex((sheet) => sheet.id === sheetId);
    return index >= 0 ? record.preview.sheets[index] : undefined;
  }

  private buildViewport(
    sessionId: string,
    request: Omit<SpreadsheetViewportRequest, "sessionId">,
  ): SpreadsheetViewport {
    const record = this.getRecord(sessionId);
    const sheetIndex = this.getSheetIndex(record, request.sheetId);
    const sheet = record.preview.sheets[sheetIndex];
    const startRow = clampWorksheetRow(request.startRow, 1);
    const requestedEndRow = Math.max(startRow, clampWorksheetRow(request.endRow, startRow));
    const endRow = Math.min(requestedEndRow, startRow + MAX_VIEWPORT_ROWS - 1);
    const startColumn = clampWorksheetColumn(request.startColumn, 1);
    const requestedEndColumn = Math.max(
      startColumn,
      clampWorksheetColumn(request.endColumn, startColumn),
    );
    const endColumn = Math.max(
      startColumn,
      Math.min(requestedEndColumn, startColumn + MAX_VIEWPORT_COLUMNS - 1),
    );
    const cells: SpreadsheetCellData[][] = [];
    for (let row = startRow; row <= endRow; row += 1) {
      const rowCells: SpreadsheetCellData[] = [];
      for (let column = startColumn; column <= endColumn; column += 1) {
        rowCells.push(toCellData(sheet.rows[row - 1]?.[column - 1], row, column));
      }
      cells.push(rowCells);
    }
    const columnWidths: Record<number, number> = {};
    for (let column = startColumn; column <= endColumn; column += 1) {
      columnWidths[column] = sheet.columnWidths[column - 1] || 12;
    }
    return {
      sheetId: request.sheetId,
      startRow,
      endRow,
      startColumn,
      endColumn,
      cells,
      rowHeights: {},
      columnWidths,
    };
  }

  private applyPatch(record: SessionRecord, patch: SpreadsheetPatch): void {
    const sheetIndex = this.getSheetIndex(record, patch.sheetId);
    const sheet = record.preview.sheets[sheetIndex];
    switch (patch.type) {
      case "setCell": {
        ensureSheetBounds(sheet, patch.row, patch.column);
        applyCellInput(sheet.rows[patch.row - 1][patch.column - 1], patch.input);
        break;
      }
      case "setRange": {
        patch.values.forEach((rowValues, rowOffset) => {
          rowValues.forEach((input, columnOffset) => {
            const row = patch.startRow + rowOffset;
            const column = patch.startColumn + columnOffset;
            ensureSheetBounds(sheet, row, column);
            applyCellInput(sheet.rows[row - 1][column - 1], input);
          });
        });
        break;
      }
      case "insertRows": {
        const beforeRow = clampPositiveInteger(patch.beforeRow, 1);
        const count = clampPositiveInteger(patch.count, 1);
        ensureSheetBounds(sheet, Math.max(sheet.rowCount, beforeRow - 1), sheet.columnCount || 1);
        const rows = Array.from({ length: count }, (_, offset) =>
          Array.from({ length: Math.max(sheet.columnCount, 1) }, (_, columnIndex) =>
            createCell(beforeRow + offset, columnIndex + 1),
          ),
        );
        sheet.rows.splice(beforeRow - 1, 0, ...rows);
        this.readdressSheet(sheet);
        break;
      }
      case "deleteRows": {
        const row = clampPositiveInteger(patch.row, 1);
        const count = clampPositiveInteger(patch.count, 1);
        sheet.rows.splice(row - 1, count);
        this.readdressSheet(sheet);
        break;
      }
      case "insertColumns": {
        const beforeColumn = clampPositiveInteger(patch.beforeColumn, 1);
        const count = clampPositiveInteger(patch.count, 1);
        ensureSheetBounds(
          sheet,
          Math.max(sheet.rowCount, 1),
          Math.max(sheet.columnCount, beforeColumn - 1),
        );
        for (const row of sheet.rows) {
          const cells = Array.from({ length: count }, (_, offset) =>
            createCell(1, beforeColumn + offset),
          );
          row.splice(beforeColumn - 1, 0, ...cells);
        }
        sheet.columnWidths.splice(beforeColumn - 1, 0, ...Array.from({ length: count }, () => 12));
        this.readdressSheet(sheet);
        break;
      }
      case "deleteColumns": {
        const column = clampPositiveInteger(patch.column, 1);
        const count = clampPositiveInteger(patch.count, 1);
        for (const row of sheet.rows) {
          row.splice(column - 1, count);
        }
        sheet.columnWidths.splice(column - 1, count);
        this.readdressSheet(sheet);
        break;
      }
      case "resizeColumn": {
        ensureSheetBounds(sheet, Math.max(sheet.rowCount, 1), patch.column);
        sheet.columnWidths[patch.column - 1] = patch.width;
        break;
      }
      case "renameSheet": {
        sheet.name = patch.name;
        record.preview.activeSheetName = patch.name;
        break;
      }
    }
  }

  private readdressSheet(sheet: SpreadsheetPreviewSheet): void {
    const columnCount = Math.max(
      sheet.columnCount,
      sheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
    );
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        const cell = row[columnIndex];
        cell.row = rowIndex + 1;
        cell.column = columnIndex + 1;
        cell.address = `${spreadsheetColumnLetter(columnIndex)}${rowIndex + 1}`;
      }
    }
    sheet.rowCount = sheet.rows.length;
    sheet.columnCount = columnCount;
  }

  private refreshSessionFromPreview(record: SessionRecord): void {
    record.session.sheets = record.preview.sheets.map((sheet, index) => ({
      ...record.session.sheets[index],
      id: record.session.sheets[index]?.id || `sheet-${index + 1}`,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      columnWidths: sheet.columnWidths,
      sourceRowCount: sheet.sourceRowCount,
      truncated: sheet.truncated,
    }));
    record.session.activeSheetId =
      record.session.sheets.find((sheet) => sheet.name === record.preview.activeSheetName)?.id ||
      record.session.sheets[0]?.id ||
      "sheet-1";
    record.session.warnings = createWarnings(record.preview, record.session.format);
  }
}

export const spreadsheetWorkbookSessionService = new SpreadsheetWorkbookSessionService();
