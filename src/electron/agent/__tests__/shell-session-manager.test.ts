import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ShellSessionManager", () => {
  let userDataDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-shell-session-")));
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(userDataDir, "workspace-")));
    fs.mkdirSync(path.join(workspaceDir, "subdir"), { recursive: true });
    process.env.COWORK_USER_DATA_DIR = userDataDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.COWORK_USER_DATA_DIR;
    vi.restoreAllMocks();
  });

  it("preserves cwd across commands and resets session state", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();

    const commonRequest = {
      taskId: "task-1",
      workspaceId: "workspace-1",
      workspacePath: workspaceDir,
      timeoutMs: 10_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        terminationReason: "error" as const,
      }),
    };

    const first = await manager.runCommand({
      ...commonRequest,
      command: "pwd",
    });
    expect(first.usedPersistentSession).toBe(true);
    expect(first.success).toBe(true);
    expect(first.stdout.trim()).toContain(workspaceDir);

    const second = await manager.runCommand({
      ...commonRequest,
      command: "cd subdir && pwd",
    });
    expect(second.usedPersistentSession).toBe(true);
    expect(second.success).toBe(true);
    expect(second.stdout.trim()).toContain(path.join(workspaceDir, "subdir"));

    const session = manager.getSessionInfo("task-1", "workspace-1");
    expect(session?.commandCount).toBe(2);
    expect(session?.cwd).toBe(path.join(workspaceDir, "subdir"));
    expect(session?.status).toBe("active");

    const listed = manager.listSessions("task-1", "workspace-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.cwd).toBe(path.join(workspaceDir, "subdir"));

    const reset = await manager.resetSession("task-1", "workspace-1");
    expect(reset?.status).toBe("inactive");
    expect(reset?.commandCount).toBe(0);
    expect(reset?.cwd).toBe(path.join(workspaceDir, "subdir"));

    const closed = await manager.closeSession("task-1", "workspace-1");
    expect(closed?.status).toBe("ended");
  }, 30_000);

  it("does not persist environment values to disk", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();
    const stateFile = path.join(userDataDir, "shell-sessions.json");

    await manager.runCommand({
      taskId: "task-2",
      workspaceId: "workspace-2",
      workspacePath: workspaceDir,
      command: "export COWORK_TEST_SECRET='super-secret-value' && pwd",
      timeoutMs: 10_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        terminationReason: "error" as const,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const persisted = fs.readFileSync(stateFile, "utf8");
    expect(persisted).not.toContain("super-secret-value");
    expect(persisted).not.toContain("COWORK_TEST_SECRET");
  });

  it("resets a timed-out session so later commands use a fresh shell", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();

    const requestBase = {
      taskId: "task-3",
      workspaceId: "workspace-3",
      workspacePath: workspaceDir,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        terminationReason: "error" as const,
      }),
    };

    await expect(
      manager.runCommand({
        ...requestBase,
        command: "sleep 2",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Persistent shell command timed out.");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const next = await manager.runCommand({
      ...requestBase,
      command: "pwd",
      timeoutMs: 10_000,
    });

    expect(next.success).toBe(true);
    expect(next.stdout.trim()).toContain(workspaceDir);
  });

  it("rejects concurrent commands on the same terminal tab", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();
    const tab = await manager.createTab({
      workspaceId: "workspace-tabs",
      workspacePath: workspaceDir,
      title: "Test tab",
    });

    const first = manager.runInTab({
      tabId: tab.id,
      workspacePath: workspaceDir,
      command: "sleep 1",
      timeoutMs: 10_000,
    });

    await expect(
      manager.runInTab({
        tabId: tab.id,
        workspacePath: workspaceDir,
        command: "pwd",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Terminal session is already running a command.");

    await manager.stopSessionById(tab.id);
    await first;
  });

  it("interrupts a running terminal tab on ctrl-c input", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();
    const tab = await manager.createTab({
      workspaceId: "workspace-tabs",
      workspacePath: workspaceDir,
      title: "Test tab",
    });

    const running = manager.runInTab({
      tabId: tab.id,
      workspacePath: workspaceDir,
      command: "sleep 10",
      timeoutMs: 20_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const interrupted = await manager.writeToSession(tab.id, "\x03");
    expect(interrupted.status).toBe("inactive");
    await expect(running).resolves.toMatchObject({
      success: false,
      terminationReason: "user_stopped",
    });

    const restarted = await manager.writeToSession(tab.id, "");
    expect(restarted.status).toBe("active");
  });

  it("limits retained terminal tabs per workspace", async () => {
    const { ShellSessionManager } = await import("../tools/shell-session-manager");
    const manager = ShellSessionManager.getInstance();

    for (let index = 0; index < 12; index += 1) {
      await manager.createTab({
        workspaceId: "workspace-tab-limit",
        workspacePath: workspaceDir,
        title: `Tab ${index + 1}`,
      });
    }

    await expect(
      manager.createTab({
        workspaceId: "workspace-tab-limit",
        workspacePath: workspaceDir,
        title: "Overflow",
      }),
    ).rejects.toThrow("Terminal tabs are limited to 12 per workspace.");
  });
});
