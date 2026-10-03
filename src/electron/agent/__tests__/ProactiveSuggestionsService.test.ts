import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memoryCapture = vi.fn();
const memorySearch = vi.fn();
const repoLoad = vi.fn();
const repoSave = vi.fn();
const gate = vi.hoisted(() => ({ enabled: true, strict: false }));
const profile = vi.hoisted(() => ({ db: null as import("better-sqlite3").Database | null }));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    getDatabase: () => profile.db,
    search: (...args: unknown[]) => memorySearch(...args),
    searchByContentMarker: (...args: unknown[]) => memorySearch(...args),
    capture: (...args: unknown[]) => memoryCapture(...args),
    getRecent: vi.fn(() => []),
    prepareDerivedRecord: vi.fn(async (_workspaceId: string, content: string) =>
      gate.enabled ? { content, isPrivate: gate.strict } : null,
    ),
  },
}));

vi.mock("../../memory/UserProfileService", () => ({
  UserProfileService: {
    getProfile: vi.fn(() => ({ facts: [] })),
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    isInitialized: vi.fn(() => false),
    search: vi.fn(() => []),
    getObservations: vi.fn(() => []),
  },
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn(() => true),
    getInstance: vi.fn(() => ({
      load: (...args: unknown[]) => repoLoad(...args),
      save: (...args: unknown[]) => repoSave(...args),
    })),
  },
}));

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/** Store a suggestion row directly, as an earlier run (or the archive migration) left it. */
function seedSuggestion(workspaceId: string, id: string, title: string, createdAt = Date.now()) {
  profile
    .db!.prepare(
      `INSERT INTO suggestions (id, workspace_id, type, title, description, confidence, payload,
         status, is_private, created_at, expires_at, updated_at)
       VALUES (?, ?, 'follow_up', ?, ?, 0.6, ?, 'active', 0, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      title,
      `${title} description`,
      JSON.stringify({
        id,
        type: "follow_up",
        title,
        description: `${title} description`,
        confidence: 0.6,
      }),
      createdAt,
      createdAt + SEVEN_DAYS,
      createdAt,
    );
}

/** Let the fire-and-forget feedback write settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("ProactiveSuggestionsService", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T15:00:00Z"));
    profile.db = new Database(":memory:");
    const { ensureSuggestionsSchema } = await import("../../memory/suggestions-sql");
    ensureSuggestionsSchema(profile.db);
    gate.enabled = true;
    gate.strict = false;
    memorySearch.mockReset();
    memoryCapture.mockReset();
    repoLoad.mockReset();
    repoSave.mockReset();
    repoLoad.mockReturnValue({
      dismissed: [],
      actedOn: [],
      surfacedAt: {},
      telemetryEvents: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    profile.db?.close();
    profile.db = null;
  });

  it("records surface and dismiss telemetry for visible suggestions", async () => {
    seedSuggestion("ws-1", "s1", "Write tests");
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const suggestions = await ProactiveSuggestionsService.listActive("ws-1");
    expect(suggestions).toHaveLength(1);

    const savedAfterSurface = repoSave.mock.calls.at(-1)?.[1];
    expect(
      savedAfterSurface.telemetryEvents.some(
        (event: { type: string }) => event.type === "surfaced",
      ),
    ).toBe(true);

    await ProactiveSuggestionsService.dismiss("ws-1", "s1");
    expect(profile.db!.prepare("SELECT status FROM suggestions WHERE id = 's1'").get()).toEqual({
      status: "dismissed",
    });
    expect(await ProactiveSuggestionsService.listActive("ws-1")).toEqual([]);
    const savedAfterDismiss = repoSave.mock.calls.at(-1)?.[1];
    expect(
      savedAfterDismiss.telemetryEvents.some(
        (event: { type: string; suggestionId: string }) =>
          event.type === "dismissed" && event.suggestionId === "s1",
      ),
    ).toBe(true);
  });

  it("defers low-signal suggestions from interactive surfaces but keeps them for briefings", async () => {
    seedSuggestion("ws-1", "s2", "Review backlog");
    repoLoad.mockReturnValue({
      dismissed: [],
      actedOn: [],
      surfacedAt: {},
      telemetryEvents: [
        { workspaceId: "ws-1", suggestionId: "old-1", type: "acted_on", at: 1, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-2", type: "acted_on", at: 2, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-3", type: "acted_on", at: 3, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-4", type: "dismissed", at: 4, hour: 15 },
        { workspaceId: "ws-1", suggestionId: "old-5", type: "dismissed", at: 5, hour: 15 },
        { workspaceId: "ws-1", suggestionId: "old-6", type: "dismissed", at: 6, hour: 15 },
      ],
    });

    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    expect(await ProactiveSuggestionsService.listActive("ws-1")).toHaveLength(0);
    expect(await ProactiveSuggestionsService.getTopForBriefing("ws-1", 3)).toHaveLength(1);
  });

  it("stores and parses companion suggestion metadata", async () => {
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const created = await ProactiveSuggestionsService.createCompanionSuggestion("ws-1", {
      title: "Companion summary",
      description: "Cross-workspace pressure detected.",
      confidence: 0.88,
      suggestionClass: "cross_workspace",
      urgency: "medium",
      learningSignalIds: ["sig-1", "sig-2"],
      workspaceScope: "all",
      sourceSignals: ["focus-1", "due-1"],
      recommendedDelivery: "inbox",
      companionStyle: "email",
    });

    expect(created).toMatchObject({
      title: "Companion summary",
      workspaceScope: "all",
      recommendedDelivery: "inbox",
      companionStyle: "email",
      suggestionClass: "cross_workspace",
    });
    // Stored in the suggestions table, never in the memory archive.
    expect(memoryCapture).not.toHaveBeenCalled();
    const row = profile.db!.prepare("SELECT * FROM suggestions").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      workspace_id: "ws-1",
      title: "Companion summary",
      status: "active",
    });
    expect(JSON.parse(row.payload as string)).toMatchObject({ workspaceScope: "all" });
    const [listed] = await ProactiveSuggestionsService.listActive("ws-1", {
      includeDeferred: true,
      recordSurface: false,
    });
    expect(listed).toMatchObject({
      id: created!.id,
      workspaceScope: "all",
      recommendedDelivery: "inbox",
      companionStyle: "email",
      sourceSignals: expect.arrayContaining(["focus-1", "due-1"]),
    });
  });

  it("records feedback in suggestion_feedback and acted-on status on the row", async () => {
    seedSuggestion("ws-1", "s3", "Draft the launch email");
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    await ProactiveSuggestionsService.actOn("ws-1", "s3");
    await flush();
    expect(memoryCapture).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(profile.db!.prepare("SELECT COUNT(*) AS n FROM suggestion_feedback").get()).toEqual({
        n: 1,
      }),
    );
    expect(profile.db!.prepare("SELECT status FROM suggestions WHERE id = 's3'").get()).toEqual({
      status: "acted_on",
    });
    expect(
      profile.db!.prepare("SELECT suggestion_id, action, title FROM suggestion_feedback").all(),
    ).toEqual([{ suggestion_id: "s3", action: "acted_on", title: "Draft the launch email" }]);
    const { getProactiveSuggestionStore } = await import("../../memory/ProactiveSuggestionStore");
    expect(await (await getProactiveSuggestionStore())!.countFeedback("ws-1", "acted_on", 2)).toBe(
      1,
    );
  });

  it("stores nothing when memory settings do not allow it", async () => {
    gate.enabled = false;
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");
    expect(
      await ProactiveSuggestionsService.createCompanionSuggestion("ws-1", {
        title: "Should not persist",
        description: "x",
        confidence: 0.9,
      }),
    ).toBeNull();
    expect(profile.db!.prepare("SELECT COUNT(*) AS n FROM suggestions").get()).toEqual({ n: 0 });
  });

  it("aggregates briefing suggestions across multiple workspaces when requested", async () => {
    seedSuggestion("ws-1", "s1", "Workspace one");
    seedSuggestion("ws-2", "s2", "Workspace two");

    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const suggestions = await ProactiveSuggestionsService.getTopForBriefingForWorkspaces(
      "all",
      ["ws-1", "ws-2"],
      10,
    );

    expect(suggestions.map((s) => s.title).sort()).toEqual(["Workspace one", "Workspace two"]);
    expect(suggestions.map((s) => s.workspaceId).sort()).toEqual(["ws-1", "ws-2"]);
  });
});
