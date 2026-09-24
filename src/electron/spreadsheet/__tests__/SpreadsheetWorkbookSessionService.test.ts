import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { SpreadsheetWorkbookSessionService } from "../SpreadsheetWorkbookSessionService";

describe("SpreadsheetWorkbookSessionService", () => {
  it("opens an xlsx workbook and returns a viewport", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-session-"));
    const outPath = path.join(tmpDir, "book.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.getCell("A1").value = "Name";
    sheet.getCell("B1").value = "Status";
    sheet.getCell("A2").value = "Alice";
    sheet.getCell("B2").value = "Active";
    await workbook.xlsx.writeFile(outPath);

    const service = new SpreadsheetWorkbookSessionService();
    const result = await service.openWorkbook({
      filePath: outPath,
      workspacePath: tmpDir,
    });

    expect(result.success).toBe(true);
    expect(result.session?.sheets[0]).toMatchObject({
      name: "Data",
      rowCount: 2,
      columnCount: 2,
    });
    expect(result.viewport?.cells[1][1]).toMatchObject({
      address: "B2",
      displayValue: "Active",
      type: "string",
    });
  });

  it("applies cell patches and saves them back to xlsx", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-save-"));
    const outPath = path.join(tmpDir, "book.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.getCell("A1").value = "Name";
    sheet.getCell("B1").value = "Status";
    sheet.getCell("A2").value = "Alice";
    sheet.getCell("B2").value = "Active";
    await workbook.xlsx.writeFile(outPath);

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({
      filePath: outPath,
      workspacePath: tmpDir,
    });
    const sessionId = opened.session!.sessionId;
    const sheetId = opened.session!.sheets[0].id;

    const patched = service.applyPatches(sessionId, [
      {
        type: "setCell",
        sheetId,
        row: 2,
        column: 2,
        input: { value: "Pending" },
      },
      {
        type: "setCell",
        sheetId,
        row: 3,
        column: 2,
        input: { value: "=UPPER(A3)", formula: "UPPER(A3)" },
      },
      {
        type: "setCell",
        sheetId,
        row: 3,
        column: 1,
        input: { value: "Bruno" },
      },
    ]);
    expect(patched.success).toBe(true);

    const saved = await service.saveWorkbook(sessionId);
    expect(saved.success).toBe(true);

    const reread = new ExcelJS.Workbook();
    await reread.xlsx.readFile(outPath);
    const savedSheet = reread.getWorksheet("Data");
    expect(savedSheet?.getCell("B2").value).toBe("Pending");
    expect(savedSheet?.getCell("A3").value).toBe("Bruno");
    expect(savedSheet?.getCell("B3").value).toMatchObject({
      formula: "UPPER(A3)",
    });
  });

  it("supports structural row and column patches in the session model", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-structure-"));
    const outPath = path.join(tmpDir, "people.csv");
    await fs.writeFile(outPath, "Name,Status\nAlice,Active", "utf-8");

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({
      filePath: outPath,
      workspacePath: tmpDir,
    });
    const sessionId = opened.session!.sessionId;
    const sheetId = opened.session!.sheets[0].id;

    const patched = service.applyPatches(sessionId, [
      { type: "insertRows", sheetId, beforeRow: 2, count: 1 },
      {
        type: "setRange",
        sheetId,
        startRow: 2,
        startColumn: 1,
        values: [[{ value: "Bruno" }, { value: "Pending" }]],
      },
      { type: "insertColumns", sheetId, beforeColumn: 3, count: 1 },
      {
        type: "setCell",
        sheetId,
        row: 1,
        column: 3,
        input: { value: "Owner" },
      },
    ]);
    expect(patched.success).toBe(true);

    const viewport = service.getViewport({
      sessionId,
      sheetId,
      startRow: 1,
      endRow: 3,
      startColumn: 1,
      endColumn: 3,
    });
    expect(viewport.viewport?.cells[1][0].displayValue).toBe("Bruno");
    expect(viewport.viewport?.cells[1][1].displayValue).toBe("Pending");
    expect(viewport.viewport?.cells[0][2].displayValue).toBe("Owner");
  });

  it("persists deleted CSV rows and columns without restoring source data", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-delete-"));
    const outPath = path.join(tmpDir, "people.csv");
    await fs.writeFile(
      outPath,
      "Name,Status,Note\nAlice,Active,A note\nBruno,Pending,B note\nCara,Done,C note\n",
      "utf-8",
    );

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({ filePath: outPath, workspacePath: tmpDir });
    const sessionId = opened.session!.sessionId;
    const sheetId = opened.session!.sheets[0].id;
    expect(
      service.applyPatches(sessionId, [
        { type: "deleteRows", sheetId, row: 2, count: 1 },
        { type: "deleteColumns", sheetId, column: 2, count: 1 },
      ]).success,
    ).toBe(true);

    expect((await service.saveWorkbook(sessionId)).success).toBe(true);
    expect(await fs.readFile(outPath, "utf-8")).toBe("Name,Note\nBruno,B note\nCara,C note\n");
  });

  it("keeps truncated CSV structure read-only while saving visible cell edits", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-truncated-"));
    const outPath = path.join(tmpDir, "large.csv");
    const original = Array.from(
      { length: 2002 },
      (_, index) => `row-${index + 1},value-${index + 1}`,
    ).join("\n");
    await fs.writeFile(outPath, original, "utf-8");

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({ filePath: outPath, workspacePath: tmpDir });
    const sessionId = opened.session!.sessionId;
    const sheetId = opened.session!.sheets[0].id;
    expect(opened.session?.capabilities.canEditStructure).toBe(false);
    expect(opened.session?.warnings.map((warning) => warning.code)).toContain(
      "compat-delimited-structure-read-only",
    );
    expect(
      service.applyPatches(sessionId, [{ type: "deleteRows", sheetId, row: 2, count: 1 }]),
    ).toMatchObject({
      success: false,
      error: "Structural edits are unavailable for this spreadsheet",
    });
    expect(
      service.applyPatches(sessionId, [
        { type: "setCell", sheetId, row: 2, column: 2, input: { value: "should-not-apply" } },
        { type: "deleteRows", sheetId, row: 2, count: 1 },
      ]).success,
    ).toBe(false);
    expect(
      service.getViewport({
        sessionId,
        sheetId,
        startRow: 2,
        endRow: 2,
        startColumn: 2,
        endColumn: 2,
      }).viewport?.cells[0][0].value,
    ).toBe("value-2");
    expect(
      service.applyPatches(sessionId, [
        { type: "setCell", sheetId, row: 2, column: 2, input: { value: "edited" } },
      ]).success,
    ).toBe(true);

    expect((await service.saveWorkbook(sessionId)).success).toBe(true);
    const saved = await fs.readFile(outPath, "utf-8");
    expect(saved.split("\n")).toHaveLength(2002);
    expect(saved).toContain("row-2,edited\n");
    expect(saved).toContain("row-2002,value-2002");
  });

  it("rejects workbook files outside the workspace root", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-workspace-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-outside-"));
    const outsidePath = path.join(outsideDir, "people.csv");
    await fs.writeFile(outsidePath, "Name,Status\nAlice,Active", "utf-8");

    const service = new SpreadsheetWorkbookSessionService();

    await expect(
      service.openWorkbook({
        filePath: outsidePath,
        workspacePath: workspaceDir,
      }),
    ).rejects.toThrow(/must stay within the workspace/);
  });

  it("revalidates workspace containment before saving a workbook", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-save-root-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-save-outside-"));
    const workspacePath = path.join(workspaceDir, "people.csv");
    const outsidePath = path.join(outsideDir, "people.csv");
    await fs.writeFile(workspacePath, "Name,Status\nAlice,Active", "utf-8");
    await fs.writeFile(outsidePath, "Name,Status\nMallory,External", "utf-8");

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({
      filePath: workspacePath,
      workspacePath: workspaceDir,
    });

    service.applyPatches(opened.session!.sessionId, [
      {
        type: "setCell",
        sheetId: opened.session!.sheets[0].id,
        row: 2,
        column: 2,
        input: { value: "Pending" },
      },
    ]);

    await fs.unlink(workspacePath);
    await fs.symlink(outsidePath, workspacePath);

    const saved = await service.saveWorkbook(opened.session!.sessionId);
    expect(saved.success).toBe(false);
    expect(saved.error).toContain("must stay within the workspace");
    await expect(fs.readFile(outsidePath, "utf-8")).resolves.toContain("Mallory,External");
  });

  it("opens xlsm workbooks read-only to avoid corrupting macro package parts", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-xlsm-"));
    const outPath = path.join(tmpDir, "macro.xlsm");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("MacroData");
    sheet.getCell("A1").value = "Name";
    await workbook.xlsx.writeFile(outPath);

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({
      filePath: outPath,
      workspacePath: tmpDir,
    });

    expect(opened.success).toBe(true);
    expect(opened.session?.format).toBe("xlsm");
    expect(opened.session?.capabilities.canEditCells).toBe(false);
    expect(opened.session?.warnings.map((warning) => warning.code)).toContain(
      "compat-macro-read-only",
    );

    const patched = service.applyPatches(opened.session!.sessionId, [
      {
        type: "setCell",
        sheetId: opened.session!.sheets[0].id,
        row: 1,
        column: 1,
        input: { value: "Edited" },
      },
    ]);
    expect(patched.success).toBe(false);
    expect(patched.error).toContain("read-only");

    const saved = await service.saveWorkbook(opened.session!.sessionId);
    expect(saved.success).toBe(false);
    expect(saved.error).toContain("read-only");
  });

  it("caps viewport responses and rejects oversized range patches", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-limits-"));
    const outPath = path.join(tmpDir, "book.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.getCell("A1").value = "Name";
    await workbook.xlsx.writeFile(outPath);

    const service = new SpreadsheetWorkbookSessionService();
    const opened = await service.openWorkbook({
      filePath: outPath,
      workspacePath: tmpDir,
    });
    const sessionId = opened.session!.sessionId;
    const sheetId = opened.session!.sheets[0].id;

    const viewport = service.getViewport({
      sessionId,
      sheetId,
      startRow: 1,
      endRow: 10_000,
      startColumn: 1,
      endColumn: 10_000,
    });
    expect(viewport.success).toBe(true);
    expect(viewport.viewport?.cells).toHaveLength(500);
    expect(viewport.viewport?.cells[0]).toHaveLength(200);

    const tooLarge = service.applyPatches(sessionId, [
      {
        type: "setRange",
        sheetId,
        startRow: 1,
        startColumn: 1,
        values: Array.from({ length: 251 }, () =>
          Array.from({ length: 200 }, () => ({ value: "x" })),
        ),
      },
    ]);
    expect(tooLarge.success).toBe(false);
    expect(tooLarge.error).toContain("too large");
  });
});
