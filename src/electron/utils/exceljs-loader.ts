import type ExcelJS from "exceljs";

/** ExcelJS is about 300 module files, so it loads on first spreadsheet use, not at app start. */
export async function loadExcelJS(): Promise<typeof ExcelJS> {
  return (await import("exceljs")).default;
}
