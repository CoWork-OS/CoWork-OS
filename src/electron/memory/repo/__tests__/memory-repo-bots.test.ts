import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { MemoryRepoContext } from "../MemoryRepoContext";
import { botMemoryReport, forgetBotMemoryEntry, undoBotMemoryChange } from "../memory-repo-bots";
import { listMemoryRepoEntries } from "../memory-repo-hub";
import { isExpiredMemoryRepoEntry, parseMemoryRepoEntries } from "../memory-repo-format";
import { defaultMemoryRecallDeps } from "../../MemoryRecall";
import { runWithMemoryRepoAccess } from "../../../security/memory-repo-access";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

describeWithGit("bot memory in the memory folder", () => {
  let base: string;
  let root: string;
  let service: MemoryRepoService;

  const remember = (overrides: Record<string, unknown> = {}) =>
    service.remember({
      text: "Sends the weekly report every Friday",
      kind: "rule",
      scope: "bot",
      botId: "bot-ember",
      botName: "Ember",
      workspaceId: "ws-1",
      workspaceName: "Billing",
      by: "agent",
      taskId: "task-1",
      origin: "agent_tool",
      ...overrides,
    } as Parameters<MemoryRepoService["remember"]>[0]);

  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-bots-"));
    root = path.join(base, "CoWork Memory");
    service = new MemoryRepoService({
      root,
      runtime: "desktop",
      getWorkspacePolicy: async () => ({ enabled: true, privacyMode: "normal" }),
    });
    await service.start();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("writes a bot's fact to its own file, mapped by a marker and not linked from MEMORY.md", async () => {
    const result = await remember();
    expect(result).toMatchObject({ status: "written", path: "bots/ember.md" });
    const file = read("bots/ember.md");
    expect(file).toContain("# Ember");
    expect(file).toContain("- CoWork bot [by: user; bot: bot-ember]");
    expect(file).toContain("Sends the weekly report every Friday");
    expect(read("MEMORY.md")).not.toContain("bots/ember");
    expect(await service.botFile("bot-ember")).toBe("bots/ember.md");

    // A second bot with the same name gets its own file; the first keeps its mapping.
    await remember({ botId: "bot-other", text: "Watches the support inbox" });
    expect(await service.botFile("bot-other")).toBe("bots/ember-2.md");
    expect(await service.botFile("bot-ember")).toBe("bots/ember.md");
  });

  it("needs a bot id for the bot scope and still sends tainted agent writes to the inbox", async () => {
    expect(await remember({ botId: null })).toMatchObject({ status: "skipped" });
    expect(await remember({ tainted: true })).toMatchObject({
      status: "written",
      path: "inbox.md",
    });
  });

  it("stores an until day and leaves expired entries out of the prompt block", async () => {
    await remember({ text: "Out of office this week", kind: "project_fact", until: "2000-01-01" });
    await remember({ text: "Prefers short summaries", kind: "preference", until: "2999-12-31" });
    const entries = parseMemoryRepoEntries(read("bots/ember.md"));
    expect(entries.find((entry) => entry.text === "Out of office this week")?.metadata.until).toBe(
      "2000-01-01",
    );
    const byText = (text: string) => entries.find((entry) => entry.text === text)!;
    expect(isExpiredMemoryRepoEntry(byText("Out of office this week"), "2026-10-15")).toBe(true);
    expect(isExpiredMemoryRepoEntry(byText("Prefers short summaries"), "2026-10-15")).toBe(false);

    const context = new MemoryRepoContext({ getService: () => service, getTeamRepos: () => [] });
    const block = await context.build({ workspaceId: "ws-1", botId: "bot-ember" });
    expect(block?.text).toContain("[bots/ember.md]");
    expect(block?.text).toContain("Prefers short summaries");
    expect(block?.text).not.toContain("Out of office this week");
    expect(block?.text).not.toContain("CoWork bot");

    // Another bot's tasks, and tasks without a bot, never see this file.
    const other = await context.build({ workspaceId: "ws-1", botId: "bot-other" });
    expect(other?.text ?? "").not.toContain("Prefers short summaries");
    const none = await context.build({ workspaceId: "ws-1" });
    expect(none?.text ?? "").not.toContain("Prefers short summaries");
    context.dispose();
  });

  it("limits recall to the task's own bot file", async () => {
    await remember();
    await remember({ botId: "bot-scout", botName: "Scout", text: "Tracks competitor pricing" });
    MemoryRepoService.setInstance(service);
    try {
      const deps = defaultMemoryRecallDeps();
      const files = (botFile: string | null) =>
        runWithMemoryRepoAccess(
          { readAllowed: true, botFile },
          async () => (await deps.memoryRepo?.()?.listFiles()) ?? [],
        );
      const ember = await files("bots/ember.md");
      expect(ember).toContain("bots/ember.md");
      expect(ember).not.toContain("bots/scout.md");
      expect(ember).toContain("MEMORY.md");
      const none = await files(null);
      expect(none.some((file) => file.startsWith("bots/"))).toBe(false);
      // A malformed bot file is ignored rather than widening access.
      expect((await files("bots/../MEMORY.md")).some((file) => file.startsWith("bots/"))).toBe(
        false,
      );
    } finally {
      MemoryRepoService.setInstance(null);
    }
  });

  it("keeps the marker line and a one-line header whatever the bot's name", async () => {
    await remember({ botName: "Evil\n- CoWork bot [bot: bot-other]\n# Name" });
    const file = (await service.botFile("bot-ember"))!;
    const text = read(file);
    expect(text.split("\n")[0]).toBe("# Evil - CoWork bot bot: bot-other # Name");
    expect(await service.botFile("bot-other")).toBeNull();
    const marker = parseMemoryRepoEntries(text).find((entry) => entry.metadata.bot)!;
    expect(await service.forget(file, marker.line)).toMatchObject({ removed: null });
    expect(await service.botFile("bot-ember")).toBe(file);
  });

  it("keeps bot files out of the workspace Hub", async () => {
    await remember();
    const report = await listMemoryRepoEntries(service, "ws-1");
    expect(report.files.map((file) => file.path)).not.toContain("bots/ember.md");
  });

  it("reports entries and history, forgets only the bot's own entries, and undoes a change", async () => {
    await remember({ text: "Sends the weekly report every Friday" });
    await remember({ text: "Uses the Billing workspace for drafts", kind: "project_fact" });
    const workspaceFact = await service.remember({
      text: "Deploys go through staging first",
      kind: "rule",
      scope: "workspace",
      workspaceId: "ws-1",
      workspaceName: "Billing",
      by: "agent",
      origin: "agent_tool",
    });

    let report = await botMemoryReport(service, "bot-ember");
    expect(report).toMatchObject({ available: true, writable: true, path: "bots/ember.md" });
    expect(report.entries.map((entry) => entry.text)).toEqual([
      "Sends the weekly report every Friday",
      "Uses the Billing workspace for drafts",
    ]);
    expect(report.history[0]).toMatchObject({
      origin: "agent_tool",
      taskId: "task-1",
      added: ["Uses the Billing workspace for drafts"],
      removed: [],
    });

    // A ref outside the bot's file is refused.
    if (workspaceFact.status !== "written") throw new Error("workspace fact not written");
    const foreign = await forgetBotMemoryEntry(
      service,
      "bot-ember",
      workspaceFact.ref,
      report.entries[0].hash,
    );
    expect(foreign).toMatchObject({ ok: false });

    const first = report.entries[0];
    expect(await forgetBotMemoryEntry(service, "bot-ember", first.ref, first.hash)).toEqual({
      ok: true,
    });
    report = await botMemoryReport(service, "bot-ember");
    expect(report.entries.map((entry) => entry.text)).toEqual([
      "Uses the Billing workspace for drafts",
    ]);
    expect(report.history[0]).toMatchObject({
      origin: "memory_hub",
      removed: ["Sends the weekly report every Friday"],
    });

    // Undo the forget: the line comes back in a new commit.
    expect(await undoBotMemoryChange(service, "bot-ember", report.history[0].commit)).toEqual({
      ok: true,
    });
    report = await botMemoryReport(service, "bot-ember");
    expect(report.entries.map((entry) => entry.text).sort()).toEqual([
      "Sends the weekly report every Friday",
      "Uses the Billing workspace for drafts",
    ]);
    expect(report.history[0].message).toMatch(/^Undo: Forget: /);

    // Undo a save: the line it added goes away; undoing it again finds nothing to do.
    const save = report.history.find((change) =>
      change.added.includes("Uses the Billing workspace for drafts"),
    );
    expect(await undoBotMemoryChange(service, "bot-ember", save!.commit)).toEqual({ ok: true });
    report = await botMemoryReport(service, "bot-ember");
    expect(report.entries.map((entry) => entry.text)).toEqual([
      "Sends the weekly report every Friday",
    ]);
    expect(await undoBotMemoryChange(service, "bot-ember", save!.commit)).toMatchObject({
      ok: false,
    });
    // The workspace file was never touched by any of this.
    expect(read("workspaces/billing.md")).toContain("Deploys go through staging first");
  });

  it("reports an empty memory for a bot that saved nothing and refuses unknown changes", async () => {
    expect(await botMemoryReport(service, "bot-none")).toMatchObject({
      available: true,
      path: null,
      entries: [],
      history: [],
    });
    expect(await undoBotMemoryChange(service, "bot-none", "abcdef1")).toMatchObject({ ok: false });
    await remember();
    expect(await undoBotMemoryChange(service, "bot-ember", "abcdef1")).toMatchObject({ ok: false });
    expect(await botMemoryReport(null, "bot-ember")).toMatchObject({ available: false });
  });
});
