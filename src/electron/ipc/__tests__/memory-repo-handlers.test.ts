import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import { MEMORY_REPO_DREAM_DIFF_MAX } from "../../../shared/memory-repo-types";
import type { MemoryRepoDreamRecord } from "../../memory/repo/MemoryRepoService";
import { ipcMain } from "electron";
import { rateLimiter } from "../../utils/rate-limiter";
import { createMemoryRepoIpcHandlers, setupMemoryRepoHandlers } from "../memory-repo-handlers";

const NOW = Date.now();

function dreamRecord(overrides: Partial<MemoryRepoDreamRecord> = {}): MemoryRepoDreamRecord {
  return {
    id: "20261005-abcd1234",
    trigger: "daily",
    status: "completed",
    startedAt: NOW - 60_000,
    finishedAt: NOW - 50_000,
    summary: "Merged two duplicates.",
    tokens: 1200,
    autoCommit: "0123456789abcdef0123456789abcdef01234567",
    autoCount: 2,
    reviewBranch: "dream/20261005-abcd1234",
    reviewBase: "fedcba9876543210fedcba9876543210fedcba98",
    reviewCount: 1,
    reviewStatus: "pending",
    rejected: 0,
    skipped: 0,
    operations: [
      { decision: "auto", description: "remove me.md L3", reason: "duplicate" },
      {
        decision: "review",
        description: "update MEMORY.md L2",
        reason: "stale",
        why: "in MEMORY.md",
      },
    ],
    taskIds: ["t1"],
    lastTaskCreatedAt: NOW - 100_000,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: { ready?: boolean; root?: string | null; noDreamer?: boolean } = {}) {
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
          listDreams: vi.fn(async (_limit?: number) => [
            dreamRecord(),
            dreamRecord({
              id: "old",
              startedAt: NOW - 3 * 86_400_000,
              finishedAt: NOW - 3 * 86_400_000,
              tokens: 9000,
              reviewStatus: "accepted",
            }),
          ]),
          dreamDiff: vi.fn(async (_id: string, _part: "review" | "auto") => "+added\n-removed\n"),
          acceptDream: vi.fn(async (_id: string) => ({ accepted: true })),
          rejectDream: vi.fn(async (_id: string) => ({
            rejected: false,
            error: "Nothing waiting",
          })),
          undoDream: vi.fn(async (_id: string) => ({ undone: true })),
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
  const run = vi.fn(async (_trigger: "daily" | "manual") => ({
    ran: true as const,
    record: dreamRecord({ id: "fresh" }),
  }));
  const handlers = createMemoryRepoIpcHandlers({
    status,
    getService: () => service as never,
    readLines,
    openPath,
    checkRateLimit,
    getDreamer: () => (options.noDreamer ? null : { run }),
    dreamSettings: () => ({ enabled: true, dailyTokenBudget: 50_000 }),
  });
  return { handlers, service, status, readLines, openPath, checkRateLimit, run };
}

describe("memory folder IPC", () => {
  it("registers one handler per memoryRepo channel", () => {
    const { handlers } = setup();
    const channels = Object.values(IPC_CHANNELS).filter((channel) =>
      channel.startsWith("memoryRepo:"),
    );
    expect(Object.keys(handlers).sort()).toEqual([...channels].sort());
    expect(channels).toHaveLength(18);
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
    await handlers[IPC_CHANNELS.MEMORY_REPO_DREAMS](undefined);
    await handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF]({ id: "abc", part: "review" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM]({ id: "abc" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM]({ id: "abc" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM]({ id: "abc" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_NOW](undefined);
    await handlers[IPC_CHANNELS.MEMORY_REPO_SYNC_NOW](undefined);
    // The Memory Hub entry channels (no folder service here: nothing to act on).
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const ref = { workspaceId, ref: "repo:me.md#L3", hash: "a".repeat(64) };
    await handlers[IPC_CHANNELS.MEMORY_REPO_ENTRIES]({ workspaceId });
    await handlers[IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY]({ ...ref, text: "Prefers tea" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY](ref);
    await handlers[IPC_CHANNELS.MEMORY_REPO_PIN_ENTRY](ref);
    await handlers[IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY]({ ...ref, target: "me" });
    await handlers[IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER](undefined);
    await expect(
      handlers[IPC_CHANNELS.MEMORY_REPO_OPEN_FILE]({ workspaceId, path: "me.md" }),
    ).rejects.toThrow(/not available/);
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

describe("memory folder dream IPC", () => {
  it("lists dreams without branch names or full shas", async () => {
    const { handlers } = setup();
    const report = (await handlers[IPC_CHANNELS.MEMORY_REPO_DREAMS](undefined)) as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({
      folderReady: true,
      dreamingEnabled: true,
      dailyBudget: 50_000,
      pendingReviews: 1,
      tokensUsedToday: 1200,
    });
    const [first] = report.dreams as Array<Record<string, unknown>>;
    expect(first).toMatchObject({
      id: "20261005-abcd1234",
      autoCount: 2,
      canUndo: true,
      undone: false,
      reviewStatus: "pending",
      autoCommitShort: "01234567",
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("dream/");
    expect(text).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(text).not.toContain("fedcba98");
  });

  it("reports an empty list while the folder is off", async () => {
    const { handlers } = setup({ root: null });
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAMS](undefined)).resolves.toMatchObject({
      folderReady: false,
      dreams: [],
      pendingReviews: 0,
    });
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM]({ id: "abc" })).resolves.toEqual({
      ok: false,
      error: "The memory folder is off.",
    });
  });

  it("validates dream ids and the diff part", async () => {
    const { handlers, service } = setup();
    const badIds: unknown[] = [
      undefined,
      null,
      "abc",
      {},
      { id: "" },
      { id: "../x" },
      { id: "a/b" },
      { id: "x".repeat(65) },
      { id: 42 },
      { id: "abc", extra: 1 },
    ];
    for (const channel of [
      IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM,
      IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM,
      IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM,
    ]) {
      for (const payload of badIds) {
        await expect(handlers[channel](payload)).rejects.toThrow(/Invalid/);
      }
    }
    for (const payload of [
      { id: "abc" },
      { id: "abc", part: "branch" },
      { id: "../x", part: "review" },
      { id: "abc", part: "auto", extra: true },
    ]) {
      await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF](payload)).rejects.toThrow(
        /Invalid/,
      );
    }
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAMS]({ limit: 5 })).rejects.toThrow(
      /Invalid/,
    );
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_NOW]({ force: true })).rejects.toThrow(
      /Invalid/,
    );
    expect(service!.acceptDream).not.toHaveBeenCalled();
    expect(service!.dreamDiff).not.toHaveBeenCalled();
  });

  it("maps accept, reject and undo to ok or an error", async () => {
    const { handlers, service } = setup();
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM]({ id: "d-1" })).resolves.toEqual({
      ok: true,
    });
    expect(service!.acceptDream).toHaveBeenCalledWith("d-1");
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM]({ id: "d-1" })).resolves.toEqual({
      ok: false,
      error: "Nothing waiting",
    });
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM]({ id: "d_2" })).resolves.toEqual({
      ok: true,
    });
    expect(service!.undoDream).toHaveBeenCalledWith("d_2");
  });

  it("returns the diff, capped", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF]({ id: "d-1", part: "auto" }),
    ).resolves.toBe("+added\n-removed\n");
    expect(service!.dreamDiff).toHaveBeenCalledWith("d-1", "auto");
    service!.dreamDiff.mockResolvedValueOnce("+".repeat(MEMORY_REPO_DREAM_DIFF_MAX + 500));
    const capped = (await handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF]({
      id: "d-1",
      part: "review",
    })) as string;
    expect(capped.length).toBeLessThan(MEMORY_REPO_DREAM_DIFF_MAX + 100);
    expect(capped).toContain("diff truncated");
  });

  it("dreams now through the dreamer and maps the outcome", async () => {
    const { handlers, run } = setup();
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_NOW](undefined)).resolves.toMatchObject({
      ran: true,
      dream: { id: "fresh", autoCount: 2 },
    });
    expect(run).toHaveBeenCalledWith("manual");
    run.mockResolvedValueOnce({ ran: false, reason: "budget" } as never);
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_NOW](undefined)).resolves.toEqual({
      ran: false,
      reason: "budget",
    });
    await expect(
      setup({ noDreamer: true }).handlers[IPC_CHANNELS.MEMORY_REPO_DREAM_NOW](undefined),
    ).resolves.toEqual({ ran: false, reason: "unavailable" });
  });
});

