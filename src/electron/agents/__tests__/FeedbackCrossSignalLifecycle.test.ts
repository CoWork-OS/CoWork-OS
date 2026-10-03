import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recentTaskEventsOfType, writeKitFileWithSnapshot, tasks, workspaces } = vi.hoisted(() => ({
  recentTaskEventsOfType: vi.fn(async () => [] as unknown[]),
  writeKitFileWithSnapshot: vi.fn(),
  tasks: new Map<string, Record<string, unknown>>(),
  workspaces: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../agent-signal-reads", () => ({ recentTaskEventsOfType }));
vi.mock("../../context/kit-revisions", () => ({ writeKitFileWithSnapshot }));
vi.mock("../../database/repository-facades", () => ({
  TaskRepository: class {
    async findById(id: string) {
      return tasks.get(id);
    }
  },
  WorkspaceRepository: class {
    async findById(id: string) {
      return workspaces.get(id);
    }
  },
}));
vi.mock("../agent-repository-facades", () => ({
  AgentRoleRepository: class {
    async findById(id: string) {
      return { id, displayName: id === "role-a" ? "Researcher" : "Writer" };
    }
  },
}));

import { FeedbackService } from "../FeedbackService";
import { CrossSignalService } from "../CrossSignalService";
import type { AgentDaemon } from "../../agent/daemon";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-feedback-lifecycle-"));
  fs.mkdirSync(path.join(tmpDir, ".cowork"), { recursive: true });
  workspaces.set("ws-1", {
    id: "ws-1",
    path: tmpDir,
    permissions: { read: true, write: true, delete: true, network: false, shell: false },
  });
  tasks.set("task-a", { id: "task-a", title: "Draft", workspaceId: "ws-1", assignedAgentRoleId: "role-a" });
  tasks.set("task-b", { id: "task-b", title: "Edit", workspaceId: "ws-1", assignedAgentRoleId: "role-b" });
  recentTaskEventsOfType.mockClear();
  writeKitFileWithSnapshot.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  tasks.clear();
  workspaces.clear();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The pathGuard passed to the last kit write enforces the workspace access boundary. */
function expectGuardDeniesProtectedPaths(): void {
  const guard = writeKitFileWithSnapshot.mock.calls.at(-1)?.[4] as
    | ((absPath: string, operation: "read" | "write") => void)
    | undefined;
  expect(typeof guard).toBe("function");
  expect(() => guard!(path.join(tmpDir, ".cowork", "MISTAKES.md"), "write")).not.toThrow();
  expect(() => guard!(path.join(tmpDir, ".cowork", "policy", "tools.monty"), "write")).toThrow(
    /protected_path/,
  );
  expect(() => guard!(path.join(tmpDir, ".git", "hooks", "pre-commit"), "write")).toThrow(
    /protected_path/,
  );
  expect(() => guard!(path.join(os.tmpdir(), "elsewhere", "MISTAKES.md"), "write")).toThrow(
    /Access denied/,
  );
}

describe("FeedbackService", () => {
  it("rebuilds patterns from the full 90-day pattern window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const daemon = new EventEmitter() as unknown as AgentDaemon;
    const service = new FeedbackService({} as never);
    await service.start(daemon);
    const sinceMs = (recentTaskEventsOfType.mock.calls[0] as unknown[])[2] as number;
    expect(Date.now() - sinceMs).toBe(90 * 24 * 60 * 60 * 1000);
    await service.stop();
  });

  it("stop() flushes debounced feedback and detaches from the daemon", async () => {
    const daemon = new EventEmitter();
    const service = new FeedbackService({} as never);
    await service.start(daemon as unknown as AgentDaemon);
    expect(daemon.listenerCount("user_feedback")).toBe(1);

    daemon.emit("user_feedback", { taskId: "task-a", decision: "rejected", reason: "Too vague" });
    await vi.waitFor(() => {
      expect((service as unknown as { stateByWorkspace: Map<string, unknown> }).stateByWorkspace.size).toBe(1);
    });

    await service.stop();

    expect(daemon.listenerCount("user_feedback")).toBe(0);
    const feedbackDir = path.join(tmpDir, ".cowork", "feedback");
    const files = fs.readdirSync(feedbackDir);
    expect(files).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(feedbackDir, files[0]), "utf8"));
    expect(written.entries[0]).toMatchObject({ decision: "rejected", reason: "Too vague" });
    expect(writeKitFileWithSnapshot).toHaveBeenCalledWith(
      path.join(tmpDir, ".cowork", "MISTAKES.md"),
      expect.stringContaining("Researcher: Too vague"),
      "agent",
      "service:feedback_flush",
      expect.any(Function),
    );
    expectGuardDeniesProtectedPaths();

    // Events after stop are ignored.
    writeKitFileWithSnapshot.mockClear();
    daemon.emit("user_feedback", { taskId: "task-a", decision: "rejected", reason: "Late" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeKitFileWithSnapshot).not.toHaveBeenCalled();
  });
});

describe("FeedbackService access boundary", () => {
  it("skips feedback writes when the workspace access profile denies writes", async () => {
    workspaces.set("ws-1", {
      id: "ws-1",
      path: tmpDir,
      permissions: { read: true, write: false, delete: false, network: false, shell: false },
    });
    const daemon = new EventEmitter();
    const service = new FeedbackService({} as never);
    await service.start(daemon as unknown as AgentDaemon);
    daemon.emit("user_feedback", { taskId: "task-a", decision: "rejected", reason: "Too vague" });
    await vi.waitFor(() => {
      expect((service as unknown as { stateByWorkspace: Map<string, unknown> }).stateByWorkspace.size).toBe(1);
    });

    await service.stop();

    expect(fs.existsSync(path.join(tmpDir, ".cowork", "feedback"))).toBe(false);
    // The kit write (mocked here) receives a guard that refuses the write.
    const guard = writeKitFileWithSnapshot.mock.calls.at(-1)?.[4] as
      | ((absPath: string, operation: "read" | "write") => void)
      | undefined;
    expect(() => guard!(path.join(tmpDir, ".cowork", "MISTAKES.md"), "write")).toThrow(
      /Access denied/,
    );
  });
});

describe("CrossSignalService", () => {
  it("stop() flushes debounced signals and detaches from the daemon", async () => {
    fs.writeFileSync(path.join(tmpDir, ".cowork", "CROSS_SIGNALS.md"), "# Cross signals\n", "utf8");
    const daemon = new EventEmitter();
    const service = new CrossSignalService({} as never);
    await service.start(daemon as unknown as AgentDaemon);
    expect(daemon.listenerCount("assistant_message")).toBe(1);

    daemon.emit("assistant_message", { taskId: "task-a", message: "pricing on acme.com looks stale" });
    daemon.emit("assistant_message", { taskId: "task-b", message: "support at acme.com replied" });
    await vi.waitFor(() => {
      const state = (service as unknown as {
        stateByWorkspace: Map<string, { mentions: Map<string, { roles: Set<string> }> }>;
      }).stateByWorkspace.get("ws-1");
      expect(state?.mentions.get("acme.com")?.roles.size).toBe(2);
    });

    await service.stop();

    expect(daemon.listenerCount("assistant_message")).toBe(0);
    expect(writeKitFileWithSnapshot).toHaveBeenCalledWith(
      path.join(tmpDir, ".cowork", "CROSS_SIGNALS.md"),
      expect.stringContaining("acme.com"),
      "agent",
      "service:cross_signals_flush",
      expect.any(Function),
    );
    expectGuardDeniesProtectedPaths();
  });
});
