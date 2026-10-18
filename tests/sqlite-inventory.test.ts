import { describe, expect, it } from "vitest";
import {
  findEnclosingName,
  renderMarkdown,
  scanSource,
  stripComments,
} from "../scripts/qa/sqlite-inventory.mjs";

describe("sqlite-inventory", () => {
  it("removes comments but keeps strings and line numbers", () => {
    const source = [
      'const url = "https://example.com"; // db.prepare(ignored)',
      "/* db.transaction(",
      "   ignored */ db.exec('BEGIN IMMEDIATE');",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).toContain('"https://example.com"');
    expect(stripped).not.toContain("ignored");
    expect(stripped).toContain("db.exec('BEGIN IMMEDIATE')");
  });

  it("counts SQLite access patterns and ignores commented code", () => {
    const source = `
import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
export class ItemRepository {
  constructor(private db: Database.Database) {}
  // this.db.prepare("SELECT 0")
  list() {
    return this.db.prepare("SELECT * FROM items").all();
  }
  save(name: string): void {
    const insert = this.db.transaction(() => {
      this.db.prepare("INSERT INTO items (name) VALUES (?)").run(name);
    });
    insert.immediate();
    this.db.exec("VACUUM");
  }
}
const repo = new ItemRepository(manager.getDatabase());
`;
    const { counts, transactions } = scanSource("src/electron/items.ts", source);
    expect(counts).toMatchObject({
      prepare: 2,
      exec: 1,
      transaction: 1,
      immediate: 1,
      getDatabase: 1,
      repositoryConstruction: 1,
      runtimeImport: 1,
      typeImport: 1,
      newDatabase: 0,
    });
    expect(transactions).toEqual([
      { path: "src/electron/items.ts", line: 11, enclosing: "ItemRepository.save" },
    ]);
  });

  it("names enclosing members across multi-line signatures and closures", () => {
    const lines = `
export class Service {
  private transact<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  attach(
    runId: string,
  ): { run: Run; task: Task } {
    const tx = this.db.transaction(() => {});
  }

  describe(input: {
    id: string;
  }): Result {
    setTimeout(() => {
      this.db.transaction(() => {})();
    });
  }
}
function topLevel() {
  db.transaction(() => {})();
}
db.transaction(() => {})();
`.split("\n");
    const at = (needleIndex: number) => {
      const indexes = lines
        .map((line, index) => (line.includes(".transaction(") ? index : -1))
        .filter((index) => index >= 0);
      return findEnclosingName(lines, indexes[needleIndex]);
    };
    expect(at(0)).toBe("Service.transact");
    expect(at(1)).toBe("Service.attach");
    expect(at(2)).toBe("Service.describe");
    expect(at(3)).toBe("topLevel");
    expect(at(4)).toBe("(module)");
  });

  it.each([
    'import { createRequire } from "node:module"; const Database = createRequire(__filename)("better-sqlite3");',
    'import { createRequire as makeRequire } from "module"; const loadNative = makeRequire(import.meta.url); const Database = loadNative("better-sqlite3");',
    'import { createRequire as makeRequire } from "node:module"; const Database = makeRequire(__filename)("better-sqlite3");',
    'import * as nodeModule from "node:module"; const Database = nodeModule.createRequire(__filename)("better-sqlite3");',
    'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const Database = require("better-sqlite3");',
  ])("counts one runtime SQLite import through a Node-created loader: %s", (source) => {
    expect(scanSource("src/loader.ts", source).counts.runtimeImport).toBe(1);
  });

  it.each([
    'import type { createRequire } from "node:module"; const Database = createRequire(__filename)("better-sqlite3");',
    'import { type createRequire } from "node:module"; const Database = createRequire(__filename)("better-sqlite3");',
    'import { createRequire } from "unrelated-package"; const Database = createRequire(__filename)("better-sqlite3");',
    'function createRequire() { return () => {}; } createRequire()("better-sqlite3");',
    'import { createRequire } from "node:module"; const loadNative = createRequire(__filename); loadNative("another-package");',
    'import { createRequire } from "node:module"; // createRequire(__filename)("better-sqlite3")',
    'import { createRequire } from "node:module"; const loadNative = createRequire(__filename); function inspect(loadNative: (id: string) => void) { loadNative("better-sqlite3"); }',
  ])("does not invent a Node runtime SQLite import: %s", (source) => {
    expect(scanSource("src/loader.ts", source).counts.runtimeImport).toBe(0);
  });

  it("renders a markdown report", () => {
    const scan = scanSource("src/electron/a.ts", "db.transaction(() => {})();\n");
    const markdown = renderMarkdown({
      generatedAt: "2026-09-27T00:00:00.000Z",
      revision: { sha: "abc123", dirty: true },
      method: "text search",
      totals: { files: 1, ...scan.counts },
      directories: [{ directory: "src/electron/a.ts", files: 1, ...scan.counts }],
      files: [{ path: "src/electron/a.ts", counts: scan.counts }],
      transactions: scan.transactions,
    });
    expect(markdown).toContain("abc123 (dirty tree)");
    expect(markdown).toContain("## Transaction sites (1)");
    expect(markdown).toContain("`src/electron/a.ts:1` | `(module)`");
  });
});