describe("memory folder sync IPC", () => {
  const syncState = {
    remoteUrl: "https://github.com/sam/memory.git",
    lastPullAt: NOW - 1000,
    lastPushAt: NOW - 500,
    ahead: 0,
    behind: 0,
    conflict: null,
    lastError: null,
  };
  const build = (
    syncService: { isSyncConfigured: () => boolean; syncNow: () => Promise<unknown> } | null,
    checkRateLimit: (channel: string) => void = vi.fn(),
  ) =>
    createMemoryRepoIpcHandlers({
      status: vi.fn(),
      getService: () => null,
      readLines: vi.fn(),
      openPath: vi.fn(),
      checkRateLimit,
      getSyncService: () => syncService as never,
    });

  it("pulls and pushes through the running service and returns its sync state", async () => {
    const syncNow = vi.fn(async () => syncState);
    const checkRateLimit = vi.fn();
    const handlers = build({ isSyncConfigured: () => true, syncNow }, checkRateLimit);
    await expect(handlers[IPC_CHANNELS.MEMORY_REPO_SYNC_NOW](undefined)).resolves.toEqual(
      syncState,
    );
    expect(syncNow).toHaveBeenCalledWith({ push: true });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_REPO_SYNC_NOW);
  });

  it("returns an error when the folder or sync is off", async () => {
    await expect(build(null)[IPC_CHANNELS.MEMORY_REPO_SYNC_NOW](undefined)).resolves.toEqual({
      error: "The memory folder is off.",
    });
    const syncNow = vi.fn();
    await expect(
      build({ isSyncConfigured: () => false, syncNow })[IPC_CHANNELS.MEMORY_REPO_SYNC_NOW](
        undefined,
      ),
    ).resolves.toEqual({ error: expect.stringContaining("Sync is off") });
    expect(syncNow).not.toHaveBeenCalled();
  });

  it("takes no payload", async () => {
    const syncNow = vi.fn(async () => syncState);
    const handlers = build({ isSyncConfigured: () => true, syncNow });
    for (const payload of [{ push: false }, "now", { url: "https://evil.example/x.git" }]) {
      await expect(handlers[IPC_CHANNELS.MEMORY_REPO_SYNC_NOW](payload)).rejects.toThrow(/Invalid/);
    }
    expect(syncNow).not.toHaveBeenCalled();
  });

  it("allows six syncs a minute", async () => {
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    rateLimiter.reset(IPC_CHANNELS.MEMORY_REPO_SYNC_NOW);
    const syncNow = vi.fn(async () => syncState);
    setupMemoryRepoHandlers({
      status: vi.fn(),
      getService: () => null,
      readLines: vi.fn(),
      openPath: vi.fn(),
      getSyncService: () => ({ isSyncConfigured: () => true, syncNow }) as never,
    });
    const registered = handle.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.MEMORY_REPO_SYNC_NOW,
    )?.[1] as ((event: unknown, raw: unknown) => Promise<unknown>) | undefined;
    expect(registered).toBeDefined();
    for (let i = 0; i < 6; i++) await registered!({}, undefined);
    await expect(registered!({}, undefined)).rejects.toThrow(/Rate limit/);
    expect(syncNow).toHaveBeenCalledTimes(6);
    rateLimiter.reset(IPC_CHANNELS.MEMORY_REPO_SYNC_NOW);
  });
});
