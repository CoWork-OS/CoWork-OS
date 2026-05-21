import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySynthesizer } from "../MemorySynthesizer";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { PlaybookService } from "../PlaybookService";
import { MemoryService } from "../MemoryService";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";
import { InputSanitizer } from "../../agent/security/input-sanitizer";
import { UserProfileService } from "../UserProfileService";

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
    getPlaybookForContext: vi.fn().mockReturnValue(
      'PLAYBOOK\n- Task succeeded: "Deploy service" — Used shell, git_commit',
    ),
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
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    buildContextForTask: vi.fn().mockReturnValue(
      "KNOWLEDGE GRAPH\n- [technology] PostgreSQL: Primary database",
    ),
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

  it("produces hot and structured memory without injecting recall hints into the prompt", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("<cowork_hot_memory>");
    expect(result.text).toContain("<cowork_structured_memory>");
    expect(result.text).not.toContain("<cowork_recall_hints>");
    expect(result.fragmentCount).toBeGreaterThan(0);
  });

  it("includes curated hot memory by default", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Curated Hot Memory");
    expect(result.sourceAttribution.curated_memory).toBeGreaterThan(0);
  });

  it("renders operating-profile facts as a personal operating manual", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Personal Operating Manual");
    expect(result.text).toContain("[Operating style] Pushback: challenge weak ideas with evidence.");
    expect(result.text).toContain("You & the User");
    expect(result.text).toContain("[Identity] Preferred name: Alice");
  });

  it("keeps low-confidence conversation-derived operating facts out of hot prompt injection", () => {
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

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Personal Operating Manual");
    expect(result.text).not.toContain("Pushback: challenge weak ideas with evidence.");
    expect(result.text).toContain("[Identity] Preferred name: Alice");
  });

  it("omits L0 hot memory when curated memory is disabled even with wake-up layers on", () => {
    vi.mocked(MemoryFeaturesManager.loadSettings).mockReturnValueOnce({
      curatedMemoryEnabled: false,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      defaultArchiveInjectionEnabled: false,
    } as Any);

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("<cowork_hot_memory>");
    expect(result.text).not.toContain("Curated Hot Memory");
    expect(result.sourceAttribution.curated_memory).toBe(0);
    expect(result.sourceAttribution.user_profile).toBe(0);
    expect(result.sourceAttribution.relationship).toBe(0);
  });

  it("keeps archive recall out of default injection", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Archived Recall");
    expect(result.sourceAttribution.memory).toBe(0);
  });

  it("can include archive recall when the feature flag is enabled", () => {
    (MemoryFeaturesManager.loadSettings as Any).mockReturnValueOnce({
      curatedMemoryEnabled: true,
      sessionRecallEnabled: true,
      topicMemoryEnabled: true,
      verbatimRecallEnabled: true,
      wakeUpLayersEnabled: true,
      defaultArchiveInjectionEnabled: true,
    } as Any);

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("Archived Recall");
    expect(result.sourceAttribution.memory).toBe(0);
  });

  it("includes workspace kit context when enabled", () => {
    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "task", {
      includeWorkspaceKit: true,
    });

    expect(result.text).toContain("Always use TypeScript");
    expect(result.sourceAttribution.workspace_kit).toBe(1);
  });

  it("tracks dropped fragments under a small token budget", () => {
    const result = MemorySynthesizer.buildHotMemoryContext("ws1", 10);

    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("ignores null playbook and knowledge-graph payloads without dropping other context", () => {
    vi.mocked(PlaybookService.getPlaybookForContext).mockReturnValueOnce(null as Any);
    vi.mocked(KnowledgeGraphService.buildContextForTask).mockReturnValueOnce(null as Any);

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).toContain("Recent Summaries");
    expect(result.text).not.toContain("Past Task Patterns");
    expect(result.text).not.toContain("Known Entities");
  });

  it("deduplicates archived recall when recent and search results point to the same memory id", () => {
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

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");
    const archiveMentions = result.text.match(/Use a single archive entry\./g) || [];

    expect(result.sourceAttribution.memory).toBe(1);
    expect(archiveMentions).toHaveLength(1);
  });

  it("uses the sanitizer output when rendering memory fragments", () => {
    vi.mocked(InputSanitizer.sanitizeMemoryContent).mockImplementation(
      (text: string) => text.replace("<script>", "").replace("</script>", ""),
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

    const result = MemorySynthesizer.synthesize("ws1", "/workspace", "Deploy the API");

    expect(result.text).not.toContain("<script>");
    expect(result.text).toContain("alert(1) sanitize me");
  });

  it("builds a wake-up layer preview with only L0/L1 injected by default", () => {
    const preview = MemorySynthesizer.buildLayerPreview("ws1", "/workspace", "Deploy the API");

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
