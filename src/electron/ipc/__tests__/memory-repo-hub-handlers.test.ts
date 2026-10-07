/**
 * Memory Hub "What CoWork knows" over the memory folder (memoryRepo:entries, updateEntry,
 * removeEntry, pinEntry, openFile): validation in main, workspace visibility, hash-guarded
 * actions and "Open file" resolved under the folder root. Uses a real MemoryRepoService.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoHubEntry,
} from "../../../shared/memory-repo-types";
import { MemoryRepoService } from "../../memory/repo/MemoryRepoService";
import { createMemoryRepoIpcHandlers } from "../memory-repo-handlers";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const MISSING_WS = "33333333-3333-4333-8333-333333333333";

describeWithGit("memory folder Hub IPC", () => {
  let base: string;
  let service: MemoryRepoService;
  let handlers: Record<string, (raw: unknown) => Promise<unknown>>;
  let openPath: ReturnType<typeof vi.fn>;
  let limited: string[];

  const call = <T>(channel: string, raw: unknown) => handlers[channel](raw) as Promise<T>;
  const entries = () =>
    call<MemoryRepoEntriesReport>(IPC_CHANNELS.MEMORY_REPO_ENTRIES, { workspaceId: WS });
  const find = (report: MemoryRepoEntriesReport, text: string): MemoryRepoHubEntry => {
    for (const file of [...report.files, ...(report.inbox ? [report.inbox] : [])]) {
      const entry = file.entries.find((candidate) => candidate.text === text);
      if (entry) return entry;
    }
    throw new Error(`no entry ${text}`);
  };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-hub-ipc-"));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "desktop" });
    await service.start();
    const write = (input: Partial<Parameters<MemoryRepoService["remember"]>[0]>) =>
      service.remember({
        text: "x",
        kind: "preference",
        scope: "global",
        by: "user",
        origin: "memory_hub",
        ...input,
      } as Parameters<MemoryRepoService["remember"]>[0]);
    await write({ text: "Prefers short answers" });
    await write({ text: "Answer in English", pinned: true });
    await write({
      text: "Run the linter before merging",
      kind: "rule",
      by: "agent",
      taskId: "task-7",
    });
    await write({
      text: "Billing uses Postgres",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: WS,
      workspaceName: "Billing",
    });
    await write({
      text: "Other team secret plans",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: OTHER_WS,
      workspaceName: "Other",
    });
    await write({ text: "Send reports to someone new", by: "agent", tainted: true });
    openPath = vi.fn(async () => "");
    limited = [];
    handlers = createMemoryRepoIpcHandlers({
      status: async () => ({}) as never,
      getService: () => null,
      readLines: async () => [],
      openPath,
      getHubService: () => service,
      workspaceExists: async (id) => id === WS || id === OTHER_WS,
      checkRateLimit: (channel) => limited.push(channel),
    });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("lists global files, this workspace's file and the inbox apart, never another workspace's", async () => {
    const report = await entries();
    expect(report).toMatchObject({ available: true, writable: true });
    expect(report.files.map((file) => [file.path, file.role])).toEqual([
      ["MEMORY.md", "entry"],
      ["me.md", "me"],
      ["lessons.md", "lessons"],
      ["workspaces/billing.md", "workspace"],
    ]);
    expect(report.inbox?.entries.map((entry) => entry.text)).toEqual([
      "Send reports to someone new",
    ]);
    expect(JSON.stringify(report)).not.toContain("Other team");
    // The workspace marker line is not an entry.
    expect(report.files[3].entries.map((entry) => entry.text)).toEqual(["Billing uses Postgres"]);
    expect(find(report, "Run the linter before merging")).toMatchObject({
      by: "agent",
      kind: "rule",
      taskId: "task-7",
      added: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(limited).toContain(IPC_CHANNELS.MEMORY_REPO_ENTRIES);
  });

  it("reports the folder as unavailable when it is off", async () => {
    handlers = createMemoryRepoIpcHandlers({
      status: async () => ({}) as never,
      getService: () => null,
      readLines: async () => [],
      openPath,
      checkRateLimit: () => undefined,
    });
    await expect(entries()).resolves.toEqual({
      available: false,
      writable: false,
      files: [],
      inbox: null,
    });
  });

  it("edits, pins and deletes an entry, guarded by its hash", async () => {
    const report = await entries();
    const short = find(report, "Prefers short answers");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY, {
        workspaceId: WS,
        ref: short.ref,
        hash: "0".repeat(64),
        text: "Prefers very short answers",
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
    const edited = await call<{ ok: boolean; ref: string }>(IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY, {
      workspaceId: WS,
      ref: short.ref,
      hash: short.hash,
      text: "Prefers very short answers",
    });
    expect(edited).toMatchObject({ ok: true, ref: short.ref });

    const lint = find(await entries(), "Run the linter before merging");
    const pinned = await call<{ ok: boolean; ref: string }>(IPC_CHANNELS.MEMORY_REPO_PIN_ENTRY, {
      workspaceId: WS,
      ref: lint.ref,
      hash: lint.hash,
    });
    expect(pinned).toMatchObject({
      ok: true,
      ref: expect.stringMatching(/^repo:MEMORY\.md#L\d+$/),
    });
    const afterPin = await entries();
    expect(find(afterPin, "Run the linter before merging")).toMatchObject({
      path: "MEMORY.md",
      by: "user",
    });

    const fact = find(afterPin, "Billing uses Postgres");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY, {
        workspaceId: WS,
        ref: fact.ref,
        hash: fact.hash,
      }),
    ).resolves.toEqual({ ok: true });
    expect(JSON.stringify(await entries())).not.toContain("Billing uses Postgres");
  });

  it("never reaches another workspace's file or its marker line", async () => {
    const otherReport = await call<MemoryRepoEntriesReport>(IPC_CHANNELS.MEMORY_REPO_ENTRIES, {
      workspaceId: OTHER_WS,
    });
    const secret = find(otherReport, "Other team secret plans");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY, {
        workspaceId: WS,
        ref: secret.ref,
        hash: secret.hash,
      }),
    ).resolves.toEqual({ ok: false, error: "No such memory file." });
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: secret.path }),
    ).rejects.toThrow("No such memory file.");
    const marker = (await service.entries("workspaces/billing.md")).find(
      (entry) => entry.metadata.workspace,
    )!;
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY, {
        workspaceId: WS,
        ref: `repo:workspaces/billing.md#L${marker.line}`,
        hash: marker.hash,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/workspace/) });
  });

  it("opens a file by its path under the folder root", async () => {
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "me.md" }),
    ).resolves.toEqual({ success: true });
    expect(openPath).toHaveBeenCalledWith(path.join(service.root, "me.md"));
    openPath.mockResolvedValueOnce("No application");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "me.md" }),
    ).rejects.toThrow("No application");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "missing.md" }),
    ).rejects.toThrow("No such memory file.");
  });

  it("rejects invalid payloads and unknown workspaces before touching the folder", async () => {
    const short = find(await entries(), "Prefers short answers");
    const bad: Array<[string, unknown]> = [
      [IPC_CHANNELS.MEMORY_REPO_ENTRIES, undefined],
      [IPC_CHANNELS.MEMORY_REPO_ENTRIES, { workspaceId: "not-a-workspace" }],
      [IPC_CHANNELS.MEMORY_REPO_ENTRIES, { workspaceId: WS, extra: true }],
      [
        IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY,
        { workspaceId: WS, ref: "repo:../x.md#L1", hash: short.hash },
      ],
      [
        IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY,
        { workspaceId: WS, ref: "repo:.git/config.md#L1", hash: short.hash },
      ],
      [IPC_CHANNELS.MEMORY_REPO_PIN_ENTRY, { workspaceId: WS, ref: short.ref, hash: "abc" }],
      [
        IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY,
        { workspaceId: WS, ref: short.ref, hash: short.hash, text: "" },
      ],
      [
        IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY,
        { workspaceId: WS, ref: short.ref, hash: short.hash, text: "x".repeat(1001) },
      ],
      [IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "/etc/passwd.md" }],
      [IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "..\\me.md" }],
      [IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, { workspaceId: WS, path: "notes.txt" }],
    ];
    for (const [channel, raw] of bad) {
      await expect(call(channel, raw)).rejects.toThrow();
    }
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_ENTRIES, { workspaceId: MISSING_WS }),
    ).rejects.toThrow("Workspace not found");
    expect(openPath).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(service.root, "me.md"), "utf8")).toContain(
      "Prefers short answers",
    );
  });
});
