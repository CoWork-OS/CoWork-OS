import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import {
  listMemoryRepoEntries,
  memoryRepoFileToOpen,
  pinMemoryRepoEntry,
  removeMemoryRepoEntry,
  updateMemoryRepoEntry,
} from "../memory-repo-hub";
import { deleteBotMemory } from "../memory-repo-bots";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

describeWithGit("bots' own memory in the Memory Hub", () => {
  let base: string;
  let service: MemoryRepoService;

  const rememberBot = (botId: string, botName: string, text: string) =>
    service.remember({
      text,
      kind: "rule",
      scope: "bot",
      botId,
      botName,
      by: "agent",
      origin: "agent_tool",
    });

  const lookupBot = async (botId: string) =>
    botId === "bot-ember"
      ? { name: "Ember", deleted: false }
      : botId === "bot-old"
        ? { name: "Old helper", deleted: true }
        : null;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-hub-bots-"));
    service = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "desktop" });
    await service.start();
    await rememberBot("bot-ember", "Ember", "Posts the invoice digest on Mondays");
    await rememberBot("bot-old", "Old helper", "Archived the Q3 receipts");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("lists bot files apart, by bot name, in any workspace, with deleted bots marked", async () => {
    for (const workspaceId of ["ws-1", "ws-2"]) {
      const report = await listMemoryRepoEntries(service, workspaceId, lookupBot);
      expect(report.files.some((file) => file.path.startsWith("bots/"))).toBe(false);
      expect(
        report.bots?.map((file) => [file.title, file.role, file.botId, file.botDeleted]),
      ).toEqual([
        ["Ember", "bot", "bot-ember", undefined],
        ["Old helper", "bot", "bot-old", true],
      ]);
      expect(report.bots?.[0].entries.map((entry) => entry.text)).toEqual([
        "Posts the invoice digest on Mondays",
      ]);
    }
    // Without a lookup the file's heading names it.
    const plain = await listMemoryRepoEntries(service, "ws-1");
    expect(plain.bots?.map((file) => file.title)).toEqual(["Ember", "Old helper"]);
  });

  it("edits and deletes bot entries but never pins them or deletes the marker", async () => {
    const report = await listMemoryRepoEntries(service, "ws-1", lookupBot);
    const ember = report.bots!.find((file) => file.botId === "bot-ember")!;
    const entry = ember.entries[0];
    const request = { workspaceId: "ws-1", ref: entry.ref, hash: entry.hash };

    expect(await pinMemoryRepoEntry(service, request)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot be pinned"),
    });
    const edited = await updateMemoryRepoEntry(service, {
      ...request,
      text: "Posts the invoice digest on Tuesdays",
    });
    expect(edited).toMatchObject({ ok: true });
    const after = await listMemoryRepoEntries(service, "ws-1", lookupBot);
    const updated = after.bots!.find((file) => file.botId === "bot-ember")!.entries[0];
    expect(updated).toMatchObject({ text: "Posts the invoice digest on Tuesdays", by: "user" });

    const markerLine = fs
      .readFileSync(path.join(service.root, ember.path), "utf8")
      .split("\n")
      .findIndex((line) => line.includes("[by: user; bot: bot-ember]"));
    const marker = await removeMemoryRepoEntry(service, {
      workspaceId: "ws-1",
      ref: `repo:${ember.path}#L${markerLine + 1}`,
      hash: updated.hash,
    });
    expect(marker).toMatchObject({ ok: false });

    expect(
      await removeMemoryRepoEntry(service, {
        workspaceId: "ws-1",
        ref: updated.ref,
        hash: updated.hash,
      }),
    ).toEqual({ ok: true });
    expect(await service.botFile("bot-ember")).toBe(ember.path);
    expect(await memoryRepoFileToOpen(service, { workspaceId: "ws-2", path: ember.path })).toBe(
      path.join(service.root, ember.path),
    );
  });

  it("deletes a bot's whole file in one commit and leaves other bots alone", async () => {
    const file = (await service.botFile("bot-old"))!;
    expect(await deleteBotMemory(service, "bot-old")).toEqual({ ok: true, entries: 1 });
    expect(fs.existsSync(path.join(service.root, file))).toBe(false);
    expect(await service.botFile("bot-old")).toBeNull();
    expect(await service.botFile("bot-ember")).not.toBeNull();
    expect(
      execFileSync("git", ["log", "-1", "--format=%s"], { cwd: service.root, encoding: "utf8" }),
    ).toMatch(/^Delete bot memory: bots\/old-helper\.md/);
    expect(await deleteBotMemory(service, "bot-old")).toMatchObject({ ok: false });
    expect(await deleteBotMemory(null, "bot-ember")).toMatchObject({ ok: false });
  });
});
