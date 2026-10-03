import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySynthesizer } from "../MemorySynthesizer";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { PlaybookService } from "../PlaybookService";
import { MemoryService } from "../MemoryService";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";
import { InputSanitizer } from "../../agent/security/input-sanitizer";
import { UserProfileService } from "../UserProfileService";
import { BoxSettingsManager } from "../../settings/box-manager";

vi.mock("../CuratedMemoryService", () => ({
  CuratedMemoryService: {
    getPromptEntries: vi.fn().mockReturnValue([
      {
        id: "c1",
        workspaceId: "ws1",
        target: "workspace",
        kind: "workflow_rule",
        content: "Always keep the prompt stack deterministic.",
        confidence: 0.95,
        status: "active",
        createdAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
      },
    ]),
  },
}));

vi.mock("../UserProfileService", () => ({
  UserProfileService: {
    getProfile: vi.fn().mockReturnValue({
      facts: [
        {
          id: "f1",
          category: "identity",
          value: "Preferred name: Alice",
          confidence: 0.95,
          lastUpdatedAt: Date.now() - 60_000,
        },
        {
          id: "f2",
          category: "operating",
          value: "Pushback: challenge weak ideas with evidence.",
          confidence: 0.9,
          lastUpdatedAt: Date.now() - 20_000,
        },
      ],
      updatedAt: Date.now(),
    }),
  },
}));

vi.mock("../RelationshipMemoryService", () => ({
  RelationshipMemoryService: {
    listItems: vi.fn().mockReturnValue([
      {
        id: "r1",
        layer: "commitments",
        text: "Follow up on deployment status",
        confidence: 0.9,
        updatedAt: Date.now() - 30_000,
      },
    ]),
  },
}));

vi.mock("../PlaybookService", () => ({
  PlaybookService: {
    getPlaybookForContext: vi
      .fn()
      .mockReturnValue('PLAYBOOK\n- Task succeeded: "Deploy service" — Used shell, git_commit'),
  },
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    getRecentForPromptRecall: vi.fn().mockReturnValue([
      {
        id: "m1",
        type: "decision",
        summary: "Chose PostgreSQL for persistence.",
        content: "Chose PostgreSQL for persistence.",
        updatedAt: Date.now() - 120_000,
      },
    ]),
    searchForPromptRecall: vi.fn().mockReturnValue([
      {
        id: "m2",
        snippet: "Redis caused too many connections under load.",
        type: "insight",
        createdAt: Date.now() - 90_000,
      },
    ]),
    searchForPromptRecallFast: vi.fn().mockReturnValue([
      {
        id: "m2",
        snippet: "Redis caused too many connections under load.",
        type: "insight",
        createdAt: Date.now() - 90_000,
      },
    ]),
    search: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    buildContextForTask: vi
      .fn()
      .mockReturnValue("KNOWLEDGE GRAPH\n- [technology] PostgreSQL: Primary database"),
  },
}));

vi.mock("../WorkspaceKitContext", () => ({
  buildWorkspaceKitContext: vi.fn().mockReturnValue("### Rules\n- Always use TypeScript"),
}));

vi.mock("../DailyLogSummarizer", () => ({
  DailyLogSummarizer: {
    getRecentSummaryFragments: vi.fn().mockReturnValue([
      {
        key: "daily-1",
        text: "## Daily Summary\n- Important decision: use deterministic prompts",
        relevance: 0.6,
        confidence: 0.75,
        updatedAt: Date.now() - 50_000,
        estimatedTokens: 20,
      },
    ]),
  },
}));

vi.mock("../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: vi.fn().mockReturnValue({
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      defaultArchiveInjectionEnabled: false,
    }),
  },
}));

vi.mock("../../agent/security/input-sanitizer", () => ({
  InputSanitizer: {
    sanitizeMemoryContent: vi.fn((text: string) => text),
  },
}));

