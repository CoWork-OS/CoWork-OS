import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Every producer that writes memory goes through the same hygiene (docs/memory-engine.md
 * §1, §8 item 7): facts through `MemoryWriter` into `memory_items`, archive rows through
 * `MemoryService` (`capture`, the gated import API `openImportSession`, source sync).
 * This guard fails when runtime code outside the sanctioned modules inserts into
 * `memories` or `memory_items`, or reaches the low-level writers those modules use.
 * A new writer must route through MemoryWriter / MemoryService, or be added here with a
 * reason after review. Comments are ignored.
 */
const SRC_ROOT = path.resolve(__dirname, "../../..");

interface WriterRule {
  name: string;
  pattern: RegExp;
  /** Files allowed to match, with the reason. */
  allowed: Record<string, string>;
}

const RULES: WriterRule[] = [
  {
    name: "INSERT INTO memories",
    pattern: /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+memories\b/i,
    allowed: { "electron/memory/memory-capture-sql.ts": "the archive capture SQL" },
  },
  {
    name: "INSERT INTO memory_items",
    pattern: /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+memory_items\b/i,
    allowed: { "electron/memory/memory-items-sql.ts": "MemoryItemsStore (MemoryWriter steps 4-6)" },
  },
  {
    name: "archive row writers (insertMemoryRow / insertCapturedMemory)",
    pattern: /\binsert(?:MemoryRow|CapturedMemory)\s*\(/,
    allowed: {
      "electron/memory/memory-capture-sql.ts": "definition",
      "electron/database/repositories.ts": "MemoryRepository, used only by MemoryService",
      "electron/database/async/commands.ts": "the worker's memory.capture command",
    },
  },
  {
    name: "worker capture command",
    pattern: /["'`]memory\.capture["'`]/,
    allowed: {
      "electron/memory/MemoryService.ts": "MemoryService.writeCapture",
      "electron/database/async/commands.ts": "command definition",
    },
  },
  {
    name: "archive repository instance",
    pattern: /\bnew\s+MemoryRepository\s*\(/,
    allowed: { "electron/memory/MemoryService.ts": "the archive's only writer" },
  },
  {
    name: "memory_items repository instance",
    pattern: /\bnew\s+MemoryItemsRepository\s*\(/,
    allowed: { "electron/memory/MemoryWriter.ts": "the writer's own repository" },
  },
  {
    name: "memory_items ingest unit",
    pattern: /\bmemoryItems_ingest\b/,
    allowed: {
      "electron/memory/MemoryItemsRepository.ts": "repository method MemoryWriter calls",
      "electron/memory/memory-items-units.ts": "unit definition",
      "electron/memory/memory-curation-units.ts": "validates promote writes MemoryWriter prepared",
    },
  },
  {
    name: "memory_items store instance",
    pattern: /\bnew\s+MemoryItemsStore\s*\(/,
    allowed: {
      "electron/memory/memory-items-sql.ts": "definition and workspace purge",
      "electron/memory/memory-items-units.ts": "units behind MemoryItemsRepository",
      "electron/memory/memory-context-sql.ts": "read-only (prompt context)",
      "electron/memory/memory-recall-sql.ts": "read-only (recall)",
      "electron/memory/memory-curation-sql.ts":
        "curator apply, prepared by MemoryWriter.applyCuration",
    },
  },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Source text without comments: block comments, `//` comments and SQL `--` comments. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1").replace(/^\s*--.*$/, ""))
    .join("\n");
}

describe("memory writers", () => {
  it("insert into memories and memory_items only through the sanctioned modules", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const code = withoutComments(fs.readFileSync(file, "utf8"));
      for (const rule of RULES) {
        if (rule.allowed[relative]) continue;
        if (rule.pattern.test(code)) offenders.push(`${relative}: ${rule.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still finds a direct writer (the guard works)", () => {
    const code = withoutComments(
      [
        "db.prepare(`INSERT INTO memories (id) VALUES (?)`).run(id);",
        'db.prepare("insert or replace into memory_items (id) values (?)");',
        "const repo = new MemoryRepository(db); // INSERT INTO memories in a comment",
        "insertMemoryRow(db, row);",
        "-- INSERT INTO memories (id) in SQL comment",
      ].join("\n"),
    );
    const matched = RULES.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
    expect(matched).toEqual([
      "INSERT INTO memories",
      "INSERT INTO memory_items",
      "archive row writers (insertMemoryRow / insertCapturedMemory)",
      "archive repository instance",
    ]);
    expect(RULES[0].pattern.test("INSERT INTO memories_fts (rowid) VALUES (1)")).toBe(false);
  });
});
