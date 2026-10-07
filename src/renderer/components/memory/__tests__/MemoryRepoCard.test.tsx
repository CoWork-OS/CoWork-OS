import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRepoStatusReport } from "../../../../shared/memory-repo-types";
import type { MemoryFeaturesSettings } from "../../../../shared/types";
import { dreamLastLine, dreamNowMessage, dreamScheduleHint } from "../memory-repo-dreams-model";
import {
  MemoryRepoSyncView,
  MemoryRepoTeamView,
  memoryRepoSyncLine,
  syncNowMessage,
  teamRepoDraftProblem,
  teamRepoStatusLine,
  teamRepoWorkspacesLabel,
} from "../MemoryRepoSyncTeam";
import {
  COMPACT_HISTORY_CONFIRM,
  compactHistoryConfirm,
  MemoryRepoCard,
  MemoryRepoDreamingView,
  MemoryRepoLocation,
  memoryRepoBadge,
  memoryRepoErrorMessage,
  memoryRepoStatusLine,
  teamMemorySummary,
  useMemoryRepoController,
} from "../MemoryRepoCard";

/** The memory folder section (and Advanced → Memory folder) around one controller. */
function Folder(props: {
  features: MemoryFeaturesSettings;
  api?: unknown;
  backgroundUpkeepOn?: boolean;
  part?: "card" | "location";
}) {
  const repo = useMemoryRepoController({
    features: props.features,
    onFeaturesSaved: vi.fn(),
    api: (props.api ?? vi.fn()) as never,
  });
  return props.part === "location" ? (
    <MemoryRepoLocation repo={repo} />
  ) : (
    <MemoryRepoCard repo={repo} backgroundUpkeepOn={props.backgroundUpkeepOn ?? true} />
  );
}

const ready: MemoryRepoStatusReport = {
  enabled: true,
  root: "/Users/sam/CoWork Memory",
  ready: true,
  writable: true,
  gitAvailable: true,
  clean: true,
  lastCommitAt: Date.now() - 5 * 60_000,
  entryFileBytes: 800,
  inboxEntries: 0,
  lastWriteError: null,
};

