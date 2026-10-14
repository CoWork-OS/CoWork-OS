import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The schema bootstrap worker loads schema.ts in a fresh isolate on every launch, before
// the first window. Its runtime import graph stays limited to schema SQL: stores, zod and
// service modules belong outside it (their table SQL lives in leaf `*-schema.ts` modules).

const SRC = path.resolve(__dirname, "../../..");
const ENTRY = path.join(SRC, "electron/database/schema-bootstrap-worker.ts");
const IMPORT_RE = /^\s*(import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["'];?/gms;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+["']([^"']+)["'];?/gm;

function resolveLocal(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Runtime (non-type) imports reachable from the bootstrap worker entry. */
function runtimeImportGraph(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [ENTRY];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = fs.readFileSync(file, "utf8");
    const specifiers: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
      // `import { type A, type B } from` erases to nothing at runtime.
      const clause = match[0].slice(0, match[0].lastIndexOf("from"));
      const names = /\{([^}]*)\}/.exec(clause)?.[1];
      const onlyTypes =
        names !== undefined &&
        !/^\s*(import|export)\s+[\w*]/.test(clause.replace(/\{[^}]*\}/, "")) &&
        names
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .every((name) => name.startsWith("type "));
      if (!onlyTypes) specifiers.push(match[2]);
    }
    for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specifiers.push(match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier);
        if (resolved) pending.push(resolved);
      } else {
        packages.add(specifier.startsWith("@") ? specifier : specifier.split("/")[0]);
      }
    }
  }
  return { files, packages };
}

describe("schema bootstrap worker imports", () => {
  it("loads schema SQL without zod, Electron or the heavy stores", () => {
    const { files, packages } = runtimeImportGraph();
    const relative = [...files].map((file) => path.relative(SRC, file)).sort();

    expect([...packages].filter((name) => ["zod", "electron"].includes(name))).toEqual([]);
    expect(
      relative.filter((file) =>
        /(NotificationInbox|BotNotification|ChannelDecision|ApplicationOperation)Store\.ts$|(responsibility|application-operation)-store\.ts$/.test(
          file,
        ),
      ),
    ).toEqual([]);
    expect(relative).toContain("electron/notifications/bot-notification-schema.ts");
    expect(relative).toContain("electron/automation/responsibility-schema.ts");
  });
});