describe("MemorySynthesizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces hot and structured memory without injecting recall hints into the prompt", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("<cowork_hot_memory>");
    expect(result.text).toContain("<cowork_structured_memory>");
    expect(result.text).not.toContain("<cowork_recall_hints>");
    expect(result.fragmentCount).toBeGreaterThan(0);
  });

  it("includes curated hot memory by default", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Curated Hot Memory");
    expect(result.sourceAttribution.curated_memory).toBeGreaterThan(0);
  });

  it("injects source-backed Box Brain recall with its Box URL", async () => {
    const settingsSpy = vi.spyOn(BoxSettingsManager, "loadSettings").mockReturnValue({
      enabled: true,
      mcpEnabled: true,
      brain: {
        enabled: true,
        rootFolderId: "123",
        syncIntervalMinutes: 60,
        maxItemsPerRun: 20,
        includeContent: true,
        useBoxAiSummaries: false,
        improvementEnabled: true,
        maxContentChars: 10000,
      },
    });
    vi.mocked(MemoryService.search).mockReturnValue([
      {
        id: "box-memory-1",
        snippet:
          "[Imported from Box Brain] File: Approval Policy.md | Box URL: https://app.box.com/file/123",
        type: "observation",
        relevanceScore: 0.9,
        createdAt: Date.now() - 10_000,
        source: "db",
      },
    ]);

    const result = await MemorySynthesizer.buildStructuredMemoryContext(
      "ws1",
      "/workspace",
      "approval policy",
    );

    expect(result.text).toContain("## Box Brain (source-backed)");
    expect(result.text).toContain("https://app.box.com/file/123");
    expect(result.sourceAttribution.box_brain).toBe(1);
    settingsSpy.mockRestore();
  });

  it("uses prefetched Box Brain hits without a synchronous memory search", async () => {
    const settingsSpy = vi.spyOn(BoxSettingsManager, "loadSettings").mockReturnValue({
      enabled: true,
      mcpEnabled: true,
      brain: {
        enabled: true,
        rootFolderId: "123",
        syncIntervalMinutes: 60,
        maxItemsPerRun: 20,
        includeContent: true,
        useBoxAiSummaries: false,
        improvementEnabled: true,
        maxContentChars: 10000,
      },
    });
    const hit = {
      id: "box-memory-2",
      snippet:
        "[Imported from Box Brain] File: Travel Policy.md | Box URL: https://app.box.com/file/456",
      type: "observation" as const,
      relevanceScore: 0.8,
      createdAt: Date.now() - 5_000,
      source: "db" as const,
    };
    const searchAsync = vi.fn(async () => [hit]);
    (MemoryService as unknown as { searchAsync: typeof searchAsync }).searchAsync = searchAsync;
    vi.mocked(MemoryService.search).mockClear();

    const boxBrainHits = await MemorySynthesizer.prefetchBoxBrainHits("ws1", "travel policy");
    const result = await MemorySynthesizer.buildStructuredMemoryContext(
      "ws1",
      "/workspace",
      "travel policy",
      {
        boxBrainHits,
      },
    );

    expect(searchAsync).toHaveBeenCalledWith("ws1", "travel policy", 8);
    expect(MemoryService.search).not.toHaveBeenCalled();
    expect(result.text).toContain("https://app.box.com/file/456");
    settingsSpy.mockRestore();
  });

  it("renders operating-profile facts as a personal operating manual", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Personal Operating Manual");
    expect(result.text).toContain(
      "[Operating style] Pushback: challenge weak ideas with evidence.",
    );
    expect(result.text).toContain("You & the User");
    expect(result.text).toContain("[Identity] Preferred name: Alice");
  });

  it("keeps low-confidence conversation-derived operating facts out of hot prompt injection", async () => {
    vi.mocked(UserProfileService.getProfile).mockReturnValueOnce({
      facts: [
        {
          id: "f1",
          category: "identity",
          value: "Preferred name: Alice",
          confidence: 0.95,
          source: "conversation",
          firstSeenAt: Date.now() - 60_000,
          lastUpdatedAt: Date.now() - 60_000,
        },
        {
          id: "f2",
          category: "operating",
          value: "Pushback: challenge weak ideas with evidence.",
          confidence: 0.82,
          source: "conversation",
          firstSeenAt: Date.now() - 20_000,
          lastUpdatedAt: Date.now() - 20_000,
        },
      ],
      updatedAt: Date.now(),
    });

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Personal Operating Manual");
    expect(result.text).not.toContain("Pushback: challenge weak ideas with evidence.");
    expect(result.text).toContain("[Identity] Preferred name: Alice");
  });

  it("omits L0 hot memory when curated memory is disabled even with wake-up layers on", async () => {
    vi.mocked(MemoryFeaturesManager.loadSettings).mockReturnValueOnce({
      curatedMemoryEnabled: false,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      defaultArchiveInjectionEnabled: false,
    } as Any);

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("<cowork_hot_memory>");
    expect(result.text).not.toContain("Curated Hot Memory");
    expect(result.sourceAttribution.curated_memory).toBe(0);
    expect(result.sourceAttribution.user_profile).toBe(0);
    expect(result.sourceAttribution.relationship).toBe(0);
  });

  it("keeps archive recall out of default injection", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Archived Recall");
    expect(result.sourceAttribution.memory).toBe(0);
  });

  it("can include archive recall when the feature flag is enabled", async () => {
    (MemoryFeaturesManager.loadSettings as Any).mockReturnValueOnce({
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      defaultArchiveInjectionEnabled: true,
    } as Any);

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Archived Recall");
    expect(result.sourceAttribution.memory).toBe(0);
  });

  it("includes workspace kit context when enabled", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: true,
    });

    expect(result.text).toContain("Always use TypeScript");
    expect(result.sourceAttribution.workspace_kit).toBe(1);
  });

  it("tracks dropped fragments under a small token budget", async () => {
    const result = await MemorySynthesizer.buildHotMemoryContext("ws1", 10);

    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("ignores null playbook and knowledge-graph payloads without dropping other context", async () => {
    vi.mocked(PlaybookService.getPlaybookForContext).mockReturnValueOnce(null as Any);
    vi.mocked(KnowledgeGraphService.buildContextForTask).mockReturnValueOnce(null as Any);

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Recent Summaries");
    expect(result.text).not.toContain("Past Task Patterns");
    expect(result.text).not.toContain("Known Entities");
  });

  it("deduplicates archived recall when recent and search results point to the same memory id", async () => {
    vi.mocked(MemoryFeaturesManager.loadSettings).mockReturnValueOnce({
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: false,
      defaultArchiveInjectionEnabled: true,
    } as Any);
    vi.mocked(MemoryService.getRecentForPromptRecall).mockReturnValueOnce([
      {
        id: "shared-memory",
        type: "decision",
        summary: "Use a single archive entry.",
        content: "Use a single archive entry.",
        updatedAt: Date.now() - 40_000,
      },
    ] as Any);
    vi.mocked(MemoryService.searchForPromptRecallFast).mockReturnValueOnce([
      {
        id: "shared-memory",
        snippet: "Use a single archive entry.",
        type: "decision",
        createdAt: Date.now() - 20_000,
      },
    ] as Any);

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");
    const archiveMentions = result.text.match(/Use a single archive entry\./g) || [];

    expect(result.sourceAttribution.memory).toBe(1);
    expect(archiveMentions).toHaveLength(1);
  });

  it("uses the sanitizer output when rendering memory fragments", async () => {
    vi.mocked(InputSanitizer.sanitizeMemoryContent).mockImplementation((text: string) =>
      text.replace("<script>", "").replace("</script>", ""),
    );
    vi.mocked(MemoryService.getRecentForPromptRecall).mockReturnValueOnce([
      {
        id: "sanitize-1",
        type: "insight",
        summary: "<script>alert(1)</script> sanitize me",
        content: "<script>alert(1)</script> sanitize me",
        updatedAt: Date.now() - 10_000,
      },
    ] as Any);
    vi.mocked(MemoryService.searchForPromptRecallFast).mockReturnValueOnce([] as Any);
    vi.mocked(MemoryFeaturesManager.loadSettings).mockReturnValueOnce({
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: false,
      defaultArchiveInjectionEnabled: true,
    } as Any);

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("<script>");
    expect(result.text).toContain("alert(1) sanitize me");
  });

  it("builds a wake-up layer preview with only L0/L1 injected by default", async () => {
    const preview = await MemorySynthesizer.buildLayerPreview(
      "ws1",
      "/workspace",
      "Deploy the API",
    );

    expect(preview.injectedLayerIds).toEqual(["L0", "L1"]);
    expect(preview.excludedLayerIds).toEqual(["L2", "L3"]);
    expect(preview.layers.find((layer) => layer.layer === "L0")?.includedText).toContain(
      "<cowork_hot_memory>",
    );
    expect(preview.layers.find((layer) => layer.layer === "L3")?.includedText).toContain(
      "search_quotes",
    );
  });
});

