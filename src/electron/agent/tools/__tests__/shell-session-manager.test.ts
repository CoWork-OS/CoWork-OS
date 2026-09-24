import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const { testUserDataDir } = vi.hoisted(() => ({
  testUserDataDir: `/tmp/cowork-shell-session-manager-test-${process.pid}-${Date.now()}`,
}));

vi.mock("../../../utils/user-data-dir", () => ({
  getUserDataDir: () => testUserDataDir,
}));

import { ShellSessionManager, _testUtils } from "../shell-session-manager";

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} is still running.`);
}

describe("shell-session-manager", () => {
  it("does not use interactive shell startup on Unix sessions", () => {
    if (process.platform === "win32") {
      expect(_testUtils.getShellArgs("powershell.exe")).toEqual(["-NoLogo", "-NoProfile"]);
      expect(_testUtils.getTerminalShellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual(["/Q"]);
      return;
    }

    expect(_testUtils.getShellArgs("/bin/zsh")).toEqual([]);
    expect(_testUtils.getTerminalShellArgs("/bin/zsh")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "stops the persistent shell process tree when the command signal is aborted",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID();
      const workspaceId = randomUUID();
      const controller = new AbortController();
      let resolveChildPid!: (pid: number) => void;
      const childPidPromise = new Promise<number>((resolve) => {
        resolveChildPid = resolve;
      });
      let commandPromise: ReturnType<typeof manager.runCommand> | undefined;

      try {
        commandPromise = manager.runCommand({
          taskId,
          workspaceId,
          workspacePath: testUserDataDir,
          command: 'sleep 30 & child=$!; printf "__COWORK_TEST_PID__%s\\n" "$child"; wait "$child"',
          timeoutMs: 45_000,
          signal: controller.signal,
          onOutput: ({ output }) => {
            const match = output.match(/__COWORK_TEST_PID__(\d+)/);
            if (match) resolveChildPid(Number(match[1]));
          },
          fallbackRunner: async () => ({
            success: false,
            stdout: "",
            stderr: "Persistent shell fallback requested.",
            exitCode: null,
            terminationReason: "error",
          }),
        });

        const childPid = await waitFor(childPidPromise, 5_000, "the shell child PID");
        expect(() => process.kill(childPid, 0)).not.toThrow();

        controller.abort();

        const result = await waitFor(commandPromise, 5_000, "the cancelled shell command");
        expect(result.terminationReason).toBe("user_stopped");
        await waitForProcessExit(childPid, 5_000);

        const session = manager.getSessionInfo(taskId, workspaceId);
        expect(session?.status).toBe("inactive");
        if (session) await manager.stopSessionById(session.id);
        const persistedState = JSON.parse(
          await readFile(`${testUserDataDir}/shell-sessions.json`, "utf-8"),
        ) as {
          sessions: Array<{ id: string; status: string; lastTerminationReason?: string }>;
        };
        expect(persistedState.sessions.find((saved) => saved.id === session?.id)).toMatchObject({
          status: "inactive",
          lastTerminationReason: "user_stopped",
        });
      } finally {
        controller.abort();
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        await commandPromise?.catch(() => undefined);
        await rm(testUserDataDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
