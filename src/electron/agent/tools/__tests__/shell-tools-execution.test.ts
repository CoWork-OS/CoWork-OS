/**
 * ShellTools execution paths exercised with real shells: the persistent shell
 * and the one-shot spawn used by full-access profiles.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { testUserDataDir, spawnCalls, execSyncOverride } = vi.hoisted(() => ({
  testUserDataDir: `/tmp/cowork-shell-tools-execution-test-${process.pid}-${Date.now()}`,
  spawnCalls: [] as Array<{ command: string; args: string[] }>,
  execSyncOverride: { current: null as ((command: string) => string) | null },
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const spawn = (command: string, args: readonly string[], options: Any) => {
    spawnCalls.push({ command, args: [...args] });
    return actual.spawn(command, args, options);
  };
  const execSync = (command: string, options: Any) =>
    execSyncOverride.current
      ? execSyncOverride.current(command)
      : actual.execSync(command, options);
  return { ...actual, spawn, execSync };
});

vi.mock("../../../utils/user-data-dir", () => ({
  getUserDataDir: () => testUserDataDir,
}));

vi.mock("../../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      allowedSandboxTypes: ["macos", "docker"],
      requireSandboxForShell: false,
      allowUnsandboxedShell: false,
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
    },
  })),
}));

vi.mock("../../sandbox/sandbox-factory", () => ({
  createSandbox: vi.fn(async () => {
    throw new Error("full-access commands in this test must not use the OS sandbox");
  }),
}));

import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { ShellSessionManager } from "../shell-session-manager";
import { ShellTools, _testUtils } from "../shell-tools";
import type { AgentDaemon } from "../../daemon";
import type { Workspace } from "../../../../shared/types";

const workspacePath = path.join(testUserDataDir, "workspace");

function createWorkspace(): Workspace {
  return {
    id: `workspace-${randomUUID()}`,
    name: "Shell execution",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: {
      shell: true,
      read: true,
      write: true,
      delete: true,
      network: true,
      accessSandboxMode: "danger-full-access",
      accessApprovalPolicy: "never",
    },
  } as Workspace;
}

function createDaemon() {
  return {
    requestApproval: vi.fn().mockResolvedValue(true),
    logEvent: vi.fn(),
  };
}

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

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("ShellTools execution with real shells", () => {
  const sessions: Array<{ taskId: string; workspaceId: string }> = [];

  beforeEach(async () => {
    spawnCalls.length = 0;
    await mkdir(workspacePath, { recursive: true });
    vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({ blocked: false });
    vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({ trusted: false });
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "per_command",
    );
  });

  afterEach(async () => {
    execSyncOverride.current = null;
    vi.restoreAllMocks();
    const manager = ShellSessionManager.getInstance();
    for (const { taskId, workspaceId } of sessions.splice(0)) {
      const session = manager.getSessionInfo(taskId, workspaceId);
      if (session) await manager.stopSessionById(session.id);
    }
    // Session state persistence may still be flushing into the directory.
    await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("does not re-run a command after the persistent shell times out", async () => {
    const workspace = createWorkspace();
    const taskId = `task-${randomUUID()}`;
    sessions.push({ taskId, workspaceId: workspace.id });
    await writeFile(
      path.join(workspacePath, "record-run.sh"),
      'echo run >> "$(dirname "$0")/runs.log"\nsleep 20\n',
    );
    const shellTools = new ShellTools(workspace, createDaemon() as unknown as AgentDaemon, taskId);

    const result = await waitFor(
      shellTools.runCommand("sh record-run.sh", { cwd: workspacePath, timeout: 1_000 }),
      8_000,
      "the timed-out command",
    );

    expect(result).toMatchObject({ success: false, terminationReason: "timeout" });
    const runs = await readFile(path.join(workspacePath, "runs.log"), "utf8");
    expect(runs.trim().split("\n")).toEqual(["run"]);
    expect(spawnCalls.some(({ args }) => args.includes("sh record-run.sh"))).toBe(false);
  }, 15_000);

  it("signals a shell before its children so it cannot go on to the next command", () => {
    // A shell whose child dies before the shell is signalled runs the next
    // command of its script (`sleep 30; rm -rf build`).
    execSyncOverride.current = (command) => (command.startsWith("pgrep -P 4242 ") ? "4343\n" : "");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    _testUtils.killProcessTree(4242, "SIGKILL");

    const signalled = kill.mock.calls.filter(([, signal]) => signal !== 0).map(([pid]) => pid);
    expect(signalled).toEqual([4242, 4343]);
  });

  it("kills the one-shot process tree when the tool call is aborted", async () => {
    const workspace = createWorkspace();
    const daemon = createDaemon();
    const shellTools = new ShellTools(
      workspace,
      daemon as unknown as AgentDaemon,
      `task-${randomUUID()}`,
    );
    const controller = new AbortController();

    // Shell operators route the command to the one-shot spawn path.
    const pending = shellTools.runCommand('sleep 30 & echo "child:$!"; wait; echo finished', {
      cwd: workspacePath,
      timeout: 60_000,
      signal: controller.signal,
    });
    let childPid = 0;
    await waitUntil(
      () => {
        for (const [, eventType, payload] of daemon.logEvent.mock.calls) {
          const match =
            eventType === "command_output" && typeof payload?.output === "string"
              ? payload.output.match(/child:(\d+)/)
              : null;
          if (match) childPid = Number(match[1]);
        }
        return childPid > 0;
      },
      5_000,
      "the background child PID",
    );
    expect(isRunning(childPid)).toBe(true);

    controller.abort();
    const result = await waitFor(pending, 8_000, "the aborted command");

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe("timeout");
    expect(result.stdout).not.toContain("finished");
    await waitUntil(() => !isRunning(childPid), 5_000, "the child process to exit");
  }, 20_000);

  describe("long output", () => {
    const writeNoisyScript = () =>
      writeFile(
        path.join(workspacePath, "noisy.sh"),
        'echo BEGIN\nhead -c 300000 /dev/zero | tr "\\0" "x"\necho\necho "SUMMARY: 3 failed"\n',
      );

    it("keeps the end of long one-shot command output", async () => {
      await writeNoisyScript();
      const shellTools = new ShellTools(
        createWorkspace(),
        createDaemon() as unknown as AgentDaemon,
        `task-${randomUUID()}`,
      );

      // The redirect routes the command to the one-shot spawn path.
      const result = await shellTools.runCommand("sh noisy.sh 2>&1", { cwd: workspacePath });

      expect(result.stdout.startsWith("BEGIN")).toBe(true);
      expect(result.stdout).toContain("SUMMARY: 3 failed");
      expect(result.stdout).toMatch(/\[Output truncated\] \[\.\.\. \d+ chars omitted \.\.\.\]/);
      expect(result.stdout.length).toBeLessThan(110 * 1024);
      expect(result.truncated).toBe(true);
    });

    it("bounds long persistent shell output and keeps its end", async () => {
      await writeNoisyScript();
      const workspace = createWorkspace();
      const taskId = `task-${randomUUID()}`;
      sessions.push({ taskId, workspaceId: workspace.id });
      const shellTools = new ShellTools(
        workspace,
        createDaemon() as unknown as AgentDaemon,
        taskId,
      );

      const result = await shellTools.runCommand("sh noisy.sh", { cwd: workspacePath });

      expect(spawnCalls.some(({ args }) => args.includes("sh noisy.sh"))).toBe(false);
      expect(result.stdout.startsWith("BEGIN")).toBe(true);
      expect(result.stdout).toContain("SUMMARY: 3 failed");
      expect(result.stdout.length).toBeLessThan(110 * 1024);
      expect(result.truncated).toBe(true);
    });
  });

  describe("non-interactive environment", () => {
    const defaults = [
      "GIT_TERMINAL_PROMPT=0",
      "GIT_EDITOR=true",
      "GIT_PAGER=cat",
      "PIP_NO_INPUT=1",
      "DEBIAN_FRONTEND=noninteractive",
    ];

    it("sets non-interactive defaults for one-shot commands, keeping explicit values", async () => {
      const shellTools = new ShellTools(
        createWorkspace(),
        createDaemon() as unknown as AgentDaemon,
        `task-${randomUUID()}`,
      );

      // The pipe routes the command to the one-shot spawn path.
      const result = await shellTools.runCommand("env | sort", {
        cwd: workspacePath,
        env: { PAGER: "less" },
      });

      const lines = result.stdout.split("\n");
      expect(lines).toEqual(expect.arrayContaining([...defaults, "PAGER=less"]));
      expect(lines).not.toContain("PAGER=cat");
      expect(lines.some((line) => line.startsWith("CI="))).toBe(false);
    });

    it("sets non-interactive defaults in the persistent shell, keeping inherited values", async () => {
      const previous = { PAGER: process.env.PAGER, GIT_EDITOR: process.env.GIT_EDITOR };
      process.env.PAGER = "less";
      delete process.env.GIT_EDITOR;
      try {
        const workspace = createWorkspace();
        const taskId = `task-${randomUUID()}`;
        sessions.push({ taskId, workspaceId: workspace.id });
        const shellTools = new ShellTools(
          workspace,
          createDaemon() as unknown as AgentDaemon,
          taskId,
        );

        const result = await shellTools.runCommand("env", { cwd: workspacePath });

        const lines = result.stdout.split("\n");
        expect(spawnCalls.some(({ args }) => args.includes("env"))).toBe(false);
        expect(lines).toEqual(expect.arrayContaining([...defaults, "PAGER=less"]));
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
