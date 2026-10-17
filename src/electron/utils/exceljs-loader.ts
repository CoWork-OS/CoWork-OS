import type ExcelJS from "exceljs";
import JSZip from "jszip";
import { loadDocumentArchive } from "../security/document-archive";

/** ExcelJS is about 300 module files, so it loads on first spreadsheet use, not at app start. */
export async function loadExcelJS(): Promise<typeof ExcelJS> {
  return (await import("exceljs")).default;
}

export const CHART_WORKBOOK_READ_ONLY_REASON =
  "Charts are preserved in this file. This preview shows cells only and is read-only because saving here could remove charts. Ask in chat to update the workbook, or open it in a spreadsheet app.";

/** Read cells without asking ExcelJS to reconcile unsupported chart drawings. Never save this model. */
export async function loadSpreadsheetCells(buffer: Buffer): Promise<{
  workbook: ExcelJS.Workbook;
  chartCount: number;
}> {
  const zip = await loadDocumentArchive(buffer);
  const names = Object.keys(zip.files);
  const chartCount = names.filter((name) => /^xl\/charts\/chart[^/]*\.xml$/i.test(name)).length;
  let cellBuffer = buffer;
  if (names.some((name) => /^xl\/(?:drawings|charts|media)\//i.test(name))) {
    const cells = new JSZip();
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir && !/^xl\/(?:drawings|charts|media)\//i.test(name)) {
        cells.file(name, await entry.async("nodebuffer"), { createFolders: false });
      }
    }
    cellBuffer = await cells.generateAsync({ type: "nodebuffer" });
  }
  const workbook = new (await loadExcelJS()).Workbook();
  await workbook.xlsx.load(cellBuffer as unknown as ExcelJS.Buffer, { ignoreNodes: ["drawing"] });
  return { workbook, chartCount };
}