describe("MemorySynthesizer prompt budget and routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the kit for the .cowork slice only (project guidance has its own section)", async () => {
    const { buildWorkspaceKitContext } = await import("../WorkspaceKitContext");
    await MemorySynthesizer.synthesize("ws1", "/workspace", "task", { includeWorkspaceKit: true });

    expect(vi.mocked(buildWorkspaceKitContext)).toHaveBeenCalledWith(
      "/workspace",
      "task",
      expect.any(Date),
      expect.objectContaining({ includeProjectGuidance: false }),
    );
  });

  it("keeps the synthesized block within the requested budget with balanced tags", async () => {
    const { buildWorkspaceKitContext } = await import("../WorkspaceKitContext");
    vi.mocked(buildWorkspaceKitContext).mockReturnValueOnce(
      Array.from({ length: 200 }, (_, index) => `- kit rule ${index} ${"k".repeat(40)}`).join("\n"),
    );

    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: true,
      tokenBudget: 400,
    });

    expect(result.totalTokens).toBeLessThanOrEqual(400);
    for (const tag of ["cowork_hot_memory", "cowork_structured_memory"]) {
      const opens = result.text.split(`<${tag}>`).length - 1;
      const closes = result.text.split(`</${tag}>`).length - 1;
      expect(opens).toBe(closes);
    }
  });

  it("adds a short routing hint in the default path naming only visible tools", async () => {
    const result = await MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API", {
      visibleToolNames: ["search_memories", "search_quotes", "read_file"],
    });

    expect(result.text).toContain("<cowork_recall_hints>");
    expect(result.text).toContain("`search_memories`");
    expect(result.text).toContain("`search_quotes`");
    expect(result.text).not.toContain("memory_search_index");
    expect(result.text).not.toContain("search_sessions");
  });

  it("caps the routing hint at 120 tokens and omits it when no memory tool is visible", () => {
    const all = MemorySynthesizer.buildMemoryRoutingHint([
      "search_memories",
      "memory_search_index",
      "memory_timeline",
      "memory_details",
      "search_quotes",
      "search_sessions",
      "memory_curated_read",
      "memory_topics_load",
      "context_grep",
    ]);
    expect(Math.ceil(all.length / 4)).toBeLessThanOrEqual(120);
    expect(all.trim().endsWith("</cowork_recall_hints>")).toBe(true);
    expect(MemorySynthesizer.buildMemoryRoutingHint(["read_file"])).toBe("");
  });

  it("can leave profile facts out of hot memory", async () => {
    const result = await MemorySynthesizer.buildHotMemoryContext("ws1", 900, {
      includeUserProfile: false,
    });

    expect(result.text).toContain("Curated Hot Memory");
    expect(result.text).not.toContain("Preferred name: Alice");
    expect(result.sourceAttribution.user_profile).toBe(0);
  });
});
