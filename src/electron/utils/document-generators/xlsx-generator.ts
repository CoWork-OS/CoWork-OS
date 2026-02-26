/**
 * XLSX Generator — creates Excel spreadsheets from structured data.
 *
 * Uses ExcelJS (already in project dependencies).
 */

import * as fs from "fs";

interface SheetDefinition {
  name: string;
  headers: string[];
  rows: (string | number | boolean | null)[][];
  columnWidths?: number[];
  freezeHeader?: boolean;
}

interface XlsxOptions {
  title?: string;
  author?: string;
  sheets: SheetDefinition[];
  theme?: {
    headerColor?: string;
    headerFontColor?: string;
    accentColor?: string;
  };
}

export async function generateXLSX(
  outputPath: string,
  options: XlsxOptions,
): Promise<{ success: boolean; path: string; size: number; sheetCount: number }> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();

  // Metadata
  workbook.creator = options.author || "CoWork OS";
  workbook.created = new Date();
  workbook.modified = new Date();

  const headerFill = options.theme?.headerColor || "2563EB";
  const headerFont = options.theme?.headerFontColor || "FFFFFF";

  for (const sheetDef of options.sheets) {
    const sheet = workbook.addWorksheet(sheetDef.name);

    // Headers
    const headerRow = sheet.addRow(sheetDef.headers);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${headerFill.replace("#", "")}` },
      };
      cell.font = {
        bold: true,
        color: { argb: `FF${headerFont.replace("#", "")}` },
        size: 11,
      };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
      };
    });

    // Data rows
    for (const rowData of sheetDef.rows) {
      const row = sheet.addRow(rowData);
      row.eachCell((cell) => {
        cell.font = { size: 11 };
        cell.alignment = { vertical: "middle" };
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
        };
      });
    }

    // Column widths
    if (sheetDef.columnWidths) {
      sheetDef.columnWidths.forEach((w, i) => {
        sheet.getColumn(i + 1).width = w;
      });
    } else {
      // Auto-width based on header length (minimum 12, maximum 40)
      sheetDef.headers.forEach((h, i) => {
        const maxDataLen = Math.max(
          h.length,
          ...sheetDef.rows.map((r) => String(r[i] ?? "").length),
        );
        sheet.getColumn(i + 1).width = Math.min(40, Math.max(12, maxDataLen + 4));
      });
    }

    // Freeze header row
    if (sheetDef.freezeHeader !== false) {
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    }

    // Auto-filter
    if (sheetDef.headers.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheetDef.headers.length },
      };
    }
  }

  await workbook.xlsx.writeFile(outputPath);

  const stat = fs.statSync(outputPath);
  return {
    success: true,
    path: outputPath,
    size: stat.size,
    sheetCount: options.sheets.length,
  };
}
