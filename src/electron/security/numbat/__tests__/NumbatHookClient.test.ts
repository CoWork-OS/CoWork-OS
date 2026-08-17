import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { invokeNumbatHook } from "../NumbatHookClient";
import { buildAgentSecurityHookPayload } from "../NumbatEventAdapter";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("invokeNumbatHook", () => {
  it("converts a child stdin EPIPE into a rejected hook invocation", async () => {
    const stdin = new EventEmitter() as EventEmitter & { end: (payload: string) => void };
    stdin.end = () =>
      queueMicrotask(() =>
        stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
      );
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-hook-"));
    temporaryRoots.push(root);

    const invocation = invokeNumbatHook({
      binary: {
        path: path.join(root, "numbat"),
        sha256: "test-sha256",
        version: "test",
        commit: "test-commit",
        schemaVersion: "0.2.0",
        source: "bundled",
      },
      payload: buildAgentSecurityHookPayload({
        hookEventName: "PreToolUse",
        taskId: "task-1",
        workspacePath: root,
        toolCallId: "tool-1",
        toolName: "read_file",
        toolInput: { path: "notes.txt" },
      }),
      mode: "monitor",
      ruleProfile: "builtin",
      customRuleDirs: [],
      outputFile: path.join(root, "records.ndjson"),
      stateDb: path.join(root, "state.db"),
      timeoutMs: 1_000,
    });

    await expect(invocation).rejects.toThrow("Failed to send the Numbat hook payload: broken pipe");
    expect(stdin.listenerCount("error")).toBe(1);
  });

  it("rejects child output stream errors without crashing the process", async () => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-numbat-hook-"));
    temporaryRoots.push(root);

    const invocation = invokeNumbatHook({
      binary: {
        path: path.join(root, "numbat"),
        sha256: "test-sha256",
        version: "test",
        commit: "test-commit",
        schemaVersion: "0.2.0",
        source: "bundled",
      },
      payload: buildAgentSecurityHookPayload({
        hookEventName: "PreToolUse",
        taskId: "task-1",
        workspacePath: root,
      }),
      mode: "monitor",
      ruleProfile: "builtin",
      customRuleDirs: [],
      outputFile: path.join(root, "records.ndjson"),
      stateDb: path.join(root, "state.db"),
      timeoutMs: 1_000,
    });
    stdout.emit("error", new Error("stream failed"));

    await expect(invocation).rejects.toThrow("Failed to read Numbat hook output: stream failed");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
