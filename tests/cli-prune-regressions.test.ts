import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";

// Exercise the real orchestration functions with isolated dependencies. The
// direct-run entrypoint normally initializes a live application/data profile.
function directFunctions(names: string[], bindings: Record<string, unknown>) {
  const fileName = path.resolve("src/cli/direct-run.ts");
  const source = fs.readFileSync(fileName, "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(declarations).toHaveLength(names.length);
  const javascript = ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${javascript}\n({${names.join(",")}})`, bindings);
}

describe("adversarial CLI regressions", () => {
  it("previews without deleting and executes only one requested prune pass", async () => {
    const remaining = ["session-a", "session-b"];
    const deleted: string[] = [];
    const retention = {
      pruneSessions: vi.fn(async (filters, options) => {
        const selected = remaining.slice(0, filters.limit);
        if (!options.dryRun) {
          deleted.push(...selected);
          remaining.splice(0, selected.length);
        }
        return {
          sessions: selected.map((id) => ({ id })),
          sessionCount: selected.length,
          taskCount: selected.length,
          deletedTaskIds: options.dryRun ? [] : selected,
        };
      }),
    };
    const writeEvent = vi.fn();
    const { pruneSessions } = directFunctions(["pruneSessions"], {
      buildSessionRetentionFilters: () => ({ all: true, limit: 1 }),
      writeEvent,
    });
    expect(await pruneSessions(retention, {}, { yes: true })).toBe(0);
    expect(retention.pruneSessions.mock.calls.map((call) => call[1].dryRun)).toEqual([true, false]);
    expect(deleted).toEqual(["session-a"]);
    expect(remaining).toEqual(["session-b"]);
    expect(writeEvent.mock.calls[0][1].deletedTaskIds).toEqual(["session-a"]);
  });
});
