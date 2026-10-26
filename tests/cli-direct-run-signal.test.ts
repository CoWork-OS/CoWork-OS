import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { isTerminalTaskStatus } from "../src/shared/task-status";
import { describeUserActionStop } from "../src/cli/run-wait";

type WaitForTerminalTask = (
  daemon: { getTaskById(id: string): Promise<Record<string, unknown> | undefined> },
  taskId: string,
  args: Record<string, unknown>,
  isInterrupted?: () => boolean,
) => Promise<string>;

// As in cli-direct-run-settings, run the real CLI wait loop without starting the runtime.
function loadWaitForTerminalTask(writeEvent = vi.fn(), writeError = vi.fn()): WaitForTerminalTask {
  const fileName = path.resolve("src/cli/direct-run.ts");
  const source = fs.readFileSync(fileName, "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "waitForTerminalTask",
  );
  expect(declaration).toBeDefined();
  const javascript = ts.transpileModule(declaration!.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${javascript}\nwaitForTerminalTask`, {
    describePactSignInPause: async () => null,
    describeUserActionStop,
    isTerminalTaskStatus,
    writeEvent,
    writeError,
    process: { stdout: { isTTY: true } },
    setTimeout,
    Promise,
    Error,
  }) as WaitForTerminalTask;
}

describe("cowork run wait loop after a signal", () => {
  it("stops without reading the task once a signal has been handled", async () => {
    const wait = loadWaitForTerminalTask();
    const daemon = { getTaskById: vi.fn(async () => ({ id: "task-1", status: "executing" })) };

    await expect(wait(daemon, "task-1", {}, () => true)).resolves.toBe("interrupted");
    expect(daemon.getTaskById).not.toHaveBeenCalled();
  });

  it("prints nothing for a read that finishes after the signal", async () => {
    const writeEvent = vi.fn();
    const writeError = vi.fn();
    const wait = loadWaitForTerminalTask(writeEvent, writeError);
    let interrupted = false;
    const daemon = {
      // The signal handler cancels the task while this read is in flight.
      getTaskById: vi.fn(async () => {
        interrupted = true;
        return { id: "task-1", status: "cancelled", error: "Task was cancelled" };
      }),
    };

    await expect(wait(daemon, "task-1", {}, () => interrupted)).resolves.toBe("interrupted");
    expect(writeEvent).not.toHaveBeenCalled();
    expect(writeError).not.toHaveBeenCalled();
  });

  it("still returns the terminal status of a run nobody interrupted", async () => {
    const wait = loadWaitForTerminalTask();
    const daemon = { getTaskById: vi.fn(async () => ({ id: "task-1", status: "completed" })) };

    await expect(wait(daemon, "task-1", {})).resolves.toBe("completed");
  });
});
