import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCOpsTab } from "../MCOpsTab";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPlannerTab() {
  const data = {
    opsSubTab: "planner",
    setOpsSubTab: vi.fn(),
    selectedCompany: { id: "company-one" },
    plannerConfig: {
      enabled: false,
      autoDispatch: false,
      intervalMinutes: 60,
      planningWorkspaceId: null,
      plannerAgentRoleId: null,
      approvalPreset: "manual",
    },
    plannerRuns: [],
    plannerRunning: false,
    plannerSaving: false,
    plannerLoading: false,
    selectedPlannerRunId: null,
    setSelectedPlannerRunId: vi.fn(),
    selectedPlannerRun: null,
    plannerRunIssues: [],
    workspaces: [],
    agents: [],
    handlePlannerConfigChange: vi.fn(),
    handleRunPlanner: vi.fn(),
    setSelectedIssueId: vi.fn(),
    setDetailPanel: vi.fn(),
    formatRelativeTime: vi.fn(),
    selectedIssueId: null,
  } as any;

  return renderToStaticMarkup(<MCOpsTab data={data} />);
}

describe("Mission Control browser planner controls", () => {
  it("disables planner actions and explains unavailable host services", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: {} },
    });

    const markup = renderPlannerTab();

    expect(markup).toContain("Planner settings are not available in this browser session.");
    expect(markup).toContain("Planner run history is not available in this browser session.");
    expect(markup).toMatch(/<input type="checkbox" disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Run Planner<\/button>/);
    expect(markup).toContain('title="Planner execution is not available in this browser session."');
  });

  it("keeps planner actions enabled in the native desktop app", () => {
    vi.stubGlobal("window", {});

    const markup = renderPlannerTab();

    expect(markup).not.toContain("Planner settings are not available");
    expect(markup).not.toContain("Planner run history is not available");
    expect(markup).toMatch(/<input type="checkbox"\/>/);
    expect(markup).toMatch(/<button[^>]*>Run Planner<\/button>/);
  });
});
