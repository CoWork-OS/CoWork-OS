import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cowork-runtime-dependencies-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime dependency compatibility", () => {
  it("writes and streams an XLSX workbook through the maintained ExcelJS fork", async () => {
    const directory = await makeTemporaryDirectory();
    const filename = join(directory, "streamed.xlsx");
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename });
    const worksheet = writer.addWorksheet("Data");

    worksheet.addRow(["id", "name"]).commit();
    worksheet.addRow([1, "CoWork"]).commit();
    worksheet.commit();
    await writer.commit();

    const rows: unknown[][] = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filename);
    for await (const streamedWorksheet of reader) {
      for await (const row of streamedWorksheet) {
        rows.push((row.values as unknown[]).slice(1));
      }
    }

    expect(rows).toEqual([
      ["id", "name"],
      [1, "CoWork"],
    ]);
  });

  it("round-trips CSV data through Fast-CSV 5", async () => {
    const directory = await makeTemporaryDirectory();
    const filename = join(directory, "data.csv");
    const source = new ExcelJS.Workbook();
    const sourceWorksheet = source.addWorksheet("Data");
    sourceWorksheet.addRows([
      ["id", "name"],
      [1, "CoWork"],
    ]);

    await source.csv.writeFile(filename);
    const restored = new ExcelJS.Workbook();
    const restoredWorksheet = await restored.csv.readFile(filename);

    expect(restoredWorksheet.getSheetValues()).toEqual([
      undefined,
      [undefined, "id", "name"],
      [undefined, 1, "CoWork"],
    ]);
  });

  it("keeps electron-updater's deep comparison contract", () => {
    const updaterDirectory = dirname(require.resolve("electron-updater"));
    const equalityModule = require.resolve("lodash.isequal", {
      paths: [updaterDirectory],
    });
    const isEqual = require(equalityModule) as (left: unknown, right: unknown) => boolean;

    expect(
      isEqual(
        { version: "1.2.3", files: [{ url: "app.zip", sha512: "abc" }] },
        { version: "1.2.3", files: [{ url: "app.zip", sha512: "abc" }] },
      ),
    ).toBe(true);
    expect(isEqual({ version: "1.2.3" }, { version: "1.2.4" })).toBe(false);
  });

  it("serves Gaxios through the Node-native fetch replacement", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const url = `http://127.0.0.1:${address.port}`;
      const fetchModule = require("node-fetch") as {
        default?: typeof globalThis.fetch;
      } & typeof globalThis.fetch;
      const fetch = fetchModule.default ?? fetchModule;
      const fetchResponse = await fetch(url);
      const { Gaxios } = require("gaxios") as typeof import("gaxios");
      const gaxiosResponse = await new Gaxios().request<{ ok: boolean }>({ url });

      expect(await fetchResponse.json()).toEqual({ ok: true });
      expect(gaxiosResponse.data).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
