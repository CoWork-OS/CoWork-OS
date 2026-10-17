import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_PROCESS_IDLE_TIMEOUT_MS,
  BackgroundProcessManager,
  normalizeProcessTitle,
  type BackgroundProcessChange,
  type BackgroundProcessLaunch,
} from "../background-processes";

// Background processes as terminal panel tabs: titles, change events, peeking, removal.

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
  const launch: BackgroundProcessLaunch = {
    child,
    sandboxType: "none",
    reachableFromHost: true,
    signalTree: (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    },
  };
  return { child, launch, signals };
}

function startFake(manager: BackgroundProcessManager, taskId = "task-a") {
  const fake = fakeLaunch();
  const summary = manager.start({
    taskId,
    command: "npm run dev",
    cwd: "/w",
    launch: fake.launch,
    normalizeChunk: (chunk) => chunk,
    redact: (text) => text.replace(/hunter2/g, "[REDACTED]"),
  });
  return { ...fake, summary };
}

describe("BackgroundProcessManager terminal tabs", () => {
  it("names each process's terminal tab from its title or command", () => {
    expect(normalizeProcessTitle("  https\ttunnel ", "cloudflared tunnel")).toBe("https tunnel");
    expect(normalizeProcessTitle("[dev] server", "x")).toBe("dev server");
    expect(normalizeProcessTitle(undefined, "npm run dev\necho done")).toBe("npm run dev");
    expect(normalizeProcessTitle(42, "")).toBe("process");
    const long = normalizeProcessTitle("a".repeat(60), "x");
    expect(long).toHaveLength(40);
    expect(long.endsWith("…")).toBe(true);

    const manager = new BackgroundProcessManager();
    const { summary } = startFake(manager);
    expect(summary.title).toBe("npm run dev");
  });

  it("tells subscribers about starts, redacted output, exits and removals", async () => {
    const manager = new BackgroundProcessManager(() => 1_000);
    const changes: BackgroundProcessChange[] = [];
    const unsubscribe = manager.subscribe((change) => changes.push(change));
    const { child, summary } = startFake(manager);
    child.stdout!.emit("data", Buffer.from("password hunter2\n"));
    child.emit("exit", 0, null);
    await manager.remove("task-a", summary.process_id, "tab_closed_by_user");

    expect(changes.map((change) => change.kind)).toEqual(["status", "output", "status", "removed"]);
    expect(changes[0]).toMatchObject({
      kind: "status",
      taskId: "task-a",
      process: { process_id: summary.process_id, title: "npm run dev", running: true },
    });
    expect(changes[1]).toEqual({
      kind: "output",
      taskId: "task-a",
      processId: summary.process_id,
      output: "password [REDACTED]\n",
    });
    expect(changes[2]).toMatchObject({ process: { status: "exited", exit_code: 0 } });
    expect(manager.list("task-a")).toEqual([]);

    unsubscribe();
    startFake(manager);
    expect(changes).toHaveLength(4);
    await manager.stopAll("test");
  });

  it("lets the terminal panel peek without moving the agent's cursor or idle clock", async () => {
    let now = 0;
    const manager = new BackgroundProcessManager(() => now);
    const { child, summary } = startFake(manager);
    child.stdout!.emit("data", Buffer.from("ready hunter2\n"));
    now += BACKGROUND_PROCESS_IDLE_TIMEOUT_MS + 1;

    expect(manager.peek("task-a", summary.process_id)).toEqual({
      output: "ready [REDACTED]\n",
      truncated: false,
    });
    expect(manager.read("task-a", summary.process_id).output).toBe("ready [REDACTED]\n");
    expect(() => manager.peek("task-b", summary.process_id)).toThrow(/No background process/);

    now += BACKGROUND_PROCESS_IDLE_TIMEOUT_MS + 1;
    manager.peek("task-a", summary.process_id);
    manager.sweep();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.summary("task-a", summary.process_id)).toMatchObject({
      status: "stopped",
      stop_reason: "idle_timeout",
    });
  });

  it("stops a running process before forgetting it when its tab is closed", async () => {
    const manager = new BackgroundProcessManager();
    const onExit = vi.fn();
    const fake = fakeLaunch();
    const summary = manager.start({
      taskId: "task-a",
      command: "vite",
      cwd: "/w",
      launch: fake.launch,
      normalizeChunk: (chunk) => chunk,
      redact: (text) => text,
      onExit,
    });

    await manager.remove("task-a", summary.process_id, "tab_closed_by_user");
    expect(fake.signals[0]).toBe("SIGTERM");
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "stopped", stop_reason: "tab_closed_by_user" }),
    );
    expect(manager.list("task-a")).toEqual([]);
  });
});
