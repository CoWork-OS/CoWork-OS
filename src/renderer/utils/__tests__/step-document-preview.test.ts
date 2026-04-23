import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  extractDocumentPathFromText,
  getStepCompletionPreviewPath,
} from "../step-document-preview";

function makeStepEvent(
  type: TaskEvent["type"],
  description: string,
  message?: string,
): TaskEvent {
  return {
    id: `event-${type}`,
    taskId: "task-1",
    timestamp: Date.now(),
    schemaVersion: 2,
    type,
    payload: {
      step: { id: "step-1", description },
      ...(typeof message === "string" ? { message } : {}),
    },
  };
}

describe("step document preview helpers", () => {
  it("extracts docx path from create_document step text", () => {
    const text =
      "Step complete: Use create_document to create inner_world.docx with the drafted text.";
    expect(extractDocumentPathFromText(text)).toBe("inner_world.docx");
  });

  it("extracts quoted PDF path with uppercase extension", () => {
    const text = 'Generated "reports/final-report.PDF" successfully.';
    expect(extractDocumentPathFromText(text)).toBe("reports/final-report.PDF");
  });

  it("extracts backticked path", () => {
    const text = "Created `docs/spec.docx` in workspace.";
    expect(extractDocumentPathFromText(text)).toBe("docs/spec.docx");
  });

  it("extracts LaTeX source paths", () => {
    const text = "Wrote `papers/codex-app-server-paper.tex` and compiled the PDF.";
    expect(extractDocumentPathFromText(text)).toBe("papers/codex-app-server-paper.tex");
  });

  it("trims trailing punctuation", () => {
    expect(extractDocumentPathFromText("Saved report.pdf, ready to share.")).toBe("report.pdf");
    expect(extractDocumentPathFromText("Saved report.docx.")).toBe("report.docx");
  });

  it("returns preview path for creation-complete step", () => {
    const event = makeStepEvent(
      "step_completed",
      "Use create_document to create inner_world.docx with title/body blocks.",
    );
    expect(getStepCompletionPreviewPath(event)).toBe("inner_world.docx");
  });

  it("returns null for non-creation completion step", () => {
    const event = makeStepEvent(
      "step_completed",
      "Read back inner_world.docx with read_file and confirm expected text.",
    );
    expect(getStepCompletionPreviewPath(event)).toBeNull();
  });
});
