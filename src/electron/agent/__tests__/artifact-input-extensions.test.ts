import { describe, expect, it } from "vitest";
import {
  inferRequiredArtifactExtensions,
  stripInputFileReferences,
} from "../executor-completion-utils";

const infer = (prompt: string, title = "Task") => inferRequiredArtifactExtensions(title, prompt);

describe("inferRequiredArtifactExtensions input references", () => {
  it("does not require the formats of files named as inputs", () => {
    expect(
      infer("Build a Live Canvas story page from scene-1.png and clip-1.mp4, then export it."),
    ).not.toContain(".mp4");
    expect(infer("Make an illustrated storybook web page from report.pdf.")).not.toContain(".pdf");
    expect(infer("Create a summary using notes.md and the attached data.csv")).not.toEqual(
      expect.arrayContaining([".md", ".csv"]),
    );
    expect(infer("Turn paper.pdf into an interactive explainer and build it.")).not.toContain(
      ".pdf",
    );
    expect(infer("Generate a chart based on sales.xlsx")).not.toContain(".xlsx");
  });

  it("keeps explicit output files and formats", () => {
    expect(infer("Create report.pdf summarizing this quarter.")).toContain(".pdf");
    expect(infer("Read notes.md and save the summary as summary.md")).toContain(".md");
    expect(infer("Write the findings to findings.csv")).toContain(".csv");
    expect(infer("Create a DOCX report for this quarter.")).toContain(".docx");
    expect(infer("Save the results in results.json")).toContain(".json");
  });

  it("keeps the output when input and output formats differ", () => {
    const extensions = infer("Convert notes.md to a PDF and save it as notes.pdf");
    expect(extensions).toContain(".pdf");
    expect(extensions).not.toContain(".md");
  });

  it("still requires an output format the input does not mention", () => {
    const extensions = infer("Create slides.pptx from report.pdf");
    expect(extensions).toContain(".pptx");
    expect(extensions).not.toContain(".pdf");
  });
});

describe("stripInputFileReferences", () => {
  it("removes cited input file names but keeps the verb", () => {
    expect(stripInputFileReferences("build a page from a.png and b.mp4 now")).toBe(
      "build a page from  now",
    );
    expect(stripInputFileReferences("write it based on data.csv")).toBe("write it based on ");
  });

  it("leaves output locations alone", () => {
    const text = "save it in out.md and export to deck.pptx";
    expect(stripInputFileReferences(text)).toBe(text);
  });
});
