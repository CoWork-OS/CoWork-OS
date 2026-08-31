import { describe, expect, it, beforeEach, vi } from "vitest";
import { DailyBriefingService } from "../DailyBriefingService";
import { DailyBriefingServiceDeps } from "../types";

function makeDeps(overrides: Partial<DailyBriefingServiceDeps> = {}): DailyBriefingServiceDeps {
  return {
    getRecentTasks: () => [],
    searchMemory: () => [],
    getActiveSuggestions: () => [],
    getPriorities: () => null,
    getUpcomingJobs: () => [],
    getOpenLoops: () => [],
    log: vi.fn(),
    ...overrides,
  };
}

describe("DailyBriefingService", () => {
  let service: DailyBriefingService;

  beforeEach(() => {
    service = new DailyBriefingService(makeDeps()); // no DB
  });

  // ── Basic generation ──────────────────────────────────────────

  it("generates a briefing with default config", async () => {
    const briefing = await service.generateBriefing("ws-1");

    expect(briefing.id).toBeDefined();
    expect(briefing.workspaceId).toBe("ws-1");
    expect(briefing.generatedAt).toBeGreaterThan(0);
    expect(briefing.delivered).toBe(false);
    expect(Array.isArray(briefing.sections)).toBe(true);
  });

  it("returns latest briefing after generation", async () => {
    await service.generateBriefing("ws-1");
    const latest = service.getLatestBriefing("ws-1");

    expect(latest).toBeDefined();
    expect(latest?.workspaceId).toBe("ws-1");
  });

  // ── Null-safety: getPriorities returns null ────────────────────

  it("handles null getPriorities gracefully", async () => {
    const deps = makeDeps({ getPriorities: () => null });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    // Should not crash — priority section should be empty or absent
    const prioritySection = briefing.sections.find((s) => s.type === "priority_review");
    // Either no section or empty items
    if (prioritySection) {
      expect(prioritySection.items).toHaveLength(0);
    }
  });

  it("handles non-null getPriorities", async () => {
    const deps = makeDeps({
      getPriorities: () => "# Priorities\n- Ship feature A\n- Fix bug B\n- Review PR C",
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const prioritySection = briefing.sections.find((s) => s.type === "priority_review");

    expect(prioritySection).toBeDefined();
    expect(prioritySection!.items.length).toBe(3);
    expect(prioritySection!.items[0].label).toBe("Ship feature A");
  });

  it("compresses low-immediacy priorities behind action-ready work", async () => {
    const deps = makeDeps({
      getPriorities: () =>
        [
          "# Priorities",
          "## Current",
          "- Marketplace — launch a curated marketplace for community plugin packs",
          "- Fix all known P0/P1 bugs",
          "- Review onboarding copy",
          "- Mobile companion — lightweight mobile app or PWA",
          "- Publish launch checklist",
          "- Sustainability — establish a sponsorship program",
        ].join("\n"),
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const prioritySection = briefing.sections.find((s) => s.type === "priority_review");

    expect(prioritySection).toBeDefined();
    expect(prioritySection!.title).toBe("Strategic Priorities");
    expect(prioritySection!.items[0].label).toBe("Fix all known P0/P1 bugs");
    expect(
      prioritySection!.items.some((item) =>
        item.label.includes("lower-immediacy priorities hidden"),
      ),
    ).toBe(true);
  });

  // ── Task summary section ──────────────────────────────────────

  it("builds task summary from recent tasks", async () => {
    const deps = makeDeps({
      getRecentTasks: () => [
        { id: "t1", title: "Deploy API", status: "completed" },
        { id: "t2", title: "Fix auth", status: "completed" },
        { id: "t3", title: "Write docs", status: "failed" },
        { id: "t4", title: "Review PR", status: "pending" },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const taskSection = briefing.sections.find((s) => s.type === "task_summary");

    expect(taskSection).toBeDefined();
    expect(taskSection!.items.length).toBeGreaterThan(0);
    // Should have summary counts + individual task entries
    expect(taskSection!.items.some((i) => i.label.includes("2 completed"))).toBe(true);
    expect(taskSection!.items.some((i) => i.label.includes("1 failed"))).toBe(true);
  });

  it("rolls background automation into counts instead of headline task rows", async () => {
    const deps = makeDeps({
      getRecentTasks: () => [
        { id: "t1", title: "Ship macOS packaging fix", status: "completed" },
        { id: "t2", title: "Subconscious: Project Manager", status: "completed" },
        {
          id: "t3",
          title: "Step completed: Review Recent Heartbeat Outcomes",
          status: "completed",
        },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const taskSection = briefing.sections.find((s) => s.type === "task_summary");

    expect(taskSection).toBeDefined();
    expect(taskSection!.title).toBe("Executive Summary");
    expect(taskSection!.items.some((item) => item.label === "Ship macOS packaging fix")).toBe(true);
    expect(
      taskSection!.items.some((item) =>
        item.label.includes("background automation tasks completed"),
      ),
    ).toBe(true);
    expect(
      taskSection!.items.some((item) => item.label.includes("Subconscious: Project Manager")),
    ).toBe(false);
  });

  // ── Memory highlights section ──────────────────────────────────

  it("includes memory highlights when available", async () => {
    const deps = makeDeps({
      searchMemory: () => [
        { summary: "Learned about caching patterns", type: "workflow_pattern" },
        { content: "Users prefer dark mode over light mode", type: "preference" },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const memSection = briefing.sections.find((s) => s.type === "memory_highlights");

    expect(memSection).toBeDefined();
    expect(memSection!.items).toHaveLength(2);
    expect(memSection!.items[0].label).toContain("Workflow pattern:");
  });

  // ── Suggestions section ────────────────────────────────────────

  it("includes active suggestions", async () => {
    const deps = makeDeps({
      getActiveSuggestions: () => [
        {
          title: "Optimize CI",
          description: "CI takes 8 minutes",
          confidence: 0.84,
          recommendedDelivery: "inbox",
          urgency: "medium",
        },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const sugSection = briefing.sections.find((s) => s.type === "active_suggestions");

    expect(sugSection).toBeDefined();
    expect(sugSection!.title).toBe("Recommended Next Actions");
    expect(sugSection!.items[0].label).toBe("Optimize CI");
    expect(sugSection!.items[0].detail).toContain("CI takes 8 minutes");
  });

  // ── Upcoming jobs section ──────────────────────────────────────

  it("includes upcoming cron jobs", async () => {
    const deps = makeDeps({
      getUpcomingJobs: (_workspaceId) => [
        { name: "Nightly backup", state: { nextRunAtMs: Date.now() + 3600000 } },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const jobsSection = briefing.sections.find((s) => s.type === "upcoming_jobs");

    expect(jobsSection).toBeDefined();
    expect(jobsSection!.items[0].label).toBe("Nightly backup");
  });

  // ── Open loops section ─────────────────────────────────────────

  it("includes open loops", async () => {
    const deps = makeDeps({
      getOpenLoops: () => ["- Follow up on API docs", "* Review security audit"],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const loopsSection = briefing.sections.find((s) => s.type === "open_loops");

    expect(loopsSection).toBeDefined();
    expect(loopsSection!.items[0].label).toBe("Follow up on API docs");
  });

  it("includes awareness digest when awareness summary is available", async () => {
    const deps = makeDeps({
      getAwarenessSummary: async () => ({
        generatedAt: Date.now(),
        workspaceId: "ws-1",
        currentFocus: "VS Code — executor.ts",
        whatChanged: [],
        whatMattersNow: [
          {
            id: "focus-1",
            title: "Editing executor.ts",
            detail: "Recent context shifted into implementation work.",
            source: "tasks",
            score: 0.8,
            tags: ["workflow"],
            requiresHeartbeat: true,
          },
        ],
        dueSoon: [
          {
            id: "due-1",
            title: "Review launch checklist",
            detail: "Due today",
            source: "tasks",
            score: 0.9,
            tags: ["due_soon"],
            requiresHeartbeat: true,
          },
        ],
        beliefs: [],
        wakeReasons: ["focus_shift", "deadline_risk"],
      }),
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const awarenessSection = briefing.sections.find((s) => s.type === "awareness_digest");

    expect(awarenessSection).toBeDefined();
    expect(awarenessSection!.title).toBe("Needs Attention Today");
    expect(
      awarenessSection!.items.some((item) => item.label.includes("Review launch checklist")),
    ).toBe(true);
  });

  it("includes chief-of-staff state in the awareness digest", async () => {
    const deps = makeDeps({
      getAwarenessSummary: async () => ({
        generatedAt: Date.now(),
        workspaceId: "ws-1",
        currentFocus: "Cursor — onboarding.tsx",
        whatChanged: [],
        whatMattersNow: [],
        dueSoon: [],
        beliefs: [],
        wakeReasons: ["focus_shift"],
      }),
      getAutonomyState: async () => ({
        goals: [
          {
            id: "goal-1",
            title: "Ship onboarding redesign",
            status: "active",
            confidence: 0.92,
          },
        ],
        routines: [
          {
            id: "routine-1",
            title: "editor startup",
            description: "Prepare local work context when coding begins.",
          },
        ],
      }),
      getAutonomyDecisions: async () => [
        {
          id: "decision-1",
          title: "Review launch blockers",
          description: "Check the remaining blocker list before shipping the redesign.",
          priority: "normal",
        },
      ],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const awarenessSection = briefing.sections.find((s) => s.type === "awareness_digest");

    expect(awarenessSection).toBeDefined();
    expect(awarenessSection!.title).toBe("Needs Attention Today");
    expect(
      awarenessSection!.items.some((item) =>
        item.label.includes("Active goal: Ship onboarding redesign"),
      ),
    ).toBe(true);
    expect(
      awarenessSection!.items.some((item) =>
        item.label.includes("Decision needed: Review launch blockers"),
      ),
    ).toBe(true);
  });

  it("filters generic app telemetry out of the awareness digest", async () => {
    const deps = makeDeps({
      getAwarenessSummary: async () => ({
        generatedAt: Date.now(),
        workspaceId: "ws-1",
        currentFocus: "All workspaces",
        whatChanged: [],
        whatMattersNow: [
          {
            id: "focus-1",
            title: "Electron",
            detail: "Electron — CoWork OS",
            source: "apps",
            score: 0.8,
            tags: ["focus"],
          },
          {
            id: "focus-2",
            title: "Regression in launch flow",
            detail: "Startup logs still show a native bridge timeout.",
            source: "tasks",
            score: 0.92,
            tags: ["workflow"],
          },
        ],
        dueSoon: [],
        beliefs: [],
        wakeReasons: ["focus_shift"],
      }),
      getAutonomyState: async () => ({
        goals: [],
        routines: [],
      }),
      getAutonomyDecisions: async () => [],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    const awarenessSection = briefing.sections.find((s) => s.type === "awareness_digest");

    expect(awarenessSection).toBeDefined();
    expect(awarenessSection!.items.some((item) => item.label.includes("Electron"))).toBe(false);
    expect(
      awarenessSection!.items.some((item) => item.label.includes("Regression in launch flow")),
    ).toBe(true);
  });

  // ── Config management ─────────────────────────────────────────

  it("returns default config for unknown workspace", () => {
    const config = service.getConfig("unknown-ws");
    expect(config.scheduleTime).toBe("08:00");
    expect(config.enabled).toBe(false);
  });

  it("saves and retrieves config", () => {
    service.saveConfig("ws-1", {
      scheduleTime: "09:30",
      enabledSections: {
        task_summary: true,
        memory_highlights: false,
        active_suggestions: true,
        priority_review: true,
        upcoming_jobs: false,
        open_loops: true,
        awareness_digest: false,
      },
      enabled: true,
    });

    const config = service.getConfig("ws-1");
    expect(config.scheduleTime).toBe("09:30");
    expect(config.enabled).toBe(true);
    expect(config.enabledSections.memory_highlights).toBe(false);
  });

  // ── Error resilience ──────────────────────────────────────────

  it("continues generating even if one section builder throws", async () => {
    const deps = makeDeps({
      getRecentTasks: () => {
        throw new Error("DB connection failed");
      },
      searchMemory: () => [{ summary: "Still works", type: "workflow_pattern" }],
    });
    const svc = new DailyBriefingService(deps);

    const briefing = await svc.generateBriefing("ws-1");
    // task_summary section should be skipped, but others should be present
    expect(briefing.sections.some((s) => s.type === "memory_highlights")).toBe(true);
  });

  // ── Text formatting ────────────────────────────────────────────

  it("generates briefing with proper structure for delivery", async () => {
    const deps = makeDeps({
      getRecentTasks: () => [{ id: "t1", title: "Task A", status: "completed" }],
    });
    const svc = new DailyBriefingService(deps);
    const briefing = await svc.generateBriefing("ws-1");

    expect(briefing.sections.length).toBeGreaterThan(0);
    // Each section should have a title
    for (const section of briefing.sections) {
      expect(section.title).toBeDefined();
      expect(section.title.length).toBeGreaterThan(0);
    }
  });
});
