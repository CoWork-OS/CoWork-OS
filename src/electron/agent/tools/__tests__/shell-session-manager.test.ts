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
  it.skipIf(process.platform === "win32")(
    "rechecks authority after persistent setup before sending command bytes",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID(),
        workspaceId = randomUUID();
      const marker = `${testUserDataDir}/not-authorized-${randomUUID()}`;
      const fallbackRunner = vi.fn();
      const beforeExecute = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("responsibility revoked"));
      try {
        await expect(
          manager.runCommand({
            taskId,
            workspaceId,
            workspacePath: testUserDataDir,
            command: `echo executed > '${marker}'`,
            timeoutMs: 10000,
            beforeExecute,
            fallbackRunner,
          }),
        ).rejects.toThrow("responsibility revoked");
        expect(beforeExecute).toHaveBeenCalledTimes(2);
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(fallbackRunner).not.toHaveBeenCalled();
        const allowed = await manager.runCommand({
          taskId,
          workspaceId,
          workspacePath: testUserDataDir,
          command: "echo new-admission",
          timeoutMs: 10000,
          beforeExecute: async () => {},
          fallbackRunner,
        });
        expect(allowed.stdout).toBe("new-admission");
      } finally {
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the replacement shell when a stopped shell exits late",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID(),
        workspaceId = randomUUID();
      const sessions = (
        manager as unknown as {
          sessions: Map<string, { info: { taskId: string }; process: unknown }>;
        }
      ).sessions;
      const currentProcess = () =>
        Array.from(sessions.values()).find((session) => session.info.taskId === taskId)?.process as
          | import("node:child_process").ChildProcess
          | null
          | undefined;
      let stoppedShell: import("node:child_process").ChildProcess | null | undefined;
      try {
        await expect(
          manager.runCommand({
            taskId,
            workspaceId,
            workspacePath: testUserDataDir,
            command: "echo never-sent",
            timeoutMs: 10000,
            beforeExecute: vi
              .fn()
              .mockResolvedValueOnce(undefined)
              .mockImplementationOnce(async () => {
                stoppedShell = currentProcess();
                throw new Error("responsibility revoked");
              }),
          }),
        ).rejects.toThrow("responsibility revoked");
        expect(stoppedShell).toBeTruthy();

        let checks = 0;
        const result = await manager.runCommand({
          taskId,
          workspaceId,
          workspacePath: testUserDataDir,
          command: "echo replacement-ran",
          timeoutMs: 10000,
          beforeExecute: async () => {
            // The second check runs after the replacement shell is spawned and
            // before the command is sent: deliver the stopped shell's exit here.
            if (++checks === 2) stoppedShell!.emit("exit", null, "SIGTERM");
          },
        });

        expect(result.usedPersistentSession).toBe(true);
        expect(result.stdout).toBe("replacement-ran");
      } finally {
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  );

  it("lets agent commands run past five minutes up to the run_command maximum", () => {
    expect(_testUtils.resolveCommandTimeoutMs("task", 20 * 60 * 1000)).toBe(20 * 60 * 1000);
    expect(_testUtils.resolveCommandTimeoutMs("task", 2 * 60 * 60 * 1000)).toBe(30 * 60 * 1000);
    expect(_testUtils.resolveCommandTimeoutMs(undefined, 0)).toBe(60_000);
    expect(_testUtils.resolveCommandTimeoutMs("tab", 2 * 60 * 60 * 1000)).toBe(2 * 60 * 60 * 1000);
  });

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
    "reports a completed command with a non-zero exit as a normal termination",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID();
      const workspaceId = randomUUID();
      try {
        const result = await manager.runCommand({
          taskId,
          workspaceId,
          workspacePath: testUserDataDir,
          command: "echo compiled; sh -c 'exit 3'",
          timeoutMs: 10_000,
          fallbackRunner: async () => ({
            success: false,
            stdout: "",
            stderr: "Persistent shell fallback requested.",
            exitCode: null,
            terminationReason: "error",
          }),
        });

        // "error" means the command could not be spawned; this one ran and exited 3.
        expect(result).toMatchObject({
          success: false,
          exitCode: 3,
          terminationReason: "normal",
          usedPersistentSession: true,
        });
        expect(result.stdout).toContain("compiled");
      } finally {
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        // Session state persistence may still be flushing into the directory.
        await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "gives commands an empty stdin instead of the shell's own command stream",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID();
      const workspaceId = randomUUID();
      const run = (command: string) =>
        waitFor(
          manager.runCommand({
            taskId,
            workspaceId,
            workspacePath: testUserDataDir,
            command,
            timeoutMs: 5_000,
            fallbackRunner: async () => ({
              success: false,
              stdout: "",
              stderr: "Persistent shell fallback requested.",
              exitCode: null,
              terminationReason: "error",
            }),
          }),
          8_000,
          `the ${command} command`,
        );
      try {
        // `cat` used to read the rest of the wrapper script and hang until the timeout.
        const result = await run("cat");
        expect(result).toMatchObject({ success: true, exitCode: 0, terminationReason: "normal" });
        expect(result.stdout).toBe("");

        const next = await run("echo still-usable");
        expect(next.stdout).toBe("still-usable");
      } finally {
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "reports a timed-out command with its partial output instead of throwing",
    async () => {
      await mkdir(testUserDataDir, { recursive: true });
      const manager = ShellSessionManager.getInstance();
      const taskId = randomUUID();
      const workspaceId = randomUUID();
      try {
        const result = await waitFor(
          manager.runCommand({
            taskId,
            workspaceId,
            workspacePath: testUserDataDir,
            command: "echo started; sleep 20",
            timeoutMs: 1_000,
            fallbackRunner: async () => ({
              success: false,
              stdout: "",
              stderr: "Persistent shell fallback requested.",
              exitCode: null,
              terminationReason: "error",
            }),
          }),
          8_000,
          "the timed-out shell command",
        );

        // The command already reached the shell; callers must not re-run it.
        expect(result).toMatchObject({
          success: false,
          exitCode: null,
          terminationReason: "timeout",
          usedPersistentSession: true,
        });
        expect(result.stdout).toContain("started");
      } finally {
        const session = manager.getSessionInfo(taskId, workspaceId);
        if (session) await manager.stopSessionById(session.id);
        await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
    15_000,
  );

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
