import { describe, expect, it } from "vitest";
import type { TaskEvent, TaskOutputSummary } from "../../../shared/types";
import { findLatexPdfPair } from "../latex-artifacts";

function event(type: TaskEvent["type"], payload: Record<string, unknown>): TaskEvent {
  return {
    id: `${type}-1`,
    taskId: "task-1",
    type,
    timestamp: Date.now(),
    payload,
  } as TaskEvent;
}

describe("latex artifact pairing", () => {
  it("pairs compiled PDFs with sourcePath metadata from artifact events", () => {
    const pair = findLatexPdfPair([
      event("artifact_created", {
        path: "paper.pdf",
        sourcePath: "paper.tex",
        mimeType: "application/pdf",
      }),
    ]);

    expect(pair).toEqual({ sourcePath: "paper.tex", pdfPath: "paper.pdf" });
  });

  it("falls back to matching same-folder basenames in output summaries", () => {
    const outputSummary: TaskOutputSummary = {
      created: ["docs/paper.tex", "docs/paper.pdf"],
      primaryOutputPath: "docs/paper.pdf",
      outputCount: 2,
      folders: ["docs"],
    };

    expect(findLatexPdfPair([], outputSummary)).toEqual({
      sourcePath: "docs/paper.tex",
      pdfPath: "docs/paper.pdf",
    });
  });

  it("does not pair unrelated TeX and PDF files", () => {
    const outputSummary: TaskOutputSummary = {
      created: ["paper.tex", "slides.pdf"],
      primaryOutputPath: "slides.pdf",
      outputCount: 2,
      folders: ["."],
    };

    expect(findLatexPdfPair([], outputSummary)).toBeNull();
  });
});
