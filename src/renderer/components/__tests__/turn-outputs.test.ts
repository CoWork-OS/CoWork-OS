import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { TaskEvent } from "../../../shared/types";
import {
  buildWrittenFileResolver,
  collectTurnOutputSummaries,
  collectWrittenFilePaths,
  getFinishedTurnAutoOpen,
  isArtifactEventCoveredByFileWrite,
  isScratchOutputPath,
  pickTurnOutputToAutoOpen,
  type TurnOutputSummary,
} from "../MainContent/turn-outputs";
import { TurnOutputsRow, describeTurnOutputs } from "../MainContent/TurnOutputsRow";
import { buildMarkdownComponents } from "../markdown-components";

function makeEvent(
  id: string,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return { id, taskId: "task-1", timestamp: 0, type, payload } as TaskEvent;
}

describe("collectTurnOutputSummaries", () => {
  it("gives each finished turn one summary of the files it created", () => {
    const events = [
      makeEvent("prompt", "user_message", { message: "Make a report" }),
      makeEvent("doc", "file_created", { path: "out/report.docx" }),
      makeEvent("doc-again", "artifact_created", { path: "/work/out/report.docx" }),
      makeEvent("answer", "assistant_message", { message: "Done: out/report.docx" }),
      makeEvent("follow-up", "user_message", { message: "Add a sheet" }),
      makeEvent("sheet", "file_created", { path: "out/data.xlsx" }),
      makeEvent("answer-2", "assistant_message", { message: "Added out/data.xlsx" }),
    ];

    expect(collectTurnOutputSummaries(events, { isTaskWorking: false })).toEqual([
      {
        key: "prompt",
        files: [{ path: "out/report.docx", action: "created" }],
        startIndex: 0,
        endIndex: 3,
      },
      {
        key: "follow-up",
        files: [{ path: "out/data.xlsx", action: "created" }],
        startIndex: 4,
        endIndex: 6,
      },
    ]);
  });

  it("leaves the running turn without a summary so the line never moves mid-turn", () => {
    const events = [
      makeEvent("prompt", "user_message"),
      makeEvent("doc", "file_created", { path: "report.md" }),
      makeEvent("follow-up", "user_message"),
      makeEvent("sheet", "file_created", { path: "data.xlsx" }),
    ];

    expect(
      collectTurnOutputSummaries(events, { isTaskWorking: true }).map((summary) => summary.key),
    ).toEqual(["prompt"]);
  });

  it("does not list files a turn only mentioned in prose", () => {
    const events = [
      makeEvent("prompt", "user_message"),
      makeEvent("answer", "assistant_message", {
        message: "I read input/brief.docx and planned out/report.pptx.",
      }),
    ];

    expect(collectTurnOutputSummaries(events, { isTaskWorking: false })).toEqual([]);
  });

  it("lists edited files only when the turn created nothing", () => {
    const editOnly = [
      makeEvent("prompt", "user_message"),
      makeEvent("edit", "file_modified", { path: "budget.xlsx" }),
    ];
    const createAndEdit = [
      makeEvent("prompt", "user_message"),
      makeEvent("edit", "file_modified", { path: "budget.xlsx" }),
      makeEvent("new", "file_created", { path: "summary.md" }),
    ];

    expect(collectTurnOutputSummaries(editOnly, { isTaskWorking: false })[0].files).toEqual([
      { path: "budget.xlsx", action: "updated" },
    ]);
    expect(collectTurnOutputSummaries(createAndEdit, { isTaskWorking: false })[0].files).toEqual([
      { path: "summary.md", action: "created" },
    ]);
  });

  it("skips directories and the agent's scratch files", () => {
    const events = [
      makeEvent("prompt", "user_message"),
      makeEvent("dir", "file_created", { path: "out", type: "directory" }),
      makeEvent("tmp", "file_created", { path: "/tmp/build_report.py" }),
      makeEvent("scratch", "file_created", { path: ".cowork/notes/plan.md" }),
      makeEvent("lock", "file_created", { path: "out/~$report.docx" }),
      makeEvent("real", "file_created", { path: "out/report.docx" }),
    ];

    expect(collectTurnOutputSummaries(events, { isTaskWorking: false })[0].files).toEqual([
      { path: "out/report.docx", action: "created" },
    ]);
  });
});

describe("pickTurnOutputToAutoOpen", () => {
  const turn = (files: TurnOutputSummary["files"]): TurnOutputSummary => ({
    key: "turn",
    files,
    startIndex: 0,
    endIndex: 1,
  });

  it("opens the turn's one new file that has a side-panel viewer", () => {
    expect(
      pickTurnOutputToAutoOpen(
        turn([
          { path: "build.py", action: "created" },
          { path: "out/report.docx", action: "created" },
        ]),
      ),
    ).toBe("out/report.docx");
  });

  it("opens nothing for edits, several viewable files, or files without a viewer", () => {
    expect(pickTurnOutputToAutoOpen(turn([{ path: "budget.xlsx", action: "updated" }]))).toBeNull();
    expect(
      pickTurnOutputToAutoOpen(
        turn([
          { path: "report.docx", action: "created" },
          { path: "deck.pptx", action: "created" },
        ]),
      ),
    ).toBeNull();
    expect(pickTurnOutputToAutoOpen(turn([{ path: "chart.png", action: "created" }]))).toBeNull();
  });
});

