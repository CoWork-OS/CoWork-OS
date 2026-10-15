/**
 * A bot's own memory over IPC (memoryRepo:botMemory, botForget, botUndo): validation in main,
 * unknown bots refused, rate limits per channel, and actions confined to the bot's file.
 * Uses a real MemoryRepoService.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import type { MemoryRepoBotMemoryReport } from "../../../shared/memory-repo-types";
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

describeWithGit("bot memory IPC", () => {
  let base: string;
  let service: MemoryRepoService;
  let handlers: Record<string, (raw: unknown) => Promise<unknown>>;
  let limited: string[];

  const call = <T>(channel: string, raw: unknown) => handlers[channel](raw) as Promise<T>;
  const report = (botId = "bot-ember") =>
    call<MemoryRepoBotMemoryReport>(IPC_CHANNELS.MEMORY_REPO_BOT_MEMORY, { botId });

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-bot-ipc-"));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "desktop" });
    await service.start();
    for (const [botId, text] of [
      ["bot-ember", "Posts the invoice digest on Mondays"],
      ["bot-scout", "Tracks competitor pricing"],
    ]) {
      await service.remember({
        text,
        kind: "rule",
        scope: "bot",
        botId,
        botName: botId === "bot-ember" ? "Ember" : "Scout",
        by: "agent",
        origin: "agent_tool",
      });
    }
    limited = [];
    handlers = createMemoryRepoIpcHandlers({
      status: vi.fn() as Any,
      getService: () => null,
      readLines: vi.fn() as Any,
      openPath: vi.fn() as Any,
      checkRateLimit: (channel) => {
        limited.push(channel);
      },
      getBotService: () => service,
      botExists: async (botId) => botId === "bot-ember" || botId === "bot-scout",
    });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("lists the bot's entries and history and refuses bad or unknown bots", async () => {
    const ember = await report();
    expect(ember.path).toBe("bots/ember.md");
    expect(ember.entries.map((entry) => entry.text)).toEqual([
      "Posts the invoice digest on Mondays",
    ]);
    expect(ember.history).toHaveLength(1);
    expect(limited).toContain(IPC_CHANNELS.MEMORY_REPO_BOT_MEMORY);

    await expect(report("bot-missing")).rejects.toThrow("Bot not found");
    await expect(report("../etc")).rejects.toThrow();
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_BOT_MEMORY, { botId: "bot-ember", extra: 1 }),
    ).rejects.toThrow();
  });

  it("forgets and undoes within the bot's own file only", async () => {
    const ember = await report();
    const scout = await report("bot-scout");
    // Another bot's entry cannot be forgotten through this bot.
    expect(
      await call(IPC_CHANNELS.MEMORY_REPO_BOT_FORGET, {
        botId: "bot-ember",
        ref: scout.entries[0].ref,
        hash: scout.entries[0].hash,
      }),
    ).toMatchObject({ ok: false });
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_BOT_FORGET, {
        botId: "bot-ember",
        ref: "repo:../outside.md#L1",
        hash: ember.entries[0].hash,
      }),
    ).rejects.toThrow();

    expect(
      await call(IPC_CHANNELS.MEMORY_REPO_BOT_FORGET, {
        botId: "bot-ember",
        ref: ember.entries[0].ref,
        hash: ember.entries[0].hash,
      }),
    ).toEqual({ ok: true });
    const forgotten = await report();
    expect(forgotten.entries).toEqual([]);

    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_BOT_UNDO, { botId: "bot-ember", commit: "not-a-sha" }),
    ).rejects.toThrow();
    expect(
      await call(IPC_CHANNELS.MEMORY_REPO_BOT_UNDO, {
        botId: "bot-ember",
        commit: forgotten.history[0].commit,
      }),
    ).toEqual({ ok: true });
    expect((await report()).entries.map((entry) => entry.text)).toEqual([
      "Posts the invoice digest on Mondays",
    ]);
    expect((await report("bot-scout")).entries).toHaveLength(1);
    expect(limited).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.MEMORY_REPO_BOT_FORGET,
        IPC_CHANNELS.MEMORY_REPO_BOT_UNDO,
      ]),
    );
  });

  it("deletes a bot's whole memory and names bots in the Hub", async () => {
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_BOT_DELETE_MEMORY, { botId: "bot-missing" }),
    ).rejects.toThrow("Bot not found");
    await expect(
      call(IPC_CHANNELS.MEMORY_REPO_BOT_DELETE_MEMORY, { botId: "bot-scout", path: "x" }),
    ).rejects.toThrow();
    expect(await call(IPC_CHANNELS.MEMORY_REPO_BOT_DELETE_MEMORY, { botId: "bot-scout" })).toEqual({
      ok: true,
      entries: 1,
    });
    expect((await report("bot-scout")).path).toBeNull();
    expect((await report()).entries).toHaveLength(1);
    expect(limited).toContain(IPC_CHANNELS.MEMORY_REPO_BOT_DELETE_MEMORY);

    handlers = createMemoryRepoIpcHandlers({
      status: vi.fn() as Any,
      getService: () => null,
      readLines: vi.fn() as Any,
      openPath: vi.fn() as Any,
      checkRateLimit: () => {},
      getHubService: () => service,
      lookupBot: async (botId) =>
        botId === "bot-ember" ? { name: "Ember", deleted: false } : null,
    });
    const hub = (await call(IPC_CHANNELS.MEMORY_REPO_ENTRIES, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
    })) as Any;
    expect(hub.bots.map((file: Any) => [file.title, file.botId])).toEqual([["Ember", "bot-ember"]]);
  });

  it("reports the folder as unavailable without a service", async () => {
    handlers = createMemoryRepoIpcHandlers({
      status: vi.fn() as Any,
      getService: () => null,
      readLines: vi.fn() as Any,
      openPath: vi.fn() as Any,
      checkRateLimit: () => {},
    });
    expect(await report()).toMatchObject({ available: false, entries: [] });
  });
});
