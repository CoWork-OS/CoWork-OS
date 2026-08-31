import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  AcpxRuntimeRunner,
  AcpxRuntimeUnavailableError,
  getAcpxAgentDisplayName,
  buildAcpxBaseArgs,
  buildAcpxCommandArgs,
  getAcpxPermissionArgs,
  getAcpxSessionName,
  mapAcpxSessionUpdate,
  resetAcpxLauncherPreferenceForTests,
} from "../AcpxRuntimeRunner";

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: childProcessMocks.spawn,
}));

function createFakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, Array<(...args: Any[]) => void>>();
  const proc: Any = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    killed: false,
    kill: vi.fn().mockImplementation(() => {
      proc.killed = true;
      return true;
    }),
    on: vi.fn((event: string, cb: (...args: Any[]) => void) => {
      const existing = listeners.get(event) || [];
      existing.push(cb);
      listeners.set(event, existing);
      return proc;
    }),
    once: vi.fn((event: string, cb: (...args: Any[]) => void) => {
      const existing = listeners.get(event) || [];
      existing.push(cb);
      listeners.set(event, existing);
      return proc;
    }),
    emit(event: string, ...args: Any[]) {
      for (const cb of listeners.get(event) || []) {
        cb(...args);
      }
    },
  };
  return proc;
}

describe("AcpxRuntimeRunner helpers", () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
    resetAcpxLauncherPreferenceForTests();
  });

  it("builds deterministic session names", () => {
    expect(getAcpxSessionName("task-123")).toBe("cowork-task-123");
  });

  it("maps permission modes to acpx flags", () => {
    expect(getAcpxPermissionArgs("approve-reads")).toEqual(["--approve-reads"]);
    expect(getAcpxPermissionArgs("approve-all")).toEqual(["--approve-all"]);
    expect(getAcpxPermissionArgs("deny-all")).toEqual(["--deny-all"]);
  });

  it("builds acpx base args with ttl and non-interactive policy", () => {
    expect(
      buildAcpxBaseArgs({
        cwd: "/repo",
        runtimeConfig: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
          ttlSeconds: 60,
        },
      }),
    ).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/repo",
      "--approve-reads",
      "--non-interactive-permissions",
      "fail",
      "--ttl",
      "60",
    ]);
  });

  it("builds full acpx command args for prompt execution", () => {
    expect(
      buildAcpxCommandArgs({
        cwd: "/repo",
        runtimeConfig: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "deny-all",
        },
        commandArgs: ["prompt", "--session", "cowork-task-1", "--file", "-"],
      }),
    ).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/repo",
      "--deny-all",
      "--non-interactive-permissions",
      "fail",
      "codex",
      "prompt",
      "--session",
      "cowork-task-1",
      "--file",
      "-",
    ]);
  });

  it("builds Claude acpx command args for prompt execution", () => {
    expect(
      buildAcpxCommandArgs({
        cwd: "/repo",
        runtimeConfig: {
          kind: "acpx",
          agent: "claude",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "deny-all",
        },
        commandArgs: ["prompt", "--session", "cowork-task-1", "--file", "-"],
      }),
    ).toEqual([
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      "/repo",
      "--deny-all",
      "--non-interactive-permissions",
      "fail",
      "claude",
      "prompt",
      "--session",
      "cowork-task-1",
      "--file",
      "-",
    ]);
  });

  it("returns a display label for supported runtime agents", () => {
    expect(getAcpxAgentDisplayName("codex")).toBe("Codex");
    expect(getAcpxAgentDisplayName("claude")).toBe("Claude Code");
  });

  it("maps tool call updates into command and tool events", () => {
    expect(
      mapAcpxSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "List files",
        kind: "search",
        status: "in_progress",
        rawInput: {
          command: ["/bin/zsh", "-lc", "ls -1A"],
          cwd: "/repo",
          parsed_cmd: [{ type: "list_files" }],
        },
      }),
    ).toEqual([
      {
        type: "command_output",
        payload: {
          command: '/bin/zsh -lc "ls -1A"',
          cwd: "/repo",
          type: "start",
          output: '$ /bin/zsh -lc "ls -1A"\n',
        },
      },
      {
        type: "tool_call",
        payload: {
          tool: "list_files",
          kind: "search",
          title: "List files",
          toolCallId: "call_1",
          status: "in_progress",
          input: {
            command: ["/bin/zsh", "-lc", "ls -1A"],
            cwd: "/repo",
            parsed_cmd: [{ type: "list_files" }],
          },
          command: '/bin/zsh -lc "ls -1A"',
          cwd: "/repo",
        },
      },
    ]);
  });

  it("maps tool completion updates into stdout and tool results", () => {
    expect(
      mapAcpxSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: {
          command: ["/bin/zsh", "-lc", "ls -1A"],
          cwd: "/repo",
          formatted_output: "src\npackage.json\n",
          stderr: "",
          exit_code: 0,
        },
      }),
    ).toEqual([
      {
        type: "command_output",
        payload: {
          command: '/bin/zsh -lc "ls -1A"',
          cwd: "/repo",
          type: "stdout",
          output: "src\npackage.json\n",
        },
      },
      {
        type: "tool_result",
        payload: {
          tool: "tool",
          toolCallId: "call_1",
          status: "completed",
          success: true,
          error: undefined,
          result: {
            command: ["/bin/zsh", "-lc", "ls -1A"],
            cwd: "/repo",
            formatted_output: "src\npackage.json\n",
            stderr: "",
            exit_code: 0,
          },
          exitCode: 0,
        },
      },
    ]);
  });

  it("uses Claude-specific labels in progress updates when requested", () => {
    expect(
      mapAcpxSessionUpdate(
        {
          sessionUpdate: "usage_update",
          used: 42,
        },
        "claude",
      ),
    ).toEqual([
      {
        type: "progress_update",
        payload: {
          phase: "acpx_runtime",
          message: "Claude Code via ACP running (42 tokens used)",
          state: "active",
          heartbeat: true,
        },
      },
    ]);
  });

  it("maps Claude thought chunks to a friendly thinking label", () => {
    expect(
      mapAcpxSessionUpdate(
        {
          sessionUpdate: "agent_thought_chunk",
        },
        "claude",
      ),
    ).toEqual([
      {
        type: "progress_update",
        payload: {
          phase: "acpx_runtime",
          message: "Thinking",
          state: "active",
        },
      },
    ]);
  });
});

