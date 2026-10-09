import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionControlData } from "../useMissionControlData";
import { MCTopBar } from "../MCTopBar";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTopBar() {
  const data = {
    workspaces: [{ id: "workspace-one", name: "Workspace one" }],
    selectedWorkspaceId: "workspace-one",
    setSelectedWorkspaceId: vi.fn(),
    selectedCompanyId: null,
    activeAgentsCount: 0,
    totalTasksInQueue: 0,
    pendingMentionsCount: 0,
    queueStatusState: "ready",
    runtimeRunningCount: 0,
    runtimeQueuedCount: 0,
    runtimeMaxConcurrent: 1,
    isRefreshing: false,
    handleManualRefresh: vi.fn(),
    selectedWorkspace: { id: "workspace-one" },
    setTeamsOpen: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    selectedCompany: null,
    currentTime: new Date("2026-09-30T12:00:00.000Z"),
    agentContext: { getUiCopy: (key: string) => key },
  } as unknown as MissionControlData;

  return renderToStaticMarkup(<MCTopBar data={data} />);
}

describe("Mission Control browser-only controls", () => {
  it("disables incomplete panels and explains why in a browser session", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: { listTeams: { mutation: false } } },
    });

    const markup = renderTopBar();

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Teams<\/button>/);
    expect(markup).toContain(
      'title="Team management is not available in this browser session yet."',
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Command center summaries");
    expect(markup).toContain("Planner settings");
    expect(markup).toContain("Planner execution");
    expect(markup).toContain("Planner run history");
    expect(markup).toContain("Core harness review data");
  });

  it("keeps the panels enabled in the native desktop app", () => {
    vi.stubGlobal("window", {});

    const markup = renderTopBar();

    expect(markup).toMatch(/<button[^>]*>Teams<\/button>/);
    expect(markup).not.toContain("mc-v2-capability-notice");
  });
});
