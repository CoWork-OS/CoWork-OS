/**
 * run_command background: true, process_output and stop_process with real
 * processes on the unsandboxed (full-access profile) path.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { testUserDataDir } = vi.hoisted(() => ({
  testUserDataDir: `/tmp/cowork-shell-background-test-${process.pid}-${Date.now()}`,
}));

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

import { spawn } from "node:child_process";
import { createSandbox } from "../../sandbox/sandbox-factory";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { ShellTools, LONG_RUNNING_COMMAND_HINT, looksLikeLongRunningCommand } from "../shell-tools";
import {
  MAX_BACKGROUND_PROCESSES_PER_TASK,
  getBackgroundProcessManager,
} from "../background-processes";
import type { AgentDaemon } from "../../daemon";
import type { Workspace } from "../../../../shared/types";

const workspacePath = path.join(testUserDataDir, "workspace");
const node = JSON.stringify(process.execPath);

function createWorkspace(): Workspace {
  return {
    id: `workspace-${randomUUID()}`,
    name: "Shell background",
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

function createDaemon(approve = true) {
  return {
    requestApproval: vi.fn().mockResolvedValue(approve),
    logEvent: vi.fn(),
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const TICKER = `${node} -e "console.log('Server listening on http://127.0.0.1:4321'); setInterval(() => console.log('tick'), 100)"`;

describe.skipIf(process.platform === "win32")("run_command background processes", () => {
  const taskIds: string[] = [];

  function newShellTools(daemon = createDaemon()) {
    const taskId = `task-${randomUUID()}`;
    taskIds.push(taskId);
    return {
      shellTools: new ShellTools(createWorkspace(), daemon as unknown as AgentDaemon, taskId),
      daemon,
      taskId,
    };
  }

  beforeEach(async () => {
    await mkdir(workspacePath, { recursive: true });
    vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({ blocked: false });
    vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({ trusted: false });
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "per_command",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const taskId of taskIds.splice(0)) {
      await getBackgroundProcessManager().stopAllForTask(taskId, "test_cleanup");
    }
    await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("returns promptly with startup output once the server prints a ready line", async () => {
    const { shellTools } = newShellTools();
    const startedAt = Date.now();

    const result = await shellTools.startBackgroundCommand(TICKER, { cwd: workspacePath });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result).toMatchObject({
      success: true,
      background: true,
      status: "running",
      running: true,
      sandbox: "none",
      urls: ["http://127.0.0.1:4321"],
    });
    expect(result.startup_output).toContain("Server listening on http://127.0.0.1:4321");
    expect(isRunning(result.pid as number)).toBe(true);
  }, 15_000);

  it("waits only the startup window for a process that prints no ready line", async () => {
    const { shellTools } = newShellTools();
    const startedAt = Date.now();

    const result = await shellTools.startBackgroundCommand(
      `${node} -e "setInterval(() => console.log('tick'), 100)"`,
      { cwd: workspacePath, startupWaitMs: 600 },
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result).toMatchObject({ success: true, running: true });
    expect(result.startup_output).toContain("tick");
  }, 15_000);

  it("pages output with process_output", async () => {
    const { shellTools } = newShellTools();
    const started = await shellTools.startBackgroundCommand(TICKER, { cwd: workspacePath });
    const processId = started.process_id as string;

    const next = await shellTools.getBackgroundProcessOutput({
      process_id: processId,
      wait_ms: 2_000,
    });
    expect(next).toMatchObject({ success: true, process_id: processId, running: true });
    expect(next.output).toContain("tick");
    expect(next.output).not.toContain("Server listening");
    expect(next.next_offset as number).toBeGreaterThan(started.next_offset as number);

    const fromStart = await shellTools.getBackgroundProcessOutput({
      process_id: processId,
      since_offset: 0,
    });
    expect(String(fromStart.output).startsWith("Server listening")).toBe(true);

    const tail = await shellTools.getBackgroundProcessOutput({
      process_id: processId,
      since_offset: 0,
      tail_lines: 1,
    });
    expect(tail.output).toBe("tick\n");

    const list = await shellTools.getBackgroundProcessOutput({});
    expect(list.processes).toEqual([expect.objectContaining({ process_id: processId })]);
  }, 15_000);

  it("stop_process kills the whole process tree", async () => {
    const { shellTools } = newShellTools();
    const started = await shellTools.startBackgroundCommand(
      `sleep 30 & echo "child:$!"; ${node} -e "console.log('ready on http://localhost:9'); setInterval(() => {}, 1000)"`,
      { cwd: workspacePath },
    );
    const childPid = Number(String(started.startup_output).match(/child:(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(isRunning(childPid)).toBe(true);

    const stopped = await shellTools.stopBackgroundProcess({ process_id: started.process_id });

    expect(stopped).toMatchObject({ success: true, status: "stopped", running: false });
    await waitUntil(() => !isRunning(childPid), 5_000, "the child process to exit");
    expect(isRunning(started.pid as number)).toBe(false);
    const again = await shellTools.stopBackgroundProcess({ process_id: started.process_id });
    expect(again).toMatchObject({ success: true, already_exited: true });
  }, 20_000);

  it("reports a command that exits during startup and leaves nothing behind", async () => {
    const { shellTools } = newShellTools();
    const result = await shellTools.startBackgroundCommand(
      'sleep 30 & echo "child:$!"; echo "boom" >&2; exit 3',
      { cwd: workspacePath },
    );
    const childPid = Number(String(result.startup_output).match(/child:(\d+)/)?.[1]);

    expect(result).toMatchObject({ success: false, status: "exited", exit_code: 3 });
    expect(result.error).toMatch(/exited during startup with code 3/);
    expect(result.stdout).toContain("boom");
    await waitUntil(() => !isRunning(childPid), 5_000, "the orphaned child to be killed");
  }, 15_000);

  it("redacts secrets in background output", async () => {
    const { shellTools } = newShellTools();
    const result = await shellTools.startBackgroundCommand(
      "printf -- '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n'; sleep 30",
      { cwd: workspacePath, startupWaitMs: 800 },
    );
    expect(result.startup_output).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result.startup_output).not.toContain("BEGIN PRIVATE KEY");
  }, 15_000);

  it("asks for approval exactly like run_command and starts nothing when denied", async () => {
    const { shellTools, daemon, taskId } = newShellTools(createDaemon(false));

    await expect(shellTools.startBackgroundCommand(TICKER, { cwd: workspacePath })).rejects.toThrow(
      "User denied command execution",
    );

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "run_command",
      expect.stringContaining("keeps running in the background"),
      expect.objectContaining({ command: TICKER, background: true }),
      expect.anything(),
    );
    expect(getBackgroundProcessManager().list(taskId)).toEqual([]);
  });

  it("goes through the typed daemon authorization when available", async () => {
    const authorizeToolAction = vi.fn().mockResolvedValue(false);
    const daemon = { ...createDaemon(), authorizeToolAction };
    const { shellTools, taskId } = newShellTools(daemon);

    await expect(shellTools.startBackgroundCommand(TICKER, { cwd: workspacePath })).rejects.toThrow(
      "User denied command execution",
    );
    expect(authorizeToolAction).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        toolName: "run_command",
        approvalType: "run_command",
        details: expect.objectContaining({ command: TICKER, background: true }),
      }),
    );
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps guardrail-blocked commands blocked", async () => {
    vi.mocked(GuardrailManager.isCommandBlocked).mockReturnValue({
      blocked: true,
      pattern: "rm -rf",
    });
    const { shellTools, daemon } = newShellTools();

    await expect(
      shellTools.startBackgroundCommand("rm -rf / --no-preserve-root", { cwd: workspacePath }),
    ).rejects.toThrow(/blocked by guardrails/);
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });

  it("refuses a sixth process before asking for approval", async () => {
    const { shellTools, daemon, taskId } = newShellTools();
    for (let i = 0; i < MAX_BACKGROUND_PROCESSES_PER_TASK; i += 1) {
      await shellTools.startBackgroundCommand(`sleep 30 # ${i}`, {
        cwd: workspacePath,
        startupWaitMs: 0,
      });
    }
    const approvals = daemon.requestApproval.mock.calls.length;
    expect(approvals).toBeGreaterThan(0);

    await expect(
      shellTools.startBackgroundCommand("sleep 31", { cwd: workspacePath, startupWaitMs: 0 }),
    ).rejects.toThrow(/maximum/);
    expect(daemon.requestApproval).toHaveBeenCalledTimes(approvals);
    expect(daemon.logEvent).not.toHaveBeenCalledWith(
      taskId,
      "tool_call",
      expect.objectContaining({ command: "sleep 31" }),
    );

    const pids = getBackgroundProcessManager()
      .list(taskId)
      .map((entry) => entry.pid as number);
    expect(await shellTools.stopAllBackgroundProcesses("task_cancelled")).toBe(
      MAX_BACKGROUND_PROCESSES_PER_TASK,
    );
    expect(getBackgroundProcessManager().list(taskId)).toEqual([]);
    await waitUntil(() => pids.every((pid) => !isRunning(pid)), 5_000, "all processes to exit");
  }, 30_000);

  it("rejects unknown and other tasks' process ids", async () => {
    const owner = newShellTools();
    const other = newShellTools();
    const started = await owner.shellTools.startBackgroundCommand("sleep 30", {
      cwd: workspacePath,
      startupWaitMs: 0,
    });

    await expect(
      other.shellTools.getBackgroundProcessOutput({ process_id: started.process_id }),
    ).rejects.toThrow(/No background process/);
    await expect(
      other.shellTools.stopBackgroundProcess({ process_id: started.process_id }),
    ).rejects.toThrow(/No background process/);
    expect(isRunning(started.pid as number)).toBe(true);
  }, 15_000);

  it("runs in the Docker sandbox through spawnProcess and says the host cannot reach it", async () => {
    const containerClient = spawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
    const stopContainer = vi.fn(() => containerClient.kill("SIGKILL"));
    const spawnProcess = vi.fn(() => ({ process: containerClient, cleanup: stopContainer }));
    const cleanupSandbox = vi.fn();
    vi.mocked(createSandbox).mockResolvedValueOnce({
      type: "docker",
      spawnProcess,
      cleanup: cleanupSandbox,
    } as never);
    const taskId = `task-${randomUUID()}`;
    taskIds.push(taskId);
    const workspace = createWorkspace();
    workspace.permissions.accessSandboxMode = "workspace-write";
    const shellTools = new ShellTools(workspace, createDaemon() as unknown as AgentDaemon, taskId);

    const started = await shellTools.startBackgroundCommand("npm run dev", {
      cwd: path.join(workspacePath, "app"),
      startupWaitMs: 0,
    });

    expect(spawnProcess).toHaveBeenCalledWith("/bin/sh", ["-c", "npm run dev"], {
      cwd: "/workspace/app",
      allowNetwork: false,
      allowLoopbackListen: false,
      detached: false,
    });
    expect(started).toMatchObject({
      success: true,
      sandbox: "docker",
      reachable_from_host: false,
      notes: [expect.stringMatching(/Docker container with no published ports/)],
    });

    await shellTools.stopBackgroundProcess({ process_id: started.process_id });
    expect(stopContainer).toHaveBeenCalled();
    expect(cleanupSandbox).toHaveBeenCalledTimes(1);
  }, 15_000);

  describe("foreground timeouts", () => {
    it("suggests background: true when a server-like command times out", async () => {
      const { shellTools } = newShellTools();
      // The separator keeps the command off the persistent shell.
      const result = await shellTools.runCommand("tail -f /dev/null; true", {
        cwd: workspacePath,
        timeout: 800,
      });
      expect(result).toMatchObject({
        terminationReason: "timeout",
        hint: LONG_RUNNING_COMMAND_HINT,
      });
    }, 15_000);

    it("does not add the hint to other timeouts", async () => {
      const { shellTools } = newShellTools();
      const result = await shellTools.runCommand("sleep 5; true", {
        cwd: workspacePath,
        timeout: 800,
      });
      expect(result.terminationReason).toBe("timeout");
      expect(result.hint).toBeUndefined();
    }, 15_000);

    it.each([
      ["npm run dev", true],
      ["pnpm dev", true],
      ["yarn start", true],
      ["npx vite --port 5173", true],
      ["next dev", true],
      ["python3 -m http.server 8000", true],
      ["npx serve dist", true],
      ["nodemon server.js", true],
      ["tsc --watch", true],
      ["npx vite build", false],
      ["npm run build", false],
      ["npm test", false],
      ["git status", false],
    ])("classifies %s as long-running=%s", (command, expected) => {
      expect(looksLikeLongRunningCommand(command)).toBe(expected);
    });
  });
});
