import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
const sidebarPath = fileURLToPath(new URL("../components/Sidebar.tsx", import.meta.url));
const handlersPath = fileURLToPath(new URL("../../electron/ipc/handlers.ts", import.meta.url));

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Sidebar project sessions", () => {
  it("loads each project's sessions by workspace instead of relying on the global page", () => {
    const source = readFileSync(appPath, "utf8");
    const fetcher = sliceBetween(
      source,
      "const fetchSidebarProjectTasks = useCallback(",
      "const loadTasks = useCallback(",
    );

    expect(fetcher).toContain("workspaceId,");
    expect(fetcher).toContain("task.workspaceId === workspaceId");
    expect(source).toContain(
      "onProjectWorkspaceIdsChange={handleSidebarProjectWorkspaceIdsChange}",
    );
  });

  it("replaces project sessions together with the global page on reload", () => {
    const source = readFileSync(appPath, "utf8");
    const loadTasks = sliceBetween(
      source,
      "const loadTasks = useCallback(",
      "const handleSidebarProjectWorkspaceIdsChange",
    );

    // Fetched alongside the global page and merged before the single replace,
    // so archived project sessions drop out instead of being preserved.
    expect(loadTasks).toContain("fetchSidebarProjectTasks(sidebarProjectWorkspaceIdsRef.current)");
    expect(loadTasks).toContain("...projectTasks.filter(");
    expect(loadTasks).not.toContain("projectWorkspaceIds.has(task.workspaceId)");
    expect(loadTasks).toContain("if (sidebarListGenerationRef.current !== generation) return;");
  });

  it("drops stale project fetches and reloads when a project is removed", () => {
    const source = readFileSync(appPath, "utf8");
    const handler = sliceBetween(
      source,
      "const handleSidebarProjectWorkspaceIdsChange = useCallback(",
      "const loadBotConversations = useCallback(",
    );

    expect(handler).toContain("void loadTasks();");
    expect(handler).toContain("sidebarListGenerationRef.current !== generation");
    expect(handler).toContain("appendSidebarTaskPage(prev, loaded)");
  });

  it("reports the folders shown as project groups", () => {
    const source = readFileSync(sidebarPath, "utf8");

    expect(source).toContain("onProjectWorkspaceIdsChange?: (workspaceIds: string[]) => void;");
    expect(source).toContain(
      "prev.onProjectWorkspaceIdsChange === next.onProjectWorkspaceIdsChange",
    );
    expect(source).toContain("onProjectWorkspaceIdsChange?.(");
  });

  it("validates the sidebar workspace filter in the main process", () => {
    const source = readFileSync(handlersPath, "utf8");
    const handler = sliceBetween(
      source,
      "IPC_CHANNELS.TASK_LIST_SIDEBAR,\n",
      "logIpcPerf(IPC_CHANNELS.TASK_LIST_SIDEBAR",
    );

    expect(handler).toContain(
      'validateInput(WorkspaceIdSchema, opts.workspaceId, "sidebar workspace filter")',
    );
    expect(handler).toContain("workspaceId,\n");
  });
});