describe("getFinishedTurnAutoOpen", () => {
  const events = [
    makeEvent("prompt", "user_message"),
    makeEvent("doc", "file_created", { path: "brief.docx" }),
    makeEvent("follow-up", "user_message"),
    makeEvent("sheet", "file_created", { path: "data.xlsx" }),
    makeEvent("answer", "assistant_message", { message: "Done" }),
  ];

  it("targets the final turn's file, once", () => {
    expect(getFinishedTurnAutoOpen(events, new Set())).toEqual({
      turnKey: "follow-up",
      path: "data.xlsx",
    });
    expect(getFinishedTurnAutoOpen(events, new Set(["follow-up"]))).toBeNull();
  });

  it("does not reach back to an earlier turn when the final turn wrote nothing", () => {
    const quietFollowUp = [
      ...events.slice(0, 2),
      makeEvent("question", "user_message", { message: "What changed?" }),
      makeEvent("reply", "assistant_message", { message: "Nothing." }),
    ];
    expect(getFinishedTurnAutoOpen(quietFollowUp, new Set())).toBeNull();
  });
});

describe("isScratchOutputPath", () => {
  it("keeps workspace deliverables and drops temp and tool directories", () => {
    expect(isScratchOutputPath("reports/q3.pptx")).toBe(false);
    expect(isScratchOutputPath("/Users/alex/project/report.md")).toBe(false);
    expect(isScratchOutputPath("/private/var/folders/x/y/out.csv")).toBe(true);
    expect(isScratchOutputPath("node_modules/pkg/index.js")).toBe(true);
    expect(isScratchOutputPath("tmp/render.html")).toBe(true);
  });
});

describe("buildWrittenFileResolver", () => {
  const events = [
    makeEvent("a", "file_created", { path: "/work/out/report.docx" }),
    makeEvent("b", "file_created", { path: "/work/a/notes.md" }),
    makeEvent("c", "file_created", { path: "/work/b/notes.md" }),
    makeEvent("d", "file_modified", { path: "budget.xlsx" }),
  ];
  const resolve = buildWrittenFileResolver(collectWrittenFilePaths(events));

  it("matches written files by full path, path suffix or unique name", () => {
    expect(resolve("/work/out/report.docx")).toBe("/work/out/report.docx");
    expect(resolve("out/report.docx")).toBe("/work/out/report.docx");
    expect(resolve("report.docx")).toBe("/work/out/report.docx");
    expect(resolve("./budget.xlsx")).toBe("budget.xlsx");
  });

  it("ignores ambiguous names, unknown files and code", () => {
    expect(resolve("notes.md")).toBeNull();
    expect(resolve("a/notes.md")).toBe("/work/a/notes.md");
    expect(resolve("missing.docx")).toBeNull();
    expect(resolve("npm run build")).toBeNull();
  });
});

describe("isArtifactEventCoveredByFileWrite", () => {
  it("hides an emitted artifact whose file write is already in the stream", () => {
    const write = makeEvent("write", "file_created", { path: "/work/report.md" });
    const artifact = makeEvent("artifact", "timeline_artifact_emitted", { path: "report.md" });
    const lone = makeEvent("lone", "artifact_created", { path: "deck.pptx" });

    expect(isArtifactEventCoveredByFileWrite(artifact, [write, artifact])).toBe(true);
    expect(isArtifactEventCoveredByFileWrite(lone, [write, lone])).toBe(false);
    expect(isArtifactEventCoveredByFileWrite(write, [write, artifact])).toBe(false);
  });
});

describe("TurnOutputsRow", () => {
  it("shows a count, at most three files and the rest as a remainder", () => {
    const files = ["a.docx", "b.xlsx", "c.pptx", "d.md"].map((path) => ({
      path,
      action: "created" as const,
    }));
    const markup = renderToStaticMarkup(
      React.createElement(TurnOutputsRow, {
        files,
        workspacePath: "/work",
        onOpenFile: () => undefined,
        onViewAll: () => undefined,
      }),
    );

    expect(markup).toContain("Created 4 files");
    expect(markup).toContain("a.docx");
    expect(markup).toContain("c.pptx");
    expect(markup).not.toContain("d.md");
    expect(markup).toContain("+1 more");
    expect(markup).toContain("View all");
  });

  it("describes edit-only turns as updates", () => {
    expect(describeTurnOutputs([{ path: "budget.xlsx", action: "updated" }])).toBe(
      "Updated 1 file",
    );
  });
});

describe("inline code file chips", () => {
  const render = (markdown: string) =>
    renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        {
          components: buildMarkdownComponents({
            workspacePath: "/work",
            onOpenViewer: () => undefined,
            resolveInlineCodeFilePath: (text) =>
              text === "report.docx" ? "out/report.docx" : null,
          }),
        },
        markdown,
      ),
    );

  it("turns a written file named in inline code into an openable chip", () => {
    const markup = render("Saved `report.docx` for you.");
    expect(markup).toContain('class="clickable-file-path"');
    expect(markup).toContain('href="out/report.docx"');
  });

  it("leaves other inline code and code inside links alone", () => {
    expect(render("Run `npm test`.")).not.toContain("clickable-file-path");
    const linked = render("[`report.docx`](out/report.docx)");
    expect(linked.match(/clickable-file-path"/g)).toHaveLength(1);
  });
});
