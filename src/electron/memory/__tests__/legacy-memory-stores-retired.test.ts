import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * `memory_items` is the only store of facts about the user (docs/memory-engine.md §5).
 * The retired lanes — the `curated_memory_entries` table and the SecureSettings
 * `user-profile` and `relationship-memory` blobs — may only be touched by the one-time
 * migrations that copy and then retire them. This guard fails when any other runtime
 * code names them again (comments are ignored).
 */
const SRC_ROOT = path.resolve(__dirname, "../../..");

const LEGACY_STORE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "curated_memory_entries table", pattern: /\bcurated_memory_entries\b/ },
  { name: "user-profile settings blob", pattern: /["'`]user-profile["'`]/ },
  { name: "relationship-memory settings blob", pattern: /["'`]relationship-memory["'`]/ },
];

/** Files allowed to name the retired stores, with the reason. */
const ALLOWED: Record<string, string> = {
  // The one-time copy into memory_items (reads the retired lanes).
  "electron/memory/MemoryItemsLaneMigration.ts": "lane migration",
  "electron/memory/memory-items-sql.ts": "lane migration (curated rows)",
  // The data retirement: exports, then drops the retired stores.
  "electron/memory/LegacyMemoryRetirement.ts": "retirement migration",
  "electron/memory/legacy-memory-retirement-sql.ts": "retirement migration",
  // Privacy purges (task delete, Clear All Memories) of rows not yet retired.
  "electron/memory/memory-purge-sql.ts": "privacy purge before retirement",
  // The settings category type still lists the blobs the migrations read and delete.
  "electron/database/SecureSettingsRepository.ts": "settings category type",
};

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

describe("retired legacy memory stores", () => {
  it("are named only by the migrations that copy and retire them", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWED[relative]) continue;
      const code = withoutComments(fs.readFileSync(file, "utf8"));
      for (const { name, pattern } of LEGACY_STORE_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${relative}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still finds a reference outside the allowed files (the guard works)", () => {
    const code = withoutComments(
      'const repo = load("user-profile"); // "relationship-memory" in a comment',
    );
    expect(LEGACY_STORE_PATTERNS.filter(({ pattern }) => pattern.test(code))).toHaveLength(1);
  });
});