describe("Memory folder card", () => {
  it("renders one folder row: path, state, Open and the switch", () => {
    const api = vi.fn();
    const features = {
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryRepoEnabled: true,
      memoryRepoPath: "/Users/sam/Notes/Memory",
    };
    const html = renderToStaticMarkup(<Folder features={features} api={api} />);
    const row = html.slice(
      html.indexOf('data-testid="memory-repo-folder"'),
      html.indexOf('data-testid="memory-repo-dreaming"'),
    );
    expect(row).toContain("Memory folder");
    expect(row).toContain("<code>/Users/sam/Notes/Memory</code>");
    expect(row).toContain("plain notes you can open and edit");
    expect(row).toContain(">Open</button>");
    expect(row).toMatch(/aria-label="Memory folder"[^>]*checked/);
    // The location and Compact history moved to Advanced.
    expect(html).not.toContain("Compact history");
    expect(html).not.toContain('id="memory-repo-path"');
    // Nothing is loaded during a static render.
    expect(api).not.toHaveBeenCalled();
  });

  it("keeps the folder location and Compact history for Advanced", () => {
    const html = renderToStaticMarkup(
      <Folder
        part="location"
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoPath: "/Users/sam/Notes/Memory",
        }}
      />,
    );
    expect(html).toContain("Folder location");
    expect(html).toContain('value="/Users/sam/Notes/Memory"');
    expect(html).toMatch(/settings-button-danger[^>]*>Compact history/);
  });

  it("labels the folder state with a badge", () => {
    expect(memoryRepoBadge(null).label).toBe("...");
    expect(memoryRepoBadge({ ...ready, enabled: false })).toEqual({
      tone: "neutral",
      label: "Off",
    });
    expect(memoryRepoBadge(ready)).toEqual({ tone: "success", label: "Ready" });
    expect(memoryRepoBadge({ ...ready, gitAvailable: false })).toEqual({
      tone: "warning",
      label: "Check",
    });
  });

  it("describes each state of the folder", () => {
    expect(memoryRepoStatusLine(null).text).toMatch(/Checking/);
    expect(memoryRepoStatusLine({ ...ready, enabled: false })).toMatchObject({ tone: "neutral" });
    expect(
      memoryRepoStatusLine({
        ...ready,
        ready: false,
        problem: "the memory folder is a symbolic link",
      }),
    ).toEqual({ tone: "warning", text: "Not ready: the memory folder is a symbolic link." });
    expect(memoryRepoStatusLine(ready)).toEqual({
      tone: "success",
      text: "Ready; last change 5m ago.",
    });
    expect(memoryRepoStatusLine({ ...ready, gitAvailable: false })).toMatchObject({
      tone: "warning",
      text: expect.stringContaining("git not found"),
    });
    expect(memoryRepoStatusLine({ ...ready, lastWriteError: "busy" }).text).toContain(
      "last write failed: busy",
    );
    expect(memoryRepoStatusLine({ ...ready, clean: false }).text).toContain("not yet committed");
  });

  it("shows main's error message without Electron's prefix", () => {
    expect(
      memoryRepoErrorMessage(
        new Error(
          "Error invoking remote method 'memoryFeatures:saveSettings': Error: the memory folder must be outside every workspace",
        ),
        "fallback",
      ),
    ).toBe("the memory folder must be outside every workspace");
    expect(memoryRepoErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("warns that compacting cannot be undone", () => {
    expect(COMPACT_HISTORY_CONFIRM).toContain(
      "Removes old versions so deleted memories are really gone. This can't be undone.",
    );
  });
});

describe("Memory folder card: Dreaming", () => {
  const dream = {
    id: "d1",
    trigger: "manual" as const,
    status: "completed" as const,
    startedAt: Date.now() - 2 * 60 * 60_000,
    finishedAt: Date.now() - 2 * 60 * 60_000,
    summary: "Tidied lessons.",
    tokens: 3200,
    autoCount: 3,
    undone: false,
    canUndo: true,
    reviewCount: 2,
    reviewStatus: "pending" as const,
    rejected: 0,
    operations: [],
  };
  const report = {
    dreams: [dream],
    tokensUsedToday: 3200,
    dailyBudget: 50_000,
    dreamingEnabled: true,
    folderReady: true,
    pendingReviews: 1,
  };
  const view = (overrides: Partial<Parameters<typeof MemoryRepoDreamingView>[0]> = {}) =>
    renderToStaticMarkup(
      <MemoryRepoDreamingView
        dreamingEnabled
        dailyBudget={50_000}
        report={report}
        ready
        canDreamNow
        backgroundUpkeepOn
        disabled={false}
        dreaming={false}
        message={null}
        onToggle={vi.fn()}
        onDreamNow={vi.fn()}
        {...overrides}
      />,
    );

  it("shows the switch, schedule, budget, today's use, the last dream and Dream now", () => {
    const html = view();
    expect(html).toContain('aria-label="Dreaming"');
    expect(html).toContain(
      "About once a day with your model provider: up to 50,000 tokens/day, 3,200 used in the last 24 hours.",
    );
    expect(html).toContain(
      "Scheduled dreams and commitment closing pause while Background upkeep (Advanced) is off.",
    );
    expect(html).toContain("Last dream 2h ago: 3 applied, 2 waiting for review.");
    expect(html).toContain("Dream now");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Dream now/);
    expect(dreamScheduleHint(20_000, null)).toBe(
      "About once a day with your model provider: up to 20,000 tokens/day.",
    );
  });

  it("says dreaming is paused while Background upkeep is off", () => {
    const html = view({ backgroundUpkeepOn: false });
    expect(html).toContain(">Paused</span>");
    expect(html).toContain(
      "Paused: Background upkeep (Advanced) is off, so scheduled dreams and commitment closing don&#x27;t run.",
    );
  });

  it("disables Dream now while dreaming or when dreaming is off, and shows the result", () => {
    expect(view({ dreaming: true })).toMatch(/<button[^>]*disabled[^>]*>Dreaming\.\.\./);
    expect(view({ dreamingEnabled: false })).toMatch(/<button[^>]*disabled[^>]*>Dream now/);
    expect(view({ canDreamNow: false })).not.toContain("Dream now</button>");
    expect(view({ ready: false })).not.toContain("Last dream");
    expect(
      view({ message: { tone: "error", text: "No dream ran: nothing new since the last dream." } }),
    ).toContain('role="alert"');
  });

  it("describes the last dream and the Dream now result", () => {
    expect(dreamLastLine(null)).toBe("No dream yet.");
    expect(
      dreamLastLine({ ...report, dreams: [{ ...dream, status: "skipped", skipReason: "budget" }] }),
    ).toContain("skipped, today's token budget is used up");
    expect(
      dreamLastLine({
        ...report,
        dreams: [{ ...dream, status: "failed", error: "provider down" }],
      }),
    ).toContain("failed: provider down");
    expect(dreamNowMessage({ ran: true, dream })).toEqual({
      tone: "success",
      text: "Dream finished: 3 changes applied, 2 waiting for review in the Review tab.",
    });
    expect(
      dreamNowMessage({ ran: true, dream: { ...dream, autoCount: 0, reviewCount: 0 } }).text,
    ).toBe("Dream finished: nothing to change.");
    expect(dreamNowMessage({ ran: false, reason: "busy" })).toEqual({
      tone: "error",
      text: "No dream ran: another dream is running.",
    });
    expect(dreamNowMessage({ ran: false, reason: "failed", error: "timeout" }).text).toBe(
      "Dream failed: timeout",
    );
  });

  it("is part of the card while the folder is on", () => {
    const html = renderToStaticMarkup(
      <Folder
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoDreamDailyTokenBudget: 20_000,
        }}
      />,
    );
    expect(html).toContain('data-testid="memory-repo-dreaming"');
    expect(html).toContain("up to 20,000 tokens/day");
    const off = renderToStaticMarkup(
      <Folder
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: false,
        }}
      />,
    );
    expect(off).not.toContain("memory-repo-dreaming");
  });
});

