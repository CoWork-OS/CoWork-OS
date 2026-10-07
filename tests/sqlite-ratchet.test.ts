import { describe, expect, it } from "vitest";
import {
  buildBaseline,
  checkRatchet,
  compareToBaseline,
  formatReport,
  trackedCounts,
} from "../scripts/qa/sqlite-ratchet.mjs";

describe("sqlite-ratchet", () => {
  it("keeps synchronous SQLite access on application threads at or below the register", () => {
    const result = checkRatchet();
    expect(formatReport(result)).toBe("");
  });

  it("tracks only application-thread files with non-zero tracked counts", () => {
    const counts = (prepare: number, getDatabase = 0) => ({
      prepare,
      getDatabase,
      runtimeImport: 0,
      exec: 5,
    });
    expect(
      trackedCounts({
        files: [
          { path: "src/electron/b.ts", counts: counts(2, 1) },
          { path: "src/electron/a.ts", counts: counts(0) },
          { path: "src/electron/database/fts-worker.ts", counts: counts(4) },
          { path: "src/electron/database/async/database-worker.ts", counts: counts(9) },
          { path: "src/electron/database/async/commands.ts", counts: counts(3) },
          { path: "src/electron/database/async/DatabaseClient.ts", counts: counts(1) },
        ],
      }),
    ).toEqual({
      "src/electron/b.ts": { prepare: 2, getDatabase: 1 },
      "src/electron/database/async/DatabaseClient.ts": { prepare: 1 },
    });
  });

  it("reports increases, new files, and unrecorded decreases", () => {
    const result = compareToBaseline(
      { "src/a.ts": { prepare: 3 }, "src/new.ts": { getDatabase: 1 } },
      { "src/a.ts": { prepare: 2, runtimeImport: 1 }, "src/gone.ts": { prepare: 4 } },
    );
    expect(result.increased).toEqual([
      { path: "src/a.ts", key: "prepare", before: 2, now: 3 },
      { path: "src/new.ts", key: "getDatabase", before: 0, now: 1 },
    ]);
    expect(result.decreased).toEqual([
      { path: "src/a.ts", key: "runtimeImport", before: 1, now: 0 },
      { path: "src/gone.ts", key: "prepare", before: 4, now: 0 },
    ]);
    expect(formatReport(result)).toContain("src/new.ts: getDatabase 0 -> 1");
  });

  it("builds a stable baseline with totals", () => {
    expect(
      buildBaseline({ "src/a.ts": { prepare: 2 }, "src/b.ts": { getDatabase: 3 } }),
    ).toMatchObject({
      tracked: ["prepare", "getDatabase", "runtimeImport"],
      totals: { prepare: 2, getDatabase: 3, runtimeImport: 0 },
    });
  });

  it("lets a unit store's SQL grow but not an application-thread file's (DB7 gate)", () => {
    const isUnitStore = (path: string) => path === "src/electron/area/area-sql.ts";
    const result = compareToBaseline(
      {
        "src/electron/area/area-sql.ts": { prepare: 5 },
        "src/electron/area/AreaService.ts": { prepare: 2 },
      },
      {
        "src/electron/area/area-sql.ts": { prepare: 1 },
        "src/electron/area/AreaService.ts": { prepare: 1 },
      },
      isUnitStore,
    );
    expect(result.increased.map((entry) => entry.path)).toEqual([
      "src/electron/area/AreaService.ts",
    ]);
  });

  it("exempts only explicitly listed inventory keys outside shared SQL modules", () => {
    const result = compareToBaseline(
      {
        "src/electron/runtime/Bridge.ts": { getDatabase: 2, prepare: 1 },
      },
      {
        "src/electron/runtime/Bridge.ts": { getDatabase: 1 },
      },
      (path, key) => path === "src/electron/runtime/Bridge.ts" && key === "getDatabase",
    );
    expect(result.increased).toEqual([
      { path: "src/electron/runtime/Bridge.ts", key: "prepare", before: 0, now: 1 },
    ]);
  });
});
