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
  it("resolves and probes Electron after a successful desktop self-build", () => {
    const source = fs.readFileSync(path.resolve("bin/cowork.js"), "utf8");
    const build = new EventEmitter();
    const electron = new EventEmitter();
    const spawn = vi.fn((executable: string, args: string[]) => {
      if (args[0] === "run" && args[1] === "build") return build;
      expect(executable).toBe("/synthetic/Electron");
      return electron;
    });
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const requireMock = Object.assign(
      (name: string): unknown => {
        if (name === "child_process") return { spawn, spawnSync };
        if (name === "path") return path;
        if (name === "fs")
          return {
            existsSync: (file: string) => file.endsWith("package.json"),
            readFileSync: () => JSON.stringify({ version: "0.5.60", dependencies: {} }),
          };
        if (name.includes("npm_install_mode")) return { getRuntimeDependencyRepairArgs: () => [] };
        if (name.includes("platform-support"))
          return { getLauncherPlatformCompatibility: () => ({ supported: true }) };
        if (name === "electron") return "/synthetic/Electron";
        throw new Error(`Unexpected launcher dependency: ${name}`);
      },
      { resolve: () => "/synthetic/dependency" },
    );
    vm.runInNewContext(source, {
      require: requireMock,
      __dirname: "/synthetic/package/bin",
      process: {
        argv: ["node", "cowork.js"],
        platform: "darwin",
        env: { ELECTRON_RUN_AS_NODE: "1" },
        exit: vi.fn(),
      },
      console: { log: vi.fn(), error: vi.fn() },
    });
    expect(spawn).toHaveBeenCalledOnce();
    build.emit("exit", 0);
    expect(spawnSync.mock.calls[0][0]).toBe("/synthetic/Electron");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toBe("/synthetic/Electron");
    expect((spawn.mock.calls[1] as Any)[2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
