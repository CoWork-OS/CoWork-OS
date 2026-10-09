import ExcelJS from "exceljs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAnswerDataTable } from "../answer-data";

let dir = "";
const write = async (name: string, content: string | Buffer) => {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "answer-data-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readAnswerDataTable", () => {
  it("reads CSV with a header, typed numbers, blanks and codes", async () => {
    const file = await write(
      "sales.csv",
      '﻿Region,Revenue,Zip\nNorth,"1,200",02139\nSouth,,10001\n\nWest,95.5,94105\n',
    );
    const table = await readAnswerDataTable(file, "uploads/sales.csv");
    expect(table).toEqual({
      file: "uploads/sales.csv",
      columns: ["Region", "Revenue", "Zip"],
      rows: [
        ["North", 1200, "02139"],
        ["South", null, 10001],
        ["West", 95.5, 94105],
      ],
      totalRows: 3,
      truncated: false,
    });
  });

  it("reads TSV and JSON records, arrays and wrappers", async () => {
    const tsv = await readAnswerDataTable(await write("a.tsv", "a\tb\n1\tx\n"), "a.tsv");
    expect(tsv.rows).toEqual([[1, "x"]]);
    const records = await readAnswerDataTable(
      await write(
        "r.json",
        JSON.stringify({
          items: [
            { city: "Lisbon", visits: 3 },
            { city: "Porto", rain: true },
          ],
        }),
      ),
      "r.json",
    );
    expect(records.columns).toEqual(["city", "visits", "rain"]);
    expect(records.rows).toEqual([
      ["Lisbon", 3, null],
      ["Porto", null, true],
    ]);
    const arrays = await readAnswerDataTable(await write("a.json", '[["x","y"],[1,2]]'), "a.json");
    expect(arrays).toMatchObject({ columns: ["x", "y"], rows: [[1, 2]] });
  });

  it("reads the first non-empty sheet of a workbook, with formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Empty");
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["Item", "Cost"]);
    sheet.addRow(["Rent", 1600]);
    sheet.addRow(["Food", { formula: "B2/4", result: 400 }]);
    const file = path.join(dir, "budget.xlsx");
    await workbook.xlsx.writeFile(file);
    const table = await readAnswerDataTable(file, "budget.xlsx");
    expect(table).toMatchObject({
      columns: ["Item", "Cost"],
      rows: [
        ["Rent", 1600],
        ["Food", 400],
      ],
    });
  });

  it("stays bounded on hostile JSON shapes", async () => {
    const wide = `[{${Array.from({ length: 300_000 }, (_, index) => `"k${index}":1`).join(",")}}]`;
    let started = performance.now();
    const wideTable = await readAnswerDataTable(await write("wide.json", wide), "wide.json");
    expect(wideTable.columns).toHaveLength(50);
    expect(performance.now() - started).toBeLessThan(2000);
    const many = `[${Array.from({ length: 1_000_000 }, () => "{}").join(",")}]`;
    started = performance.now();
    const manyTable = await readAnswerDataTable(await write("many.json", many), "many.json");
    // Key-less records are blank rows: nothing is kept, and the work stays bounded.
    expect(manyTable.rows).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("keeps rows within the cell budget and counts the rest", async () => {
    const lines = ["a,b,c,d", ...Array.from({ length: 5000 }, (_, index) => `${index},1,2,3`)];
    const table = await readAnswerDataTable(await write("budget.csv", lines.join("\n")), "b.csv", {
      maxCells: 4000,
    });
    expect(table.rows).toHaveLength(1000);
    expect(table).toMatchObject({ totalRows: 5000, truncated: true });
    const newlines = await readAnswerDataTable(
      await write("blank.csv", `a\n${"\n".repeat(5_000_000)}1\n`),
      "blank.csv",
    );
    expect(newlines).toMatchObject({ rows: [[1]], totalRows: 1 });
  });

  it("streams workbooks and counts rows past the limit", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Big");
    sheet.addRow(["n"]);
    for (let index = 0; index < 1500; index += 1) sheet.addRow([index]);
    const file = path.join(dir, "big.xlsx");
    await workbook.xlsx.writeFile(file);
    const table = await readAnswerDataTable(file, "big.xlsx", { maxCells: 1000 });
    expect(table.rows).toHaveLength(1000);
    expect(table).toMatchObject({ totalRows: 1500, truncated: true });
  });

  it("says when a file was cut and refuses large or unsupported files", async () => {
    const lines = ["n", ...Array.from({ length: 20_010 }, (_, index) => String(index))];
    const table = await readAnswerDataTable(await write("big.csv", lines.join("\n")), "big.csv");
    expect(table.rows).toHaveLength(20_000);
    expect(table).toMatchObject({ totalRows: 20_010, truncated: true });
    await expect(readAnswerDataTable(await write("x.txt", "a"), "x.txt")).rejects.toThrow(/CSV/);
    await expect(
      readAnswerDataTable(
        await write("huge.csv", Buffer.alloc(10 * 1024 * 1024 + 1, 97)),
        "huge.csv",
      ),
    ).rejects.toThrow(/10 MB/);
  });
});
