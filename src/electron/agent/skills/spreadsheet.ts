import { readDocumentArchiveBuffer } from "../../security/document-archive";
import * as fs from "fs/promises";
import * as path from "path";
import ExcelJS from "exceljs";
import { Workspace } from "../../../shared/types";
import {
  applySpreadsheetNumberFormats,
  normalizeSpreadsheetCell,
  type SpreadsheetNumberFormatInput,
} from "../../utils/document-generators/spreadsheet-cells";
import {
  computeWorkbookFormulaResults,
  type FormulaComputationReport,
} from "../../utils/document-generators/spreadsheet-formulas";

export interface SheetData {
  name: string;
  data: Any[][];
  /** Optional column widths */
  columnWidths?: number[];
  /** If true, first row is treated as header with bold formatting */
  hasHeader?: boolean;
  /** Optional Excel number formats by column (letter or header text) or A1 range */
  numberFormats?: SpreadsheetNumberFormatInput[];
}

export interface SpreadsheetCreateReport {
  /** Formula cells with a cached result, and those left for Excel to calculate on open */
  formulas: FormulaComputationReport;
  /** Requests that could not be applied, such as an unknown number-format column */
  warnings: string[];
}

export interface SpreadsheetOptions {
  /** Auto-fit column widths based on content */
  autoFitColumns?: boolean;
  /** Add filters to header row */
  addFilters?: boolean;
  /** Freeze the header row */
  freezeHeader?: boolean;
}

/**
 * SpreadsheetBuilder creates Excel spreadsheets (.xlsx) using exceljs
 */
export class SpreadsheetBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    sheets: SheetData[],
    options: SpreadsheetOptions = {},
  ): Promise<SpreadsheetCreateReport> {
    if (sheets.length === 0) {
      throw new Error("At least one sheet is required");
    }

    const ext = path.extname(outputPath).toLowerCase();
    const warnings: string[] = [];

    // If CSV is explicitly requested, use CSV format
    if (ext === ".csv") {
      await this.createCSV(outputPath, sheets[0]);
      if (sheets.some((sheet) => sheet.numberFormats?.length)) {
        warnings.push("CSV files cannot store number formats; they were not applied.");
      }
      return { formulas: { computed: 0, uncached: [] }, warnings };
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "CoWork OS";
    workbook.created = new Date();

    for (const sheetData of sheets) {
      const worksheet = workbook.addWorksheet(sheetData.name);

      // Add all rows
      for (let rowIndex = 0; rowIndex < sheetData.data.length; rowIndex++) {
        const rowData = sheetData.data[rowIndex];
        const isHeaderRow = rowIndex === 0 && sheetData.hasHeader !== false;

        // Models send cells as strings: "=SUM(A1:A2)" must become an ExcelJS formula object
        // and "1200" a number, or every formula over the data computes 0. Header labels that
        // look numeric (e.g. a "2024" column) stay text.
        const normalizedRowData = rowData.map((cell) =>
          normalizeSpreadsheetCell(cell, { coerceNumbers: !isHeaderRow }),
        );

        const row = worksheet.addRow(normalizedRowData);

        // Style header row if specified
        if (rowIndex === 0 && sheetData.hasHeader !== false) {
          row.font = { bold: true };
          row.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE0E0E0" },
          };
        }
      }

      warnings.push(
        ...applySpreadsheetNumberFormats(worksheet, sheetData.numberFormats, {
          headerRow: sheetData.hasHeader !== false ? sheetData.data[0] : undefined,
          firstDataRow: sheetData.hasHeader !== false ? 2 : 1,
        }),
      );

      // Set column widths
      if (sheetData.columnWidths) {
        sheetData.columnWidths.forEach((width, index) => {
          const column = worksheet.getColumn(index + 1);
          column.width = width;
        });
      } else if (options.autoFitColumns !== false) {
        // Auto-fit columns based on content
        worksheet.columns.forEach((column) => {
          let maxLength = 10;
          column.eachCell?.({ includeEmpty: true }, (cell) => {
            const cellValue = cell.value;
            // A date shows as its number format ("dd/mm/yyyy"), not as Date#toString().
            const length =
              cellValue instanceof Date
                ? Math.max(10, typeof cell.numFmt === "string" ? cell.numFmt.length : 0)
                : cellValue
                  ? String(cellValue).length
                  : 0;
            if (length > maxLength) {
              maxLength = Math.min(length, 50); // Cap at 50 characters
            }
          });
          column.width = maxLength + 2;
        });
      }

      // Add filters to header row
      if (options.addFilters && sheetData.data.length > 0) {
        const lastColumn = sheetData.data[0].length;
        const lastRow = sheetData.data.length;
        worksheet.autoFilter = {
          from: { row: 1, column: 1 },
          to: { row: lastRow, column: lastColumn },
        };
      }

      // Freeze header row
      if (options.freezeHeader !== false && sheetData.data.length > 0) {
        worksheet.views = [{ state: "frozen", ySplit: 1 }];
      }
    }

    // Cache results for the formulas CoWork can evaluate, so viewers that do not recalculate
    // (CoWork's preview, Quick Look, LibreOffice by default) show values; Excel recalculates all.
    workbook.calcProperties.fullCalcOnLoad = true;
    const formulas = computeWorkbookFormulaResults(workbook);

    // Write the file
    await workbook.xlsx.writeFile(outputPath);
    return { formulas, warnings };
  }

  /**
   * Creates a simple CSV file (fallback for .csv extension)
   */
  private async createCSV(outputPath: string, sheet: SheetData): Promise<void> {
    const csv = sheet.data
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? "");
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            if (str.includes(",") || str.includes('"') || str.includes("\n")) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(","),
      )
      .join("\n");

    await fs.writeFile(outputPath, csv, "utf-8");
  }

  /**
   * Read an existing Excel file and return sheet data
   */
  async read(inputPath: string): Promise<SheetData[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await readDocumentArchiveBuffer(inputPath)) as unknown as ExcelJS.Buffer,
    );

    const sheets: SheetData[] = [];

    workbook.eachSheet((worksheet) => {
      const data: Any[][] = [];
      worksheet.eachRow((row, _rowNumber) => {
        const rowData: Any[] = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          // Ensure array is long enough
          while (rowData.length < colNumber - 1) {
            rowData.push(null);
          }
          rowData.push(cell.value);
        });
        data.push(rowData);
      });

      sheets.push({
        name: worksheet.name,
        data,
        hasHeader: true,
      });
    });

    return sheets;
  }
}
