import * as fs from 'fs/promises';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { Workspace } from '../../../shared/types';

export interface SheetData {
  name: string;
  data: any[][];
  /** Optional column widths */
  columnWidths?: number[];
  /** If true, first row is treated as header with bold formatting */
  hasHeader?: boolean;
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
    options: SpreadsheetOptions = {}
  ): Promise<void> {
    if (sheets.length === 0) {
      throw new Error('At least one sheet is required');
    }

    const ext = path.extname(outputPath).toLowerCase();

    // If CSV is explicitly requested, use CSV format
    if (ext === '.csv') {
      await this.createCSV(outputPath, sheets[0]);
      return;
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CoWork-OSS';
    workbook.created = new Date();

    for (const sheetData of sheets) {
      const worksheet = workbook.addWorksheet(sheetData.name);

      // Add all rows
      for (let rowIndex = 0; rowIndex < sheetData.data.length; rowIndex++) {
        const rowData = sheetData.data[rowIndex];
        const row = worksheet.addRow(rowData);

        // Style header row if specified
        if (rowIndex === 0 && sheetData.hasHeader !== false) {
          row.font = { bold: true };
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
          };
        }
      }

      // Set column widths
      if (sheetData.columnWidths) {
        sheetData.columnWidths.forEach((width, index) => {
          const column = worksheet.getColumn(index + 1);
          column.width = width;
        });
      } else if (options.autoFitColumns !== false) {
        // Auto-fit columns based on content
        worksheet.columns.forEach(column => {
          let maxLength = 10;
          column.eachCell?.({ includeEmpty: true }, cell => {
            const cellValue = cell.value;
            const length = cellValue ? String(cellValue).length : 0;
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
          to: { row: lastRow, column: lastColumn }
        };
      }

      // Freeze header row
      if (options.freezeHeader !== false && sheetData.data.length > 0) {
        worksheet.views = [{ state: 'frozen', ySplit: 1 }];
      }
    }

    // Write the file
    await workbook.xlsx.writeFile(outputPath);
  }

  /**
   * Creates a simple CSV file (fallback for .csv extension)
   */
  private async createCSV(outputPath: string, sheet: SheetData): Promise<void> {
    const csv = sheet.data
      .map(row =>
        row
          .map(cell => {
            const str = String(cell ?? '');
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(',')
      )
      .join('\n');

    await fs.writeFile(outputPath, csv, 'utf-8');
  }

  /**
   * Read an existing Excel file and return sheet data
   */
  async read(inputPath: string): Promise<SheetData[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheets: SheetData[] = [];

    workbook.eachSheet(worksheet => {
      const data: any[][] = [];
      worksheet.eachRow((row, rowNumber) => {
        const rowData: any[] = [];
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
        hasHeader: true
      });
    });

    return sheets;
  }
}
