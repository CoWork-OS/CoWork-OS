import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRepoStatusReport } from "../../../../shared/memory-repo-types";
import {
  COMPACT_HISTORY_CONFIRM,
  MemoryRepoCard,
  memoryRepoErrorMessage,
  memoryRepoStatusLine,
} from "../MemoryRepoCard";

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
  it("renders the switch, folder field, explanation and actions", () => {
    const api = vi.fn();
    const html = renderToStaticMarkup(
      <MemoryRepoCard
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoPath: "/Users/sam/Notes/Memory",
        }}
        onFeaturesSaved={vi.fn()}
        api={api as never}
      />,
    );
    expect(html).toContain("Memory folder (beta)");
    expect(html).toContain("plain notes in a folder you can open and edit");
    expect(html).toContain('value="/Users/sam/Notes/Memory"');
    expect(html).toContain("Open memory folder");
    expect(html).toContain("Compact history");
    expect(html).toContain("checked");
    // Nothing is loaded during a static render.
    expect(api).not.toHaveBeenCalled();
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
