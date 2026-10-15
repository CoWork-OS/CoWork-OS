/**
 * A bot's own memory through the memory tools: `memory_remember` scope `bot` (the default in a
 * bot's tasks for facts that are not about the user) writes the bot's file in the memory
 * folder, with an optional `until` day; `memory_recall` scope `bot` searches or lists that
 * bot's other conversations, within `since`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  getSettings: vi.fn(),
  searchConversation: vi.fn(),
  recentConversation: vi.fn(),
  loadSettings: vi.fn(),
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: { capture: vi.fn(), getSettings: mocks.getSettings },
}));
vi.mock("../../../memory/CuratedMemoryService", () => ({ CuratedMemoryService: {} }));
vi.mock("../../../settings/personality-manager", () => ({
  PersonalityManager: { setUserName: vi.fn() },
}));
vi.mock("../../../memory/MemoryWriteGate", () => ({
  MemoryWriteGate: { evaluate: mocks.evaluate },
}));
vi.mock("../../../memory/DurableContextService", () => ({
  DurableContextService: {
    searchConversation: mocks.searchConversation,
    recentConversation: mocks.recentConversation,
  },
}));
vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: { loadSettings: mocks.loadSettings },
}));

import { MemoryTools, parseSince } from "../memory-tools";
import { MemoryWriter } from "../../../memory/MemoryWriter";
import { MemoryRepoService } from "../../../memory/repo/MemoryRepoService";
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

const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithMemoryRepoAccess({ readAllowed: true }, fn);

const workspace = {
  id: "ws-1",
  name: "Billing Service",
  path: "/tmp/ws-1",
  createdAt: 0,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
} as Any;

function makeDaemon(options: { bot?: boolean } = {}) {
  const bot = options.bot !== false;
  return {
    logEvent: vi.fn(),
    requestApproval: vi.fn(async () => true),
    getTask: vi.fn(() => ({
      id: "task-1",
      prompt: "hi",
      rawPrompt: "hi",
      ...(bot ? { assignedAgentRoleId: "role-ember", agentConfig: { botConversation: true } } : {}),
    })),
    getAgentRoleById: vi.fn((id: string) =>
      id === "role-ember" ? { id, name: "ember", displayName: "Ember" } : undefined,
    ),
    listBotConversationRefs: vi.fn(() => [
      { id: "task-1", title: "This chat" },
      { id: "task-old", title: "Monday planning" },
      { id: "task-older", title: "Invoices" },
    ]),
    getTaskEvents: vi.fn(() => [
      { type: "user_message", timestamp: 5, payload: { message: "hi" } },
    ]),
    listRecentSensitiveSources: vi.fn(() => []),
  } as Any;
}

describe("parseSince", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  it("reads hours, days, weeks and a day", () => {
    expect(parseSince("24h", now)).toBe(now - 24 * 3_600_000);
    expect(parseSince("3d", now)).toBe(now - 3 * 86_400_000);
    expect(parseSince("2W", now)).toBe(now - 14 * 86_400_000);
    expect(parseSince("2026-10-01", now)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseSince("yesterday", now)).toBeNull();
    expect(parseSince(undefined, now)).toBeNull();
  });
});

describeWithGit("memory tools in a bot's tasks", () => {
  let base: string;
  let repo: MemoryRepoService;
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), "utf8");

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.evaluate.mockResolvedValue({ allowed: true });
    mocks.getSettings.mockResolvedValue({ enabled: true, privacyMode: "normal" });
    mocks.loadSettings.mockReturnValue({ sessionRecallEnabled: true });
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tools-bot-"));
    repo = new MemoryRepoService({
      root: path.join(base, "CoWork Memory"),
      runtime: "desktop",
      getWorkspacePolicy: async () => mocks.getSettings(),
    });
    await repo.start();
    MemoryRepoService.setInstance(repo);
    MemoryWriter.setInstance({ ingest: vi.fn(), repository: {} } as Any);
  });

  afterEach(() => {
    MemoryRepoService.setInstance(null);
    MemoryWriter.setInstance(null);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("saves the bot's facts to its own file by default, with an until day", () =>
    inScope(async () => {
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.remember({
        content: "Posts the invoice digest on Mondays",
        kind: "rule",
        until: "2999-01-31",
      });
      expect(result).toMatchObject({ success: true, file: "bots/ember.md", scope: "bot" });
      const file = read("bots/ember.md");
      expect(file).toContain("# Ember");
      expect(file).toMatch(/Posts the invoice digest on Mondays \[.*until: 2999-01-31/);
    }));

  it("keeps facts about the user global and honours an explicit workspace scope", () =>
    inScope(async () => {
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect(await tools.remember({ content: "Lives in Lisbon", kind: "identity" })).toMatchObject({
        success: true,
        file: "me.md",
      });
      expect(
        await tools.remember({ content: "Deploys need the VPN", kind: "rule", scope: "workspace" }),
      ).toMatchObject({ success: true, file: "workspaces/billing-service.md" });
      expect(
        await tools.remember({
          content: "Wants replies in two lines",
          kind: "preference",
          scope: "bot",
        }),
      ).toMatchObject({ success: true, file: "bots/ember.md" });
    }));

  it("falls back to the workspace outside a bot's tasks and ignores a past until day", () =>
    inScope(async () => {
      const tools = new MemoryTools(workspace, makeDaemon({ bot: false }), "task-1");
      const result = await tools.remember({
        content: "Releases ship on Thursdays",
        kind: "rule",
        scope: "bot",
        until: "2001-01-01",
      });
      expect(result).toMatchObject({ success: true, file: "workspaces/billing-service.md" });
      expect(read("workspaces/billing-service.md")).not.toContain("until:");
    }));

  it("never forgets another bot's memory", async () => {
    const other = await repo.remember({
      text: "Tracks competitor pricing",
      kind: "rule",
      scope: "bot",
      botId: "role-scout",
      botName: "Scout",
      by: "agent",
      origin: "agent_tool",
    });
    if (other.status !== "written") throw new Error("not written");
    const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
    const result = await runWithMemoryRepoAccess(
      { readAllowed: true, botFile: "bots/ember.md" },
      () => tools.forget({ id: other.ref }),
    );
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("another bot") });
    expect(read("bots/scout.md")).toContain("Tracks competitor pricing");
  });

  it("searches the bot's other conversations, newest window only", async () => {
    const now = Date.now();
    mocks.searchConversation.mockImplementation(async ({ taskId }: { taskId: string }) =>
      taskId === "task-old"
        ? [
            {
              id: "dce_1",
              taskId,
              role: "user",
              type: "user_message",
              snippet: "invoice code ALPHA",
              timestamp: now - 3_600_000,
              score: 2,
            },
          ]
        : taskId === "task-older"
          ? [
              {
                id: "dce_2",
                taskId,
                role: "user",
                type: "user_message",
                snippet: "invoice notes",
                timestamp: now - 10 * 86_400_000,
                score: 3,
              },
            ]
          : [
              {
                id: "dce_3",
                taskId,
                role: "user",
                type: "user_message",
                snippet: "this chat",
                timestamp: now,
                score: 9,
              },
            ],
    );
    const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
    const result = (await tools.recall({ query: "invoice", scopes: ["bot"], since: "3d" })) as Any;
    // With a window, each conversation is read deeper than `limit`, so older matches
    // cannot crowd out the ones inside the window before the filter runs.
    expect(mocks.searchConversation).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-old", limit: 30 }),
    );
    expect(result.results).toEqual([
      expect.objectContaining({
        id: "event:dce_1",
        lane: "bot",
        conversation: "Monday planning",
        snippet: "invoice code ALPHA",
      }),
    ]);
    // The current conversation is never searched (context_recall covers it).
    expect(mocks.searchConversation).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
    );
  });

  it("lists recent messages without a query, and refuses outside a bot or when recall is off", async () => {
    mocks.recentConversation.mockResolvedValue([
      {
        id: "dce_9",
        taskId: "task-old",
        role: "assistant",
        type: "assistant_message",
        snippet: "Done",
        timestamp: Date.now(),
        score: 0,
      },
    ]);
    const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
    const listed = (await tools.recall({ scopes: ["bot"], since: "24h" })) as Any;
    expect(listed.results).toHaveLength(2);
    expect(await tools.recall({ scopes: ["bot"] })).toMatchObject({
      error: expect.stringContaining("since"),
    });

    const plain = new MemoryTools(workspace, makeDaemon({ bot: false }), "task-1");
    expect(await plain.recall({ query: "x", scopes: ["bot"] })).toMatchObject({
      error: expect.stringContaining("bot's conversations"),
    });

    mocks.loadSettings.mockReturnValue({ sessionRecallEnabled: false });
    expect(await tools.recall({ query: "x", scopes: ["bot"] })).toMatchObject({
      error: expect.stringContaining("turned off"),
    });
    // Asked for together with other scopes, a failed bot lane is reported, not the answer.
    const mixed = (await inScope(() =>
      tools.recall({ query: "x", scopes: ["memory", "bot"] }),
    )) as Any;
    expect(mixed.error).toBeUndefined();
    expect(mixed.unavailable?.bot).toContain("turned off");
    expect(Array.isArray(mixed.results)).toBe(true);
  });
});
