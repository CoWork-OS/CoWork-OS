import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import { createMemoryRepoIpcHandlers } from "../memory-repo-handlers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: { ready?: boolean; root?: string | null } = {}) {
  let root = options.root;
  if (root === undefined) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-ipc-"));
    dirs.push(root);
  }
  const service =
    root === null
      ? null
      : {
          root,
          isReady: vi.fn(() => options.ready !== false),
          compactHistory: vi.fn(async () => ({ compacted: true })),
        };
  const status = vi.fn(async () => ({
    enabled: true,
    root: root ?? "/nowhere",
    ready: true,
    writable: true,
    gitAvailable: true,
  }));
  const readLines = vi.fn(async (refs: string[]) =>
    refs.map((ref) => ({ ref, text: "x", path: "me.md", by: "user" as const })),
  );
  const openPath = vi.fn(async () => "");
  const checkRateLimit = vi.fn();
  const handlers = createMemoryRepoIpcHandlers({
    status,
    getService: () => service,
    readLines,
    openPath,
    checkRateLimit,
  });
  return { handlers, service, status, readLines, openPath, checkRateLimit };
}

describe("memory folder IPC", () => {
  it("registers one handler per memoryRepo channel", () => {
    const { handlers } = setup();
    const channels = Object.values(IPC_CHANNELS).filter((channel) =>
      channel.startsWith("memoryRepo:"),
    );
    expect(Object.keys(handlers).sort()).toEqual([...channels].sort());
    expect(channels).toHaveLength(4);
  });

  it("returns the status and rate-limits every channel", async () => {
    const { handlers, status, checkRateLimit } = setup();
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_STATUS](undefined)).resolves.toMatchObject({
      ready: true,
    });
    expect(status).toHaveBeenCalledTimes(1);
    await handlers[IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY](undefined);
    await handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined);
    await handlers[IPC_CHANNELS.MEMORY_REPO_READ_LINES]({ refs: ["repo:me.md#L3"] });
    for (const channel of Object.keys(handlers)) {
      expect(checkRateLimit).toHaveBeenCalledWith(channel);
    }
  });

  it("opens the folder main resolved, never a path from the renderer", async () => {
    const { handlers, openPath, service } = setup();
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined)).resolves.toEqual({
      success: true,
    });
    expect(openPath).toHaveBeenCalledWith(service!.root);
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER]({ path: "/etc" })).rejects.toThrow(
      /Invalid/,
    );
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a folder that is off, not ready, missing or a symlink", async () => {
    await expect(
      setup({ root: null }).handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined),
    ).rejects.toThrow(/not ready/);
    await expect(
      setup({ ready: false }).handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined),
    ).rejects.toThrow(/not ready/);
    const missing = setup({ root: path.join(os.tmpdir(), "memory-repo-ipc-missing-xyz") });
    await expect(missing.handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined)).rejects.toThrow(
      /not available/,
    );
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-ipc-link-"));
    dirs.push(base);
    fs.mkdirSync(path.join(base, "real"));
    fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
    const linked = setup({ root: path.join(base, "link") });
    await expect(linked.handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined)).rejects.toThrow(
      /not available/,
    );
    expect(linked.openPath).not.toHaveBeenCalled();
  });

  it("surfaces an openPath failure", async () => {
    const { handlers, openPath } = setup();
    openPath.mockResolvedValueOnce("No application knows how to open it");
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER](undefined)).rejects.toThrow(
      "No application knows how to open it",
    );
  });

  it("compacts through the running service, and reports when the folder is off", async () => {
    const { handlers, service } = setup();
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY](undefined)).resolves.toEqual({
      compacted: true,
    });
    expect(service!.compactHistory).toHaveBeenCalledTimes(1);
    await expect(
      setup({ root: null }).handlers[IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY](undefined),
    ).resolves.toEqual({ compacted: false, error: "The memory folder is off." });
  });

  it("reads lines only for valid refs, at most 50", async () => {
    const { handlers, readLines } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_REPO_READ_LINES]({
        refs: ["repo:workspaces/cowork.md#L7", "repo:MEMORY.md#L2"],
      }),
    ).resolves.toHaveLength(2);
    const bad: unknown[] = [
      undefined,
      null,
      [],
      { refs: [] },
      { refs: "repo:me.md#L1" },
      { refs: ["repo:../secrets.md#L1"] },
      { refs: ["repo:/etc/passwd.md#L1"] },
      { refs: ["repo:.git/config#L1"] },
      { refs: ["repo:notes.txt#L1"] },
      { refs: ["repo:me.md#L0"] },
      { refs: ["mem:abc"] },
      { refs: [42] },
      { refs: ["repo:me.md#L1"], extra: true },
      { refs: Array.from({ length: 51 }, (_, i) => `repo:me.md#L${i + 1}`) },
    ];
    for (const payload of bad) {
      await expect(handlers[IPC_CHANNELS.MEMORY_REPO_READ_LINES](payload)).rejects.toThrow(
        /Invalid/,
      );
    }
    expect(readLines).toHaveBeenCalledTimes(1);
  });
});
