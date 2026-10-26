import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { isTerminalTaskStatus } from "../src/shared/task-status";
import { describeUserActionStop } from "../src/cli/run-wait";

type WaitResult = string;
type WaitForTerminalTask = (
  daemon: { getTaskById(id: string): Promise<Record<string, unknown> | undefined> },
  taskId: string,
  args: { exitOnInput?: boolean; timeoutMs?: number; detachedWorker?: boolean },
) => Promise<WaitResult>;

// As in cli-direct-run-settings, run the real CLI wait loop without starting the runtime.
function loadWaitForTerminalTask(writeEvent = vi.fn()): WaitForTerminalTask {
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
    writeError: vi.fn(),
    process: { stdout: { isTTY: true } },
    setTimeout,
    Date,
    Number,
    Math,
    Promise,
    Error,
  }) as WaitForTerminalTask;
}

function daemonWith(task: Record<string, unknown>) {
  return { getTaskById: vi.fn(async () => ({ id: "task-1", ...task })) };
}

describe("cowork run wait loop", () => {
  it("stops at an unavailable access profile instead of waiting forever", async () => {
    const writeEvent = vi.fn();
    const wait = loadWaitForTerminalTask(writeEvent);
    const daemon = daemonWith({
      status: "paused",
      terminalStatus: "needs_user_action",
      awaitingUserInputReasonCode: "access_profile_unavailable",
      error: "The selected access profile is unavailable.",
    });

    const runArgs = {};

    await expect(wait(daemon, "task-1", runArgs)).resolves.toBe("needs_user_action");
    expect(writeEvent).toHaveBeenLastCalledWith(
      runArgs,
      {
        type: "needs_user_action",
        reason: "access_profile_unavailable",
        taskId: "task-1",
        message: "The selected access profile is unavailable.",
      },
      "Needs your action: The selected access profile is unavailable.",
    );
  });

  it("stops at a question only with --exit-on-input", async () => {
    const wait = loadWaitForTerminalTask();
    const question = {
      status: "paused",
      terminalStatus: "needs_user_action",
      awaitingUserInputReasonCode: "skill_parameters",
    };

    await expect(wait(daemonWith(question), "task-1", { exitOnInput: true })).resolves.toBe(
      "needs_user_action",
    );
    await expect(wait(daemonWith(question), "task-1", { timeoutMs: 30 })).resolves.toBe(
      "timed_out",
    );
  });

  it("ends a task that never finishes at --timeout-ms", async () => {
    const wait = loadWaitForTerminalTask();
    const started = Date.now();

    await expect(
      wait(daemonWith({ status: "executing" }), "task-1", { timeoutMs: 40 }),
    ).resolves.toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns the terminal status of a finished task", async () => {
    const wait = loadWaitForTerminalTask();

    await expect(
      wait(daemonWith({ status: "completed" }), "task-1", { timeoutMs: 1000 }),
    ).resolves.toBe("completed");
  });
});