describe("Memory folder card: sync and team memory", () => {
  const sync = {
    remoteUrl: "https://github.com/sam/memory.git",
    lastPullAt: Date.now() - 5 * 60_000,
    lastPushAt: Date.now() - 2 * 60_000,
    ahead: 1,
    behind: 0,
    conflict: null,
    lastError: null,
  };
  const syncProps = {
    savedRemoteUrl: "git@github.com:sam/memory.git",
    confirmed: true,
    folderReady: true,
    sync,
    canSyncNow: true,
    disabled: false,
    syncing: false,
    message: null,
    onSaveRemoteUrl: vi.fn(),
    onConfirmChange: vi.fn(),
    onSyncNow: vi.fn(),
  };

  it("adds the replaced remote history to the compact confirmation when sync is on", () => {
    expect(compactHistoryConfirm(false)).toBe(COMPACT_HISTORY_CONFIRM);
    expect(compactHistoryConfirm(true)).toContain(
      "It also replaces the history of your synced repository.",
    );
  });

  it("renders the sync panel with its explanation, URL, confirmation and Sync now", () => {
    const html = renderToStaticMarkup(<MemoryRepoSyncView {...syncProps} />);
    expect(html).toContain("private git repository you own");
    expect(html).toContain("credential helper or SSH");
    expect(html).toContain("Dream review branches are never pushed");
    expect(html).toContain('value="git@github.com:sam/memory.git"');
    expect(html).toContain("This repository is private and mine");
    expect(html).toContain("Sync now");
    expect(html).not.toContain("Sync stays off until this is checked");
    expect(
      memoryRepoSyncLine({ remoteUrl: "x", confirmed: true, folderReady: true, sync }).text,
    ).toContain(
      "With https://github.com/sam/memory.git; last pull 5m ago; last push 2m ago; 1 to push.",
    );
    const unconfirmed = renderToStaticMarkup(
      <MemoryRepoSyncView {...syncProps} confirmed={false} sync={null} />,
    );
    expect(unconfirmed).toContain("Sync stays off until this is checked");
    expect(
      renderToStaticMarkup(
        <MemoryRepoSyncView
          {...syncProps}
          message={{ tone: "error", text: "URLs with credentials are refused" }}
        />,
      ),
    ).toContain("URLs with credentials are refused");
  });

  it("describes each sync state and the Sync now result", () => {
    const base = { remoteUrl: "x", confirmed: true, folderReady: true, sync };
    expect(memoryRepoSyncLine({ ...base, remoteUrl: "" }).text).toMatch(/^Off/);
    expect(memoryRepoSyncLine({ ...base, sync: null }).text).toMatch(/on and ready/);
    expect(
      memoryRepoSyncLine({ ...base, sync: { ...sync, conflict: "MEMORY.md changed" } }),
    ).toMatchObject({ tone: "warning", text: expect.stringContaining("Sync now") });
    expect(memoryRepoSyncLine({ ...base, sync: { ...sync, lastError: "timeout" } })).toMatchObject({
      tone: "warning",
      text: expect.stringContaining("last error: timeout"),
    });
    expect(syncNowMessage({ error: "Sync is off" })).toEqual({
      tone: "error",
      text: "Sync is off",
    });
    expect(syncNowMessage(sync)).toEqual({ tone: "success", text: "Synced." });
    expect(syncNowMessage({ ...sync, conflict: "c" }).tone).toBe("error");
  });

  it("renders the team section with each repo's workspaces, status and Remove", () => {
    const html = renderToStaticMarkup(
      <MemoryRepoTeamView
        repos={[
          { name: "Platform", path: "/Users/sam/Team/Platform" },
          { name: "Design", path: "/Users/sam/Team/Design", workspaceIds: ["w1", "w2"] },
        ]}
        statuses={[
          {
            name: "Platform",
            root: "/Users/sam/Team/Platform",
            ready: true,
            workspaceIds: [],
            lastPullAt: null,
            lastPullError: null,
          },
          {
            name: "Design",
            root: "/Users/sam/Team/Design",
            ready: false,
            problem: "the folder is not a memory repo (no MEMORY.md)",
            workspaceIds: ["w1", "w2"],
            lastPullAt: null,
            lastPullError: null,
          },
        ]}
        workspaceId="w1"
        disabled={false}
        message={{ tone: "error", text: "Design: Two team repos cannot overlap." }}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain("never writes it");
    expect(html).toContain("every 10 minutes");
    expect(html).toContain("Platform");
    expect(html).toContain("All workspaces");
    expect(html).toContain("2 workspaces");
    expect(html).toContain("Not read: the folder is not a memory repo (no MEMORY.md).");
    expect(html).toContain("Remove");
    expect(html).toContain("Only for this workspace");
    expect(html).toContain("Add a team repo");
    expect(html).toContain("Two team repos cannot overlap.");
  });

  it("hides the add form at three repos and checks a new repo before saving", () => {
    const three = ["A", "B", "C"].map((name) => ({ name, path: `/t/${name}` }));
    const html = renderToStaticMarkup(
      <MemoryRepoTeamView
        repos={three}
        statuses={[]}
        disabled={false}
        message={null}
        onSave={vi.fn()}
      />,
    );
    expect(html).not.toContain("Add a team repo");
    expect(html).toContain("At most 3 team repos");
    expect(teamRepoDraftProblem({ name: "D", path: "/t/D" }, three)).toMatch(/At most 3/);
    expect(teamRepoDraftProblem({ name: "", path: "/t" }, [])).toMatch(/name/);
    expect(teamRepoDraftProblem({ name: "a/b", path: "/t" }, [])).toMatch(/letters/);
    expect(teamRepoDraftProblem({ name: "a", path: "/t" }, [{ name: "A", path: "/x" }])).toMatch(
      /Another/,
    );
    expect(teamRepoDraftProblem({ name: "Team", path: " " }, [])).toMatch(/folder/);
    expect(teamRepoDraftProblem({ name: "Team 1", path: "/t" }, [])).toBeNull();
    expect(teamRepoWorkspacesLabel(undefined)).toBe("All workspaces");
    expect(teamRepoWorkspacesLabel(["w"])).toBe("1 workspace");
    expect(
      teamRepoStatusLine({
        name: "A",
        root: "/t/A",
        ready: true,
        workspaceIds: [],
        lastPullAt: null,
        lastPullError: "not a fast-forward",
      }),
    ).toMatchObject({ tone: "warning", text: expect.stringContaining("not a fast-forward") });
  });

  it("shows Sync and Team memory as rows that open their settings", () => {
    const html = renderToStaticMarkup(
      <Folder
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoRemoteUrl: "https://github.com/sam/memory.git",
          memoryRepoTeamRepos: [{ name: "Platform", path: "/Users/sam/Team" }],
        }}
      />,
    );
    const sync = html.slice(
      html.indexOf('data-testid="memory-repo-sync"'),
      html.indexOf('data-testid="memory-repo-team"'),
    );
    expect(sync).toContain("Off until you confirm the repository is private and yours.");
    expect(sync).toMatch(/aria-expanded="false"[^>]*>Manage<\/button>/);
    // The panel opens on request.
    expect(sync).not.toContain('value="https://github.com/sam/memory.git"');
    const team = html.slice(html.indexOf('data-testid="memory-repo-team"'));
    expect(team).toContain("1 team repo: Platform.");
    expect(team).toContain(">Manage</button>");
    const off = renderToStaticMarkup(
      <Folder
        features={{ contextPackInjectionEnabled: true, heartbeatMaintenanceEnabled: true }}
      />,
    );
    expect(off).not.toContain('data-testid="memory-repo-sync"');
    expect(off).toContain('data-testid="memory-repo-team"');
    expect(off).toContain(">Add</button>");
    expect(teamMemorySummary([])).toMatch(/^None\./);
  });
});