describe("AcpxRuntimeRunner", () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
  });

  it("parses NDJSON prompt output into CoWork events and final assistant text", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: (type, payload) => {
        events.push({ type, payload });
      },
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stdout.write(
      [
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              title: "List files",
              kind: "search",
              status: "in_progress",
              rawInput: {
                command: ["/bin/zsh", "-lc", "ls -1A"],
                cwd: "/repo",
                parsed_cmd: [{ type: "list_files" }],
              },
            },
          },
        }),
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_1",
              status: "completed",
              rawOutput: {
                command: ["/bin/zsh", "-lc", "ls -1A"],
                cwd: "/repo",
                formatted_output: "src\n",
                stderr: "",
                exit_code: 0,
              },
            },
          },
        }),
        JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done." },
            },
          },
        }),
        JSON.stringify({
          result: {
            stopReason: "end_turn",
            sessionId: "session-1",
          },
        }),
      ].join("\n") + "\n",
    );
    proc.emit("close", 0);

    await expect(promptPromise).resolves.toEqual({
      assistantText: "Done.",
      stopReason: "end_turn",
      sessionId: "session-1",
    });
    expect(events.map((event) => event.type)).toEqual([
      "progress_update",
      "command_output",
      "tool_call",
      "command_output",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("logs malformed JSON lines and continues", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: (type, payload) => {
        events.push({ type, payload });
      },
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stdout.write("not-json\n");
    proc.stdout.write(
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Okay" },
          },
        },
      }) + "\n",
    );
    proc.emit("close", 0);

    await expect(promptPromise).resolves.toEqual({
      assistantText: "Okay",
      stopReason: undefined,
      sessionId: undefined,
    });
    expect(events.some((event) => event.type === "log")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "assistant_message",
      payload: { message: "Okay" },
    });
  });

  it("surfaces missing acpx as a runtime-unavailable error", async () => {
    childProcessMocks.spawn.mockImplementation(() => {
      const proc = createFakeProcess();
      queueMicrotask(() => {
        proc.emit("error", Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }));
      });
      return proc;
    });
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    await expect(runner.createSession()).rejects.toBeInstanceOf(AcpxRuntimeUnavailableError);
  });

  it("falls back to npx acpx@latest when acpx is missing", async () => {
    const missingProc = createFakeProcess();
    const fallbackProc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValueOnce(missingProc).mockReturnValueOnce(fallbackProc);
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "claude",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    const promise = runner.createSession();
    missingProc.emit("error", Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }));
    fallbackProc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      assistantText: "",
      stopReason: undefined,
      sessionId: undefined,
    });
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "acpx",
      [
        "--format",
        "json",
        "--json-strict",
        "--cwd",
        "/repo",
        "--approve-reads",
        "--non-interactive-permissions",
        "fail",
        "claude",
        "sessions",
        "new",
        "--name",
        "cowork-task-1",
      ],
      expect.any(Object),
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      "npx",
      [
        "-y",
        "acpx@latest",
        "--format",
        "json",
        "--json-strict",
        "--cwd",
        "/repo",
        "--approve-reads",
        "--non-interactive-permissions",
        "fail",
        "claude",
        "sessions",
        "new",
        "--name",
        "cowork-task-1",
      ],
      expect.any(Object),
    );
  });

  it("falls back to npx acpx@latest for cancel when acpx is missing", async () => {
    const missingCreateProc = createFakeProcess();
    const fallbackCreateProc = createFakeProcess();
    const missingCancelProc = createFakeProcess();
    const fallbackCancelProc = createFakeProcess();
    childProcessMocks.spawn
      .mockReturnValueOnce(missingCreateProc)
      .mockReturnValueOnce(fallbackCreateProc)
      .mockReturnValueOnce(missingCancelProc)
      .mockReturnValueOnce(fallbackCancelProc);

    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "claude",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    const createPromise = runner.createSession();
    missingCreateProc.emit(
      "error",
      Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }),
    );
    fallbackCreateProc.emit("close", 0);
    await createPromise;

    const cancelPromise = runner.cancel();
    missingCancelProc.emit(
      "error",
      Object.assign(new Error("spawn acpx ENOENT"), { code: "ENOENT" }),
    );
    missingCancelProc.emit("close", -2);
    fallbackCancelProc.emit("close", 0);
    await cancelPromise;

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      3,
      "acpx",
      ["claude", "cancel", "--session", "cowork-task-1"],
      expect.any(Object),
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      4,
      "npx",
      ["-y", "acpx@latest", "claude", "cancel", "--session", "cowork-task-1"],
      expect.any(Object),
    );
  });

  it("rejects when acpx exits non-zero", async () => {
    const proc = createFakeProcess();
    childProcessMocks.spawn.mockReturnValue(proc);
    const runner = new AcpxRuntimeRunner({
      taskId: "task-1",
      cwd: "/repo",
      runtimeConfig: {
        kind: "acpx",
        agent: "codex",
        sessionMode: "persistent",
        outputMode: "json",
        permissionMode: "approve-reads",
      },
      emitEvent: () => undefined,
    });

    const promptPromise = runner.prompt("Review the patch");
    proc.stderr.write("adapter crashed");
    proc.emit("close", 1);

    await expect(promptPromise).rejects.toThrow("adapter crashed");
  });
});
