import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemoryRepoFile, MemoryRepoContext } from "../MemoryRepoContext";
import { MemoryRepoService } from "../MemoryRepoService";
import { memorySelectionTerms } from "../memory-repo-selection";

const render = (markdown: string, query?: string, budget = 300) =>
  renderMemoryRepoFile("workspaces/atlas.md", markdown, budget, {
    query,
    skipWorkspaceMarker: true,
    today: "2026-11-07",
  });

describe("selective workspace memory", () => {
  it("ranks a useful late entry ahead of weak project-name matches before budgeting", () => {
    const fillers = Array.from(
      { length: 20 },
      (_, i) =>
        `- Atlas inventory record ${i} documents invoice retention and quarterly accounting policy details.`,
    );
    const text = [
      "# Atlas",
      ...fillers,
      "- Atlas upgrade migrations use npm run upgrade [by: agent; kind: insight]",
    ].join("\n");
    const legacy = render(text);
    const selected = render(text, "Atlas upgrade migrations");
    expect(legacy.lines.join("\n")).not.toContain("npm run upgrade");
    expect(selected.lines.join("\n")).toContain("npm run upgrade");
    expect(selected.lines.join("\n")).not.toContain("inventory record");
    expect(selected.refs).toEqual(["repo:workspaces/atlas.md#L22"]);
  });
  it("preserves typed user constraints and preferences without injecting unrelated facts", () => {
    const text = [
      "# Atlas",
      "- Require review before deploy [by: user; kind: rule]",
      "- Keep answers concise [by: user; kind: preference]",
      "- A deadline is still open [by: user; kind: commitment]",
      "- Prefers pizza [by: agent; kind: preference]",
      "- Billing uses Stripe [by: user; kind: project_fact]",
    ].join("\n");
    expect(render(text, "weather").lines.join("\n")).toContain("Require review");
    expect(render(text, "weather").lines.join("\n")).toContain("Keep answers");
    expect(render(text, "weather").lines.join("\n")).toContain("deadline");
    expect(render(text, "weather").lines.join("\n")).not.toMatch(/pizza|Stripe/);
  });
  it("limits relevant notes, deduplicates content, and retains original attribution order", () => {
    const text = [
      "# Atlas",
      ...Array.from({ length: 10 }, (_, i) => `- Migration check ${i} [by: agent; kind: insight]`),
      "- Migration check 0 [by: agent; kind: insight]",
    ].join("\n");
    const selected = render(text, "migration", 1000);
    expect(selected.refs).toHaveLength(5);
    expect(selected.refs[0]).toBe("repo:workspaces/atlas.md#L2");
    expect(new Set(selected.hashes).size).toBe(5);
  });
  it("backfills smaller relevant entries when high-ranked entries do not fit", () => {
    const text = [
      "# Atlas",
      ...Array.from({ length: 6 }, (_, i) => `- Migration upgrade ${i} ${"detail ".repeat(35)}`),
      "- Migration safe check",
    ].join("\n");
    const selected = render(text, "migration upgrade", 35);
    expect(selected.lines.join("\n")).toContain("Migration safe check");
    expect(selected.refs).toEqual(["repo:workspaces/atlas.md#L8"]);
    expect(Math.ceil(selected.lines.join("\n").length / 4)).toBeLessThanOrEqual(35);
  });
  it("keeps file-order compatibility without useful query terms, and handles zero matches", () => {
    const text = "# Atlas\n- Billing uses Stripe\n- Build uses tsc";
    expect(render(text).lines).toEqual(render(text, "the and").lines);
    expect(render(text, "gardening").refs).toEqual([]);
  });
  it("sanitizes before ranking and excludes expired and changed-source notes", () => {
    const text =
      "# Atlas\n- Migration secret sk-abcdefghijklmnopqrstuvwxyz0123456789\n- Migration expired [until: 2000-01-01]\n- Migration source stale\n- Migration current";
    const initial = render(text, "migration");
    const stale = initial.hashes[1];
    const selected = renderMemoryRepoFile("workspaces/atlas.md", text, 300, {
      query: "migration",
      sourceChanged: (hash) => hash === stale,
    });
    expect(selected.lines.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(selected.lines.join("\n")).not.toMatch(/expired|source stale/);
    expect(selected.lines.join("\n")).toContain("Migration current");
  });
  it("uses Unicode terms and whole identifiers rather than substring matches", () => {
    expect(memorySelectionTerms("ÖDEME ödeme")).toEqual(["odeme"]);
    const selected = render(
      "# Atlas\n- TÖDEME unrelated\n- Ödeme fatura bilgileri\n- compiler unrelated",
      "ödeme",
    );
    expect(selected.refs).toEqual(["repo:workspaces/atlas.md#L3"]);
  });
});

describe("query-aware memory context cache and scope", () => {
  let dir: string | undefined;
  let service: MemoryRepoService | undefined;
  let context: MemoryRepoContext | undefined;
  afterEach(async () => {
    context?.dispose();
    await service?.stop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });
  it("changes selected refs on follow-up, keeps personal anchors, and never expands workspace scope", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-selective-recall-"));
    service = new MemoryRepoService({ root: path.join(dir, "memory"), runtime: "desktop" });
    expect((await service.start()).gitAvailable).toBe(true);
    for (const [workspaceId, text] of [
      ["atlas", "Billing uses Stripe"],
      ["atlas", "Migrations use SQLite"],
      ["harbor", "Billing uses forbidden Harbor data"],
    ]) {
      expect(
        (
          await service.remember({
            text,
            kind: "project_fact",
            scope: "workspace",
            workspaceId,
            workspaceName: workspaceId,
            by: "user",
            origin: "memory_hub",
          })
        ).status,
      ).toBe("written");
    }
    await service.remember({
      text: "Require confirmation before publishing",
      kind: "rule",
      scope: "global",
      pinned: true,
      by: "user",
      origin: "memory_hub",
    });
    context = new MemoryRepoContext({ getService: () => service!, getTeamRepos: () => [] });
    const billing = await context.build({ workspaceId: "atlas", query: "billing" });
    const migrations = await context.build({ workspaceId: "atlas", query: "migrations" });
    expect(billing?.text).toContain("Stripe");
    expect(billing?.text).not.toContain("SQLite");
    expect(migrations?.text).toContain("SQLite");
    expect(migrations?.text).not.toContain("Stripe");
    expect(migrations?.text).toContain("confirmation before publishing");
    expect(billing?.text).not.toContain("forbidden Harbor data");
    expect(billing?.refs).not.toEqual(migrations?.refs);
    expect(await context.build({ workspaceId: "atlas", query: "MIGRATIONS" })).toBe(migrations);
    expect((await context.build({ workspaceId: "atlas" }))?.text).toContain("Stripe");
    for (const botId of ["writer", "other"]) {
      await service.remember({
        text: `Billing bot note for ${botId}`,
        kind: "insight",
        scope: "bot",
        botId,
        botName: botId,
        by: "agent",
        origin: "agent_tool",
      });
    }
    const botBilling = await context.build({
      workspaceId: "atlas",
      botId: "writer",
      query: "billing",
    });
    expect(botBilling?.text).toContain("Billing bot note for writer");
    expect(botBilling?.text).not.toContain("Billing bot note for other");
    expect(
      (await context.build({ workspaceId: "atlas", botId: "writer", query: "migrations" }))?.text,
    ).not.toContain("Billing bot note");
  }, 30000);
});
