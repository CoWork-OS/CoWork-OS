import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactTabsBar } from "../../components/ArtifactTabsBar";
import {
  MAX_ARTIFACT_TABS,
  addArtifactTab,
  artifactTabLabels,
  confirmLeaveArtifact,
  removeArtifactTab,
  type ArtifactTab,
} from "../artifact-tabs";

const doc = (path: string): ArtifactTab => ({ kind: "document", path });

describe("addArtifactTab", () => {
  it("adds a new file at the end and keeps an open file's place", () => {
    const tabs = addArtifactTab([doc("/w/a.md"), doc("/w/b.md")], doc("/w/c.md"));
    expect(tabs.map((tab) => tab.path)).toEqual(["/w/a.md", "/w/b.md", "/w/c.md"]);
    expect(
      addArtifactTab(tabs, { kind: "webpage", path: "/w/a.md" }).map((tab) => tab.kind),
    ).toEqual(["webpage", "document", "document"]);
  });

  it("drops the oldest tab that isn't showing past the limit", () => {
    let tabs: ArtifactTab[] = [];
    for (let index = 0; index < MAX_ARTIFACT_TABS; index += 1) {
      tabs = addArtifactTab(tabs, doc(`/w/${index}.md`));
    }
    const next = addArtifactTab(tabs, doc("/w/new.md"), "/w/0.md");
    expect(next).toHaveLength(MAX_ARTIFACT_TABS);
    expect(next.map((tab) => tab.path)).toContain("/w/0.md");
    expect(next.map((tab) => tab.path)).not.toContain("/w/1.md");
    expect(next.at(-1)?.path).toBe("/w/new.md");
  });
});

describe("removeArtifactTab", () => {
  const tabs = [doc("/w/a.md"), doc("/w/b.md"), doc("/w/c.md")];
  it("shows the tab to the right, else the one to the left", () => {
    expect(removeArtifactTab(tabs, "/w/b.md").neighbor?.path).toBe("/w/c.md");
    expect(removeArtifactTab(tabs, "/w/c.md").neighbor?.path).toBe("/w/b.md");
    expect(removeArtifactTab([doc("/w/a.md")], "/w/a.md")).toEqual({ tabs: [], neighbor: null });
    expect(removeArtifactTab(tabs, "/w/missing.md").tabs).toHaveLength(3);
  });
});

describe("artifactTabLabels", () => {
  it("adds folders only where two files share a name", () => {
    const labels = artifactTabLabels([
      doc("/w/reports/q1/notes.md"),
      doc("/w/reports/q2/notes.md"),
      doc("/w/budget.xlsx"),
    ]);
    expect([...labels.values()]).toEqual(["q1/notes.md", "q2/notes.md", "budget.xlsx"]);
  });
});

describe("confirmLeaveArtifact", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks only when there are unsaved changes", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    expect(confirmLeaveArtifact("/w/notes.md", false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmLeaveArtifact("/w/notes.md", true)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"notes.md"'));
  });
});

describe("ArtifactTabsBar", () => {
  const render = (tabs: ArtifactTab[], activePath: string) =>
    renderToStaticMarkup(
      React.createElement(ArtifactTabsBar, {
        tabs,
        activePath,
        onSelect: () => {},
        onClose: () => {},
      }),
    );

  it("stays hidden with one file", () => {
    expect(render([doc("/w/a.md")], "/w/a.md")).toBe("");
  });

  it("lists the files with the showing one selected and a close button each", () => {
    const markup = render([doc("/w/a.md"), doc("/w/b.md")], "/w/b.md");
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Close a.md"');
    expect(markup).toContain('aria-label="Close b.md"');
  });
});
