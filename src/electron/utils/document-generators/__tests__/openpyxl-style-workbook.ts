/**
 * Test fixture: an .xlsx laid out the way openpyxl saves one after a formatting pass, with
 * formulas whose cached results were dropped (`<v></v>`), inline strings, frozen header panes
 * and number formats. Mirrors the expense workbook from the live round-3 run: euro amounts, a
 * percentage VAT rate (including 0%), a negative supplier credit, invoice ids that look numeric,
 * ISO date text formatted DD/MM/YYYY, and Summary totals that reference the Expenses sheet.
 */
import JSZip from "jszip";

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const CONTENT_TYPES = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;

const PACKAGE_RELS = `<Relationships xmlns="${PKG_REL_NS}"><Relationship Type="${REL_NS}/officeDocument" Target="xl/workbook.xml" Id="rId1"/></Relationships>`;

const WORKBOOK = `<workbook xmlns="${MAIN_NS}"><workbookPr/><sheets><sheet xmlns:r="${REL_NS}" name="Expenses" sheetId="1" state="visible" r:id="rId1"/><sheet xmlns:r="${REL_NS}" name="Summary" sheetId="2" state="visible" r:id="rId2"/></sheets><definedNames/><calcPr calcId="171027" fullCalcOnLoad="1"/></workbook>`;

// openpyxl writes absolute worksheet targets.
const WORKBOOK_RELS = `<Relationships xmlns="${PKG_REL_NS}"><Relationship Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId1"/><Relationship Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet2.xml" Id="rId2"/><Relationship Type="${REL_NS}/styles" Target="styles.xml" Id="rId3"/></Relationships>`;

// Style ids: 1 bold header, 2 DD/MM/YYYY, 3 euro, 4 percent (built-in 9).
const STYLES = `<styleSheet xmlns="${MAIN_NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="DD/MM/YYYY"/><numFmt numFmtId="165" formatCode="€#,##0.00"/></numFmts><fonts count="2"><font><name val="Calibri"/><family val="2"/><sz val="11"/></font><font><b val="1"/></font></fonts><fills count="2"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const FROZEN_HEADER = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A1" sqref="A1"/></sheetView></sheetViews>`;

function inline(address: string, text: string, style?: number): string {
  return `<c r="${address}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t>${text}</t></is></c>`;
}

function expenseRow(
  row: number,
  id: string,
  date: string,
  supplier: string,
  net: number,
  rate: number,
): string {
  return (
    `<row r="${row}">${inline(`A${row}`, id)}${inline(`B${row}`, date, 2)}` +
    `${inline(`C${row}`, supplier)}<c r="D${row}" s="3" t="n"><v>${net}</v></c>` +
    `<c r="E${row}" s="4" t="n"><v>${rate}</v></c>` +
    `<c r="F${row}" s="3"><f>D${row}*E${row}</f><v></v></c>` +
    `<c r="G${row}" s="3"><f>D${row}+F${row}</f><v></v></c></row>`
  );
}

export const EXPENSES_SHEET_XML =
  `<worksheet xmlns="${MAIN_NS}"><dimension ref="A1:G5"/>${FROZEN_HEADER}<sheetData>` +
  `<row r="1">${["Invoice ID", "Date", "Supplier", "Net EUR", "VAT rate", "VAT EUR", "Gross EUR"]
    .map((label, index) => inline(`${"ABCDEFG"[index]}1`, label, 1))
    .join("")}</row>` +
  expenseRow(2, "00041", "2026-10-05", "Audio kit rental", 120, 0.23) +
  expenseRow(3, "00042", "2026-10-07", "Printed welcome cards", 45.5, 0.23) +
  expenseRow(4, "CR-0041", "2026-10-08", "Audio kit rental credit", -20, 0.23) +
  expenseRow(5, "00043", "2026-10-09", "Caption editing", 80, 0) +
  `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

export const SUMMARY_SHEET_XML =
  `<worksheet xmlns="${MAIN_NS}"><dimension ref="A1:B4"/>${FROZEN_HEADER}<sheetData>` +
  `<row r="1">${inline("A1", "Metric", 1)}${inline("B1", "EUR", 1)}</row>` +
  `<row r="2">${inline("A2", "Net total")}<c r="B2" s="3"><f>SUM(Expenses!D2:D5)</f><v></v></c></row>` +
  `<row r="3">${inline("A3", "VAT total")}<c r="B3" s="3"><f>SUM(Expenses!F2:F5)</f><v></v></c></row>` +
  `<row r="4">${inline("A4", "Gross total")}<c r="B4" s="3"><f>SUM(Expenses!G2:G5)</f><v></v></c></row>` +
  `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

/** Builds the workbook; sheet XML can be replaced to cover other cell layouts. */
export async function buildOpenpyxlStyleWorkbook(
  sheets: { expenses?: string; summary?: string } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", PACKAGE_RELS);
  zip.file("xl/workbook.xml", WORKBOOK);
  zip.file("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
  zip.file("xl/styles.xml", STYLES);
  zip.file("xl/worksheets/sheet1.xml", sheets.expenses ?? EXPENSES_SHEET_XML);
  zip.file("xl/worksheets/sheet2.xml", sheets.summary ?? SUMMARY_SHEET_XML);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
