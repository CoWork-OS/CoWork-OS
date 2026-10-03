import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_PROCESS_IDLE_TIMEOUT_MS,
  BackgroundProcessManager,
  MAX_BACKGROUND_PROCESSES_PER_TASK,
  type BackgroundProcessLaunch,
} from "../background-processes";

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
  });
  return child;
}

function fakeLaunch(child = fakeChild()) {
  const signals: NodeJS.Signals[] = [];
  const release = vi.fn();
  const launch: BackgroundProcessLaunch = {
    child,
    sandboxType: "none",
    reachableFromHost: true,
    signalTree: (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    },
    release,
  };
  return { child, launch, signals, release };
}

function startFake(manager: BackgroundProcessManager, taskId = "task-a", child = fakeChild()) {
  const fake = fakeLaunch(child);
  const summary = manager.start({
    taskId,
    command: "npm run dev",
    cwd: "/w",
    launch: fake.launch,
    normalizeChunk: (chunk) => chunk.replace(/\x1b\[[0-9;]*m/g, ""),
    redact: (text) => text.replace(/hunter2/g, "[REDACTED]"),
  });
  return { ...fake, summary };
}

describe("BackgroundProcessManager", () => {
  it("pages output with offsets, rereads from 0 and tails lines", () => {
    const manager = new BackgroundProcessManager();
    const { child, summary } = startFake(manager);
    child.stdout!.emit("data", Buffer.from("\x1b[32mone\x1b[0m\ntwo\n"));

    const first = manager.read("task-a", summary.process_id);
    expect(first.output).toBe("one\ntwo\n");
    child.stderr!.emit("data", Buffer.from("three\n"));
    const second = manager.read("task-a", summary.process_id);
    expect(second.output).toBe("three\n");
    expect(second.next_offset).toBeGreaterThan(first.next_offset);
    expect(manager.read("task-a", summary.process_id).output).toBe("");
    expect(manager.read("task-a", summary.process_id, { sinceOffset: 0 }).output).toBe(
      "one\ntwo\nthree\n",
    );
    expect(
      manager.read("task-a", summary.process_id, { sinceOffset: 0, tailLines: 2 }).output,
    ).toBe("two\nthree\n");
  });

  it("redacts output when it is read", () => {
    const manager = new BackgroundProcessManager();
    const { child, summary } = startFake(manager);
    child.stdout!.emit("data", Buffer.from("password=hunt"));
    child.stdout!.emit("data", Buffer.from("er2\n"));
    expect(manager.read("task-a", summary.process_id).output).toBe("password=[REDACTED]\n");
  });

  it("keeps a bounded tail and reports what was dropped", () => {
    const manager = new BackgroundProcessManager();
    const { child, summary } = startFake(manager);
    child.stdout!.emit("data", Buffer.from("x".repeat(600 * 1024)));
    const result = manager.read("task-a", summary.process_id, { sinceOffset: 0 });
    expect(result.dropped_chars).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(20_000);
    expect(result.next_offset).toBe(600 * 1024);
  });

  it("detects ready lines and local URLs", async () => {
    const manager = new BackgroundProcessManager();
    const { child, summary } = startFake(manager);
    setTimeout(() => child.stdout!.emit("data", "  ➜  Local:   http://localhost:5173/\n"), 20);
    const started = Date.now();
    await manager.waitForStartup("task-a", summary.process_id, 5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(manager.summary("task-a", summary.process_id).urls).toEqual(["http://localhost:5173/"]);
  });

  it("hides other tasks' processes", async () => {
    const manager = new BackgroundProcessManager();
    const { summary } = startFake(manager, "task-a");
    expect(() => manager.read("task-b", summary.process_id)).toThrow(/No background process/);
    await expect(manager.stop("task-b", summary.process_id)).rejects.toThrow();
    expect(manager.summary("task-a", summary.process_id).running).toBe(true);
    expect(manager.list("task-b")).toEqual([]);
  });

  it("caps running processes per task", () => {
    const manager = new BackgroundProcessManager();
    for (let i = 0; i < MAX_BACKGROUND_PROCESSES_PER_TASK; i += 1) {
      startFake(manager, "task-a", fakeChild(1000 + i));
    }
    expect(() => manager.assertCanStart("task-a")).toThrow(/maximum/);
    expect(() => manager.assertCanStart("task-b")).not.toThrow();
  });

  it("stops with SIGTERM, escalates only if needed, and releases once", async () => {
    const manager = new BackgroundProcessManager();
    const { summary, signals, release } = startFake(manager);
    const stopped = await manager.stop("task-a", summary.process_id);
    expect(stopped).toMatchObject({
      status: "stopped",
      running: false,
      stop_reason: "stop_process",
    });
    // SIGTERM, then the leftover-group SIGKILL after the leader exits.
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("kills what is left of the group when the leader exits on its own", () => {
    const manager = new BackgroundProcessManager();
    const onExit = vi.fn();
    const fake = fakeLaunch();
    manager.start({
      taskId: "task-a",
      command: "sh -c 'sleep 30 & exit 3'",
      cwd: "/w",
      launch: fake.launch,
      normalizeChunk: (chunk) => chunk,
      redact: (text) => text,
      onExit,
    });
    fake.child.emit("exit", 3, null);
    expect(fake.signals).toEqual(["SIGKILL"]);
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "exited", exit_code: 3 }),
    );
  });

  it("stops processes nobody polled for the idle timeout", async () => {
    let now = 1_000;
    const manager = new BackgroundProcessManager(() => now);
    const idle = startFake(manager, "task-a", fakeChild(1));
    const polled = startFake(manager, "task-a", fakeChild(2));
    now += BACKGROUND_PROCESS_IDLE_TIMEOUT_MS - 1_000;
    manager.read("task-a", polled.summary.process_id);
    now += 2_000;
    manager.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.summary("task-a", idle.summary.process_id)).toMatchObject({
      status: "stopped",
      stop_reason: "idle_timeout",
    });
    expect(manager.summary("task-a", polled.summary.process_id).status).toBe("running");
    await manager.stopAll("test");
  });

  it("stops and forgets every process of a task without reporting exits", async () => {
    const manager = new BackgroundProcessManager();
    const onExit = vi.fn();
    const fake = fakeLaunch();
    manager.start({
      taskId: "task-a",
      command: "vite",
      cwd: "/w",
      launch: fake.launch,
      normalizeChunk: (chunk) => chunk,
      redact: (text) => text,
      onExit,
    });
    const other = startFake(manager, "task-b");

    expect(await manager.stopAllForTask("task-a", "task_cancelled")).toBe(1);
    expect(manager.list("task-a")).toEqual([]);
    expect(onExit).not.toHaveBeenCalled();
    expect(manager.summary("task-b", other.summary.process_id).running).toBe(true);

    manager.killAllSync();
    expect(other.signals).toEqual(["SIGKILL"]);
  });
});
