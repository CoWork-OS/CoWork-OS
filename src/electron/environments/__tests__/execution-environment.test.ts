import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionEnvironmentController } from "../ExecutionEnvironmentController";
import type { EnvironmentBackend } from "../environment-backends";
import {
  ExecutionEnvironmentSelectionSchema,
  environmentControlKey,
} from "../../../shared/execution-environment";
import type { Task, Workspace } from "../../../shared/types";
import { ComputerViewService } from "../../computer-use/computer-view-service";
import { BotDesktopManager } from "../../computer-use/bot-desktop-manager";

const source = fs.readFileSync(path.resolve("resources/bot-desktop/cowork-environment.py"), "utf8");

describe("task computer routing and recovery", () => {
  let folder: string;
  let guest: string;
  let task: Task;
  let workspace: Workspace;
  let controller: ExecutionEnvironmentController;
  let backend: EnvironmentBackend;
  let loseResponse: boolean;
  let failRelease: boolean;
  let dispatched: string[];
  const logEvent = vi.fn();

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-computer-test-"));
    guest = path.join(folder, "guest");
    fs.mkdirSync(guest);
    const host = path.join(folder, "host");
    fs.mkdirSync(host);
    workspace = {
      id: "workspace",
      path: host,
      permissions: { read: true, write: true, delete: true, shell: true, network: true },
    } as Workspace;
    task = {
      id: "task",
      workspaceId: workspace.id,
      status: "executing",
      agentConfig: {
        executionEnvironment: ExecutionEnvironmentSelectionSchema.parse({
          backend: "cua",
          lifetime: "task",
        }),
      },
    } as Task;
    loseResponse = false;
    failRelease = false;
    dispatched = [];
    ComputerViewService.resetForTesting({ encodeFrame: () => null });
    backend = {
      allocate: vi.fn(async (binding) => ({
        resourceId: `computer-${binding.id}`,
        cwd: "/home/cua/work",
      })),
      request: vi.fn(async (binding, tool, input, operation) => {
        dispatched.push(tool);
        const request = JSON.stringify({
          root: guest,
          environment: binding.id,
          operation,
          tool,
          input,
        });
        const result = await new Promise<Any>((resolve, reject) => {
          const child = execFile(
            "python3",
            ["-c", source],
            { maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => {
              if (error) reject(error);
              else resolve(JSON.parse(stdout));
            },
          );
          child.stdin!.end(request);
        });
        if (loseResponse) {
          loseResponse = false;
          throw new Error("lost response");
        }
        return result;
      }),
      release: vi.fn(async () => {
        if (failRelease) throw new Error("delete unavailable");
      }),
    };
    controller = new ExecutionEnvironmentController(
      workspace,
      {
        getTask: () => structuredClone(task),
        updateTask: (_id, update) => {
          task = { ...task, ...structuredClone(update) };
        },
        logEvent,
      },
      task.id,
      () => backend,
    );
  });

  afterEach(() => {
    const id = task.agentConfig?.executionEnvironmentBinding?.id;
    if (id)
      fs.rmSync(path.join(os.tmpdir(), "cowork-environments", id), {
        recursive: true,
        force: true,
      });
    fs.rmSync(folder, { recursive: true, force: true });
    ComputerViewService.resetForTesting();
    BotDesktopManager.resetForTesting();
  });

  it("routes file writes and command reads to the same guest without changing host files", async () => {
    fs.writeFileSync(path.join(workspace.path, "canary.txt"), "host");
    await controller.execute("write_file", { path: "canary.txt", content: "guest" });
    const result = await controller.execute("run_command", { command: "cat canary.txt" });
    expect(result.stdout).toBe("guest");
    expect(fs.readFileSync(path.join(workspace.path, "canary.txt"), "utf8")).toBe("host");
  });

  it("pins the binding when selection changes during a run", async () => {
    const first = await controller.ensure();
    task.agentConfig!.executionEnvironment = ExecutionEnvironmentSelectionSchema.parse({
      backend: "bot-desktop",
    });
    expect((await controller.ensure()).id).toBe(first.id);
    expect(controller.selection()?.backend).toBe("cua");
    expect(backend.allocate).toHaveBeenCalledTimes(1);
  });

  it("imports and exports selected binary bytes with verification and create-only publication", async () => {
    fs.writeFileSync(path.join(workspace.path, "input.bin"), Buffer.from([0, 255, 17]));
    await controller.execute("computer_environment", { action: "import", path: "input.bin" });
    const result = await controller.execute("computer_environment", {
      action: "export",
      path: "input.bin",
    });
    expect(fs.readFileSync(path.join(workspace.path, result.path))).toEqual(
      Buffer.from([0, 255, 17]),
    );
    await expect(
      controller.execute("computer_environment", { action: "export", path: "input.bin" }),
    ).rejects.toThrow(/new files|EEXIST/);
  });

  it("recovers a lost write response by reading its receipt without replay", async () => {
    loseResponse = true;
    await expect(
      controller.execute("write_file", { path: "result.txt", content: "one write" }),
    ).rejects.toThrow("lost response");
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("unknown");
    await expect(
      controller.execute("write_file", { path: "other.txt", content: "no" }),
    ).rejects.toThrow(/reconcile/);
    const recovered = await controller.execute("computer_environment", { action: "reconcile" });
    expect(recovered.recoveredResult.success).toBe(true);
    expect(dispatched.filter((name) => name === "write_file")).toHaveLength(1);
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("ready");
  });

  it("retains unknown work when no completion receipt exists", async () => {
    await controller.ensure();
    task.agentConfig!.executionEnvironmentBinding!.state = "unknown";
    task.agentConfig!.executionEnvironmentBinding!.pending = {
      id: "not-dispatched",
      tool: "run_command",
      inputHash: "hash",
    };
    expect(await controller.execute("computer_environment", { action: "reconcile" })).toMatchObject(
      { outcome_unknown: true },
    );
    await expect(controller.finish()).rejects.toThrow(/unresolved/);
    expect(backend.release).not.toHaveBeenCalled();
  });

  it("recovers a lost background handle and stops it during completion", async () => {
    loseResponse = true;
    await expect(
      controller.execute("run_command", { command: "sleep 10", background: true }),
    ).rejects.toThrow("lost response");
    const recovered = await controller.execute("computer_environment", { action: "reconcile" });
    expect(task.agentConfig!.executionEnvironmentBinding?.processIds).toEqual([
      recovered.recoveredResult.process_id,
    ]);
    await controller.finish();
    expect(dispatched.filter((name) => name === "run_command")).toHaveLength(1);
    expect(dispatched).toContain("stop_process");
    expect(task.agentConfig!.executionEnvironmentBinding?.processIds).toEqual([]);
  });

  it("does not provision through reconciliation after network authority is revoked", async () => {
    await controller.ensure();
    task.agentConfig!.executionEnvironmentBinding!.state = "allocating";
    workspace.permissions.network = false;
    await expect(
      controller.execute("computer_environment", { action: "reconcile" }),
    ).rejects.toThrow(/network policy/);
    expect(backend.allocate).toHaveBeenCalledTimes(1);
  });

  it("exports configured results before deleting a disposable computer", async () => {
    task.agentConfig!.executionEnvironment!.outputPaths = ["answer.txt"];
    await controller.execute("write_file", { path: "answer.txt", content: "42" });
    const result = await controller.finish();
    expect(result.released).toBe(true);
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("released");
    expect(result.exported).toHaveLength(1);
    expect(fs.readFileSync(path.join(workspace.path, result.exported![0].path), "utf8")).toBe("42");
  });

  it("retains the computer when an expected result is missing", async () => {
    task.agentConfig!.executionEnvironment!.outputPaths = ["missing.txt"];
    await controller.ensure();
    await expect(controller.finish()).rejects.toThrow(/transfer/);
    expect(backend.release).not.toHaveBeenCalled();
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("cleanup_pending");
  });

  it("retries cleanup without repeating result publication", async () => {
    task.agentConfig!.executionEnvironment!.outputPaths = ["answer.txt"];
    await controller.execute("write_file", { path: "answer.txt", content: "42" });
    failRelease = true;
    await expect(controller.finish()).rejects.toThrow("delete unavailable");
    failRelease = false;
    await controller.finish();
    expect(dispatched.filter((name) => name === "export_file")).toHaveLength(1);
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("released");
  });

  it("retains borrowed and persistent computers", async () => {
    task.agentConfig!.executionEnvironment = ExecutionEnvironmentSelectionSchema.parse({
      backend: "cua",
      space: "existing",
      lifetime: "persistent",
    });
    await controller.ensure();
    await controller.finish();
    expect(backend.release).not.toHaveBeenCalled();
  });

  it.each([undefined, "existing-space"])(
    "exports configured results from retained computers (%s)",
    async (space) => {
      task.agentConfig!.executionEnvironment = ExecutionEnvironmentSelectionSchema.parse({
        backend: "cua",
        lifetime: "persistent",
        space,
        outputPaths: ["answer.txt"],
      });
      await controller.execute("write_file", { path: "answer.txt", content: "retained result" });
      const result = await controller.finish();
      expect(result.retained).toBe(true);
      expect(result.exported).toHaveLength(1);
      expect(fs.readFileSync(path.join(workspace.path, result.exported![0].path), "utf8")).toBe(
        "retained result",
      );
      expect(backend.release).not.toHaveBeenCalled();
      expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("ready");
    },
  );

  it("keeps retained-computer completion pending if a selected result is missing", async () => {
    task.agentConfig!.executionEnvironment!.lifetime = "persistent";
    task.agentConfig!.executionEnvironment!.outputPaths = ["missing.txt"];
    await controller.ensure();
    await expect(controller.finish()).rejects.toThrow(/transfer/);
    expect(task.agentConfig!.executionEnvironmentBinding?.state).toBe("cleanup_pending");
    expect(backend.release).not.toHaveBeenCalled();
  });

  it("rechecks command authority after waiting for a shared computer", async () => {
    vi.mocked(backend.allocate).mockResolvedValue({ resourceId: "shared", cwd: "/home/cua/work" });
    await controller.ensure();
    let other = {
      ...structuredClone(task),
      id: "other",
      agentConfig: { executionEnvironment: task.agentConfig!.executionEnvironment },
    } as Task;
    const peer = new ExecutionEnvironmentController(
      workspace,
      {
        getTask: () => structuredClone(other),
        updateTask: (_id, update) => {
          other = { ...other, ...structuredClone(update) };
        },
        logEvent,
      },
      other.id,
      () => backend,
    );
    await peer.ensure();
    let release!: (value: Any) => void;
    vi.mocked(backend.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = controller.execute("run_command", { command: "pwd" });
    await vi.waitFor(() => expect(backend.request).toHaveBeenCalledOnce());
    const assertion = vi.spyOn(ComputerViewService.getInstance(), "assertNotHeld");
    const waiting = peer.execute("run_command", { command: "pwd" });
    const rejected = expect(waiting).rejects.toThrow(/Command tools are disabled/);
    await vi.waitFor(() => expect(assertion).toHaveBeenCalledWith("other"));
    workspace.permissions.shell = false;
    release({ success: true });
    await first;
    await rejected;
    expect(backend.request).toHaveBeenCalledOnce();
    expect(other.agentConfig!.executionEnvironmentBinding?.pending).toBeUndefined();
    expect(other.agentConfig!.executionEnvironmentBinding?.state).toBe("ready");
  });

  it("refuses traversal, symlink inputs and guest symlink reads", async () => {
    await expect(
      controller.execute("write_file", { path: "../escape", content: "no" }),
    ).rejects.toThrow(/relative path/);
    fs.symlinkSync(path.join(workspace.path, "canary"), path.join(guest, "link"));
    const result = await controller.execute("read_file", { path: "link" });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Symlink") });
    fs.symlinkSync(guest, path.join(workspace.path, "link"));
    await expect(
      controller.execute("computer_environment", { action: "import", path: "link" }),
    ).rejects.toThrow();
  });

  it("rechecks write permissions after allocation", async () => {
    await controller.ensure();
    workspace.permissions.write = false;
    await expect(
      controller.execute("write_file", { path: "blocked.txt", content: "no" }),
    ).rejects.toThrow();
    expect(dispatched).toEqual([]);
  });

  it("rejects policy combinations the backend cannot enforce before allocation", async () => {
    workspace.permissions.accessDomainRules = [{ domain: "example.com", action: "allow" }] as Any;
    await expect(controller.ensure()).rejects.toThrow(/network policy/);
    expect(backend.allocate).not.toHaveBeenCalled();
  });

  it("blocks host-only tools, unqualified plugins and unsupported browser capabilities", () => {
    for (const name of [
      "native_app",
      "run_applescript",
      "create_document",
      "mcp_js",
      "browser_attach",
      "get_env",
      "generate_image",
    ])
      expect(controller.supports(name)).toBe(false);
    for (const name of [
      "run_command",
      "read_file",
      "browser_snapshot",
      "mailbox_action",
      "web_search",
    ])
      expect(controller.supports(name)).toBe(true);
  });

  it("blocks every task sharing a computer while the person has control", async () => {
    const binding = await controller.ensure();
    const view = ComputerViewService.getInstance();
    view.bindEnvironment("other-task", environmentControlKey(binding));
    view.takeOver("other-task");
    await expect(controller.execute("run_command", { command: "pwd" })).rejects.toThrow(
      /taken over/,
    );
    await expect(controller.finish()).rejects.toThrow(/held/);
    view.handBack("other-task");
    expect((await controller.execute("run_command", { command: "pwd" })).stdout.trim()).toBe(
      fs.realpathSync(guest),
    );
  });

  it("routes background process handles to the same computer", async () => {
    const started = await controller.execute("run_command", {
      command: "printf ready",
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const output = await controller.execute("process_output", { process_id: started.process_id });
    expect(output).toMatchObject({ status: "completed", exitCode: 0, stdout: "ready" });
  });

  it("blocks a persisted in-flight operation after restart until its receipt is reconciled", async () => {
    await controller.ensure();
    task.agentConfig!.executionEnvironmentBinding!.pending = {
      id: "interrupted",
      tool: "write_file",
      inputHash: "hash",
    };
    await expect(controller.execute("run_command", { command: "pwd" })).rejects.toThrow(
      /unresolved work/,
    );
    expect(dispatched).toEqual([]);
  });

  it("remembers a command's guest working directory", async () => {
    await controller.execute("run_command", { command: "mkdir child && cd child" });
    const result = await controller.execute("run_command", { command: "pwd" });
    expect(result.stdout.trim()).toBe(path.join(fs.realpathSync(guest), "child"));
  });

  it("bounds noisy command output", async () => {
    const result = await controller.execute("run_command", {
      command: "python3 -c 'print(\"x\" * 500000)'",
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(102400);
  });

  it("enforces command timeouts after the child closes both output streams", async () => {
    const result = await controller.execute("run_command", {
      command: "exec >/dev/null 2>&1; sleep 10",
      timeout_seconds: 1,
    });
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
  });

  it("cancels a background child even after it closes both output streams", async () => {
    const started = await controller.execute("run_command", {
      command: "exec >/dev/null 2>&1; sleep 10",
      background: true,
    });
    const result = await controller.execute("stop_process", { process_id: started.process_id });
    expect(result.status).toBe("completed");
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses implicit-root discovery when read authority is revoked", async () => {
    await controller.ensure();
    workspace.permissions.read = false;
    await expect(controller.execute("glob", { pattern: "**/*" })).rejects.toThrow(
      /reads are disabled/,
    );
    expect(dispatched).toEqual([]);
  });

  it("normalizes guest paths before applying host permission boundaries", () => {
    expect(controller.normalizeInput("read_file", { path: "/home/cua/work/file.txt" })).toEqual({
      path: "file.txt",
    });
    expect(() => controller.normalizeInput("read_file", { path: "/etc/passwd" })).toThrow(
      /outside/,
    );
  });

  it("does not accept a disposable borrowed computer", () => {
    expect(
      ExecutionEnvironmentSelectionSchema.safeParse({
        backend: "cua",
        lifetime: "task",
        space: "existing",
      }).success,
    ).toBe(false);
  });

  it("shares a delegated computer without giving the child ownership or releasing active delegated work", async () => {
    let child = {
      ...task,
      id: "child",
      parentTaskId: task.id,
      agentConfig: {
        executionEnvironment: structuredClone(task.agentConfig!.executionEnvironment),
        executionEnvironmentParentTaskId: task.id,
      },
    } as Task;
    const daemon = {
      getTask: (id: string) => structuredClone(id === "child" ? child : task),
      updateTask: (id: string, update: { agentConfig: Task["agentConfig"] }) => {
        if (id === "child") child = { ...child, ...structuredClone(update) };
        else task = { ...task, ...structuredClone(update) };
      },
      getChildTasks: async (id: string) => (id === task.id ? [child] : []),
      logEvent,
    };
    const parentController = new ExecutionEnvironmentController(
      workspace,
      daemon,
      task.id,
      () => backend,
    );
    const childController = new ExecutionEnvironmentController(
      workspace,
      daemon,
      child.id,
      () => backend,
    );
    const inherited = await childController.ensure();
    expect(inherited.resourceId).toBe(task.agentConfig!.executionEnvironmentBinding!.resourceId);
    expect(inherited.owned).toBe(false);
    expect(backend.allocate).toHaveBeenCalledTimes(1);
    await expect(parentController.finish()).rejects.toThrow(/Delegated work/);
    expect(backend.release).not.toHaveBeenCalled();
    child.status = "completed";
    expect(await childController.finish()).toMatchObject({ retained: true });
    expect(await parentController.finish()).toMatchObject({ released: true });
    expect(backend.release).toHaveBeenCalledTimes(1);
  });
});
