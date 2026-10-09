import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  describeFormulaCacheRestore,
  restoreXlsxFormulaCaches,
} from "../spreadsheet-formula-cache";
import {
  EXPENSES_SHEET_XML,
  SUMMARY_SHEET_XML,
  buildOpenpyxlStyleWorkbook,
} from "./openpyxl-style-workbook";

async function writeFixture(buffer: Buffer, name = "Northstar-pilot-costs.xlsx"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-formula-cache-"));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function readParts(filePath: string): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const parts = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) parts.set(name, await entry.async("string"));
  }
  return parts;
}

/** The cached result of one formula cell as Excel would read it, via the saved `<v>`. */
async function cachedResults(filePath: string): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const results: Record<string, unknown> = {};
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (cell.type === ExcelJS.ValueType.Formula) {
          results[`${sheet.name}!${cell.address}`] = cell.result;
        }
      }),
    );
  }
  return results;
}

const withoutValues = (xml: string) => xml.replace(/<v>[^<]*<\/v>/g, "<v></v>");

describe("restoreXlsxFormulaCaches", () => {
  it("restores the results openpyxl dropped without touching formulas or formatting", async () => {
    const filePath = await writeFixture(await buildOpenpyxlStyleWorkbook());
    const before = await readParts(filePath);

    const result = await restoreXlsxFormulaCaches(filePath);

    expect(result).toMatchObject({ restored: 11, uncached: [], rewritten: true });
    expect(await cachedResults(filePath)).toEqual({
      "Expenses!F2": 27.6,
      "Expenses!G2": 147.6,
      "Expenses!F3": 10.465,
      "Expenses!G3": 55.965,
      // Negative supplier credit.
      "Expenses!F4": -4.6,
      "Expenses!G4": -24.6,
      // 0% VAT: a zero result is a result, not a missing one.
      "Expenses!F5": 0,
      "Expenses!G5": 80,
      "Summary!B2": 225.5,
      "Summary!B3": 33.465,
      "Summary!B4": 258.965,
    });

    const after = await readParts(filePath);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, xml] of before) {
      if (name.startsWith("xl/worksheets/")) {
        // Only the cached values changed: formulas, styles, frozen panes, ids and dates did not.
        expect(withoutValues(after.get(name)!)).toBe(withoutValues(xml));
      } else {
        expect(after.get(name)).toBe(xml);
      }
    }
    expect(after.get("xl/worksheets/sheet1.xml")).toContain(
      '<c r="F2" s="3"><f>D2*E2</f><v>27.6</v></c>',
    );
    expect(after.get("xl/worksheets/sheet1.xml")).toContain('state="frozen"');

    const reread = new ExcelJS.Workbook();
    await reread.xlsx.readFile(filePath);
    const expenses = reread.getWorksheet("Expenses")!;
    expect(expenses.getCell("F2").formula).toBe("D2*E2");
    expect(expenses.getCell("F2").numFmt).toBe("€#,##0.00");
    expect(expenses.getCell("E2").numFmt).toBe("0%");
    expect(expenses.getCell("A2").value).toBe("00041");
  });

  it("does nothing to a workbook whose results are all saved", async () => {
    const filePath = await writeFixture(await buildOpenpyxlStyleWorkbook());
    await restoreXlsxFormulaCaches(filePath);
    const stamp = (await fs.stat(filePath)).mtimeMs;
    const bytes = await fs.readFile(filePath);

    const again = await restoreXlsxFormulaCaches(filePath);

    expect(again).toMatchObject({ restored: 0, uncached: [], rewritten: false });
    expect((await fs.stat(filePath)).mtimeMs).toBe(stamp);
    expect((await fs.readFile(filePath)).equals(bytes)).toBe(true);
  });

  it("keeps saved results, types text and boolean results, and reports what it cannot compute", async () => {
    const summary = SUMMARY_SHEET_XML.replace(
      // A result Excel saved stays as saved, even when CoWork would compute another value.
      "<f>SUM(Expenses!D2:D5)</f><v></v>",
      "<f>SUM(Expenses!D2:D5)</f><v>999</v>",
    ).replace(
      "</sheetData>",
      '<row r="5"><c r="A5" t="str"><f>"Total "&amp;B4</f></c>' +
        '<c r="B5"><f>B4&gt;200</f><v/></c>' +
        '<c r="C5"><f>VLOOKUP(A2,A2:B4,2,FALSE)</f><v></v></c>' +
        '<c r="D5" t="str"><f>""</f><v></v></c></row></sheetData>',
    );
    const filePath = await writeFixture(await buildOpenpyxlStyleWorkbook({ summary }));

    const result = await restoreXlsxFormulaCaches(filePath);

    // 8 Expenses formulas, Summary B3:B4 and the two new row-5 formulas; B2 kept its 999.
    expect(result.restored).toBe(12);
    expect(result.uncached).toEqual([
      expect.objectContaining({
        sheet: "Summary",
        address: "C5",
        formula: "VLOOKUP(A2,A2:B4,2,FALSE)",
      }),
    ]);
    const xml = (await readParts(filePath)).get("xl/worksheets/sheet2.xml")!;
    expect(xml).toContain("<f>SUM(Expenses!D2:D5)</f><v>999</v>");
    // B4 is computed from the Expenses formulas, not from the stale 999.
    expect(xml).toContain('<c r="A5" t="str"><f>"Total "&amp;B4</f><v>Total 258.965</v></c>');
    expect(xml).toContain('<c r="B5" t="b"><f>B4&gt;200</f><v>1</v></c>');
    expect(xml).toContain('<c r="C5"><f>VLOOKUP(A2,A2:B4,2,FALSE)</f><v></v></c>');
    // A saved empty-text result is a result.
    expect(xml).toContain('<c r="D5" t="str"><f>""</f><v></v></c>');
  });

  it("fills shared formulas", async () => {
    const expenses = EXPENSES_SHEET_XML.replace(
      "<f>D3*E3</f>",
      '<f t="shared" ref="F3:F5" si="0">D3*E3</f>',
    )
      .replace("<f>D4*E4</f>", '<f t="shared" si="0"/>')
      .replace("<f>D5*E5</f>", '<f t="shared" si="0"/>');
    const filePath = await writeFixture(await buildOpenpyxlStyleWorkbook({ expenses }));

    const result = await restoreXlsxFormulaCaches(filePath);

    expect(result).toMatchObject({ restored: 11, uncached: [] });
    expect((await readParts(filePath)).get("xl/worksheets/sheet1.xml")).toContain(
      '<c r="F4" s="3"><f t="shared" si="0"/><v>-4.6</v></c>',
    );
    expect(await cachedResults(filePath)).toMatchObject({
      "Expenses!F5": 0,
      "Summary!B3": 33.465,
    });
  });

  it("lists text cells that only carry a date format", async () => {
    const filePath = await writeFixture(await buildOpenpyxlStyleWorkbook());

    const result = await restoreXlsxFormulaCaches(filePath);

    expect(result.dateFormattedText).toEqual([
      "Expenses!B2",
      "Expenses!B3",
      "Expenses!B4",
      "Expenses!B5",
    ]);
    const note = describeFormulaCacheRestore("Northstar-pilot-costs.xlsx", result);
    expect(note).toContain("restored the saved results of 11 formula cell(s)");
    expect(note).toContain("4 cell(s) hold text with a date number format");
    expect(note).toContain("not real Excel dates");
  });

  it("describes nothing when nothing needed restoring", () => {
    expect(
      describeFormulaCacheRestore("a.xlsx", {
        restored: 0,
        uncached: [],
        dateFormattedText: [],
        rewritten: false,
      }),
    ).toBeNull();
  });
});
