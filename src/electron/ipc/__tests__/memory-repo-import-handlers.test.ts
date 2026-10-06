/**
 * memoryRepo:importFolder and memoryRepo:keepEntry (docs/memory-repo-phase5-design.md §3):
 * the folder comes from the picker in main (no payload is accepted), the result summary, and
 * Keep's validation, inbox-only rule and targets. Uses a real MemoryRepoService.
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
  MemoryRepoEntryActionResult,
  MemoryRepoHubEntry,
  MemoryRepoImportResult,
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

describeWithGit("memory folder import and Keep IPC", () => {
  let base: string;
  let source: string;
  let service: MemoryRepoService;
  let handlers: Record<string, (raw: unknown) => Promise<unknown>>;
  let pickFolder: ReturnType<typeof vi.fn>;
  let limited: string[];

  const call = <T>(channel: string, raw?: unknown) => handlers[channel](raw) as Promise<T>;
  const entries = () =>
    call<MemoryRepoEntriesReport>(IPC_CHANNELS.MEMORY_REPO_ENTRIES, { workspaceId: WS });
  const inboxEntry = async (text: string): Promise<MemoryRepoHubEntry> => {
    const entry = (await entries()).inbox?.entries.find((candidate) => candidate.text === text);
    if (!entry) throw new Error(`no inbox entry ${text}`);
    return entry;
  };
  const keep = (entry: MemoryRepoHubEntry, target: string) =>
    call<MemoryRepoEntryActionResult>(IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY, {
      workspaceId: WS,
      ref: entry.ref,
      hash: entry.hash,
      target,
    });

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-import-ipc-")));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "desktop" });
    await service.start();
    source = path.join(base, "other-agent");
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "MEMORY.md"),
      "# Memory\n\n- Prefers concise status updates [by: user; kind: preference]\n- Release notes go in docs/releases [kind: project_fact]\n- Never deploy on Fridays\n",
    );
    pickFolder = vi.fn(async () => source);
    limited = [];
    handlers = createMemoryRepoIpcHandlers({
      status: async () => ({}) as never,
      getService: () => null,
      readLines: async () => [],
      openPath: vi.fn(async () => ""),
      getHubService: () => service,
      getImportService: () => service,
      pickFolder,
      workspaceExists: async (id) => id === WS,
      workspaceName: async () => "Billing",
      checkRateLimit: (channel) => limited.push(channel),
    });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("imports the folder chosen in main and never accepts a path from the renderer", async () => {
    await expect(call(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER, { path: "/etc" })).rejects.toThrow();
    await expect(call(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER, "/etc")).rejects.toThrow();
    expect(pickFolder).not.toHaveBeenCalled();
    const result = await call<MemoryRepoImportResult>(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER);
    expect(result).toEqual({
      folderName: "other-agent",
      files: 1,
      imported: 3,
      duplicates: 0,
      skipped: 0,
      truncated: false,
    });
    expect(limited).toContain(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER);
    const inbox = (await entries()).inbox;
    expect(inbox?.entries.map((entry) => [entry.text, entry.by, entry.source])).toEqual([
      ["Prefers concise status updates", "agent", "import"],
      ["Release notes go in docs/releases", "agent", "import"],
      ["Never deploy on Fridays", "agent", "import"],
    ]);
    // Importing again finds only duplicates.
    expect(await call<MemoryRepoImportResult>(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER)).toMatchObject({
      imported: 0,
      duplicates: 3,
    });
  });

  it("reports a closed picker, a refused folder and a missing picker", async () => {
    pickFolder.mockResolvedValueOnce(null);
    expect(await call<MemoryRepoImportResult>(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER)).toMatchObject({
      cancelled: true,
      imported: 0,
    });
    pickFolder.mockResolvedValueOnce(service.root);
    expect(await call<MemoryRepoImportResult>(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER)).toMatchObject({
      error: "That is your own memory folder.",
    });
    const noPicker = createMemoryRepoIpcHandlers({
      status: async () => ({}) as never,
      getService: () => null,
      readLines: async () => [],
      openPath: vi.fn(async () => ""),
      getImportService: () => service,
      checkRateLimit: () => undefined,
    });
    expect(await noPicker[IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER](undefined)).toMatchObject({
      error: "Importing needs the desktop app.",
    });
    const off = createMemoryRepoIpcHandlers({
      status: async () => ({}) as never,
      getService: () => null,
      readLines: async () => [],
      openPath: vi.fn(async () => ""),
      getImportService: () => null,
      pickFolder,
      checkRateLimit: () => undefined,
    });
    pickFolder.mockClear();
    expect(await off[IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER](undefined)).toMatchObject({
      error: "The memory folder is not available.",
    });
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("validates Keep and moves inbox lines to me.md, lessons.md or the workspace's file", async () => {
    await call(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER);
    const first = await inboxEntry("Prefers concise status updates");
    await expect(keep(first, "MEMORY")).rejects.toThrow();
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY, {
        workspaceId: WS,
        ref: first.ref,
        hash: first.hash,
        target: "me",
        by: "user",
      }),
    ).rejects.toThrow();
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY, {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        ref: first.ref,
        hash: first.hash,
        target: "me",
      }),
    ).rejects.toThrow(/Workspace not found/);

    expect(await keep(first, "me")).toMatchObject({ ok: true, ref: expect.stringMatching(/^repo:me\.md#L\d+$/) });
    const second = await inboxEntry("Release notes go in docs/releases");
    expect(await keep(second, "workspace")).toMatchObject({
      ok: true,
      ref: expect.stringMatching(/^repo:workspaces\/billing\.md#L\d+$/),
    });
    const third = await inboxEntry("Never deploy on Fridays");
    // A stale hash is refused.
    expect(await keep({ ...third, hash: "0".repeat(64) }, "lessons")).toMatchObject({ ok: false });
    expect(await keep(third, "lessons")).toMatchObject({ ok: true });

    const report = await entries();
    expect(report.inbox?.entries ?? []).toHaveLength(0);
    const byFile = Object.fromEntries(
      report.files.map((file) => [file.path, file.entries.map((entry) => [entry.text, entry.by])]),
    );
    expect(byFile["me.md"]).toContainEqual(["Prefers concise status updates", "user"]);
    expect(byFile["lessons.md"]).toContainEqual(["Never deploy on Fridays", "user"]);
    expect(byFile["workspaces/billing.md"]).toContainEqual(["Release notes go in docs/releases", "user"]);

    // Keep is for inbox lines only.
    const kept = report.files.find((file) => file.path === "me.md")!.entries[0];
    expect(await keep(kept, "lessons")).toEqual({ ok: false, error: "Only inbox entries can be kept." });
    expect(limited).toContain(IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY);
  });
});
