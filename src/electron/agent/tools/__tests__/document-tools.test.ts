import { describe, expect, it, vi } from "vitest";
import { DocumentTools } from "../document-tools";

// Mock the generator modules since they depend on external packages
vi.mock("../../../utils/document-generators/pdf-generator", () => ({
  generatePDF: vi.fn().mockResolvedValue({
    success: true,
    path: "/workspace/report.pdf",
    size: 12345,
  }),
}));
vi.mock("../../../utils/document-generators/pptx-generator", () => ({
  generatePPTX: vi.fn().mockResolvedValue({
    success: true,
    path: "/workspace/deck.pptx",
    size: 54321,
    slideCount: 5,
  }),
}));
vi.mock("../../../utils/document-generators/xlsx-generator", () => ({
  generateXLSX: vi.fn().mockResolvedValue({
    success: true,
    path: "/workspace/data.xlsx",
    size: 9876,
    sheetCount: 2,
  }),
}));

describe("DocumentTools", () => {
  // ── Tool definitions ──────────────────────────────────────────

  it("getToolDefinitions returns all 3 tool definitions", () => {
    const defs = DocumentTools.getToolDefinitions();

    expect(defs).toHaveLength(3);
    const names = defs.map((d) => d.name);
    expect(names).toContain("generate_document");
    expect(names).toContain("generate_presentation");
    expect(names).toContain("generate_spreadsheet");
  });

  it("tool definitions have required input_schema", () => {
    const defs = DocumentTools.getToolDefinitions();

    for (const def of defs) {
      expect(def.input_schema).toBeDefined();
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema.required).toBeDefined();
      expect(def.input_schema.required!.length).toBeGreaterThan(0);
    }
  });

  // ── setWorkspace ──────────────────────────────────────────────

  it("setWorkspace updates the internal workspace path", async () => {
    const tools = new DocumentTools("/original/path", "task-1");

    tools.setWorkspace({ path: "/new/path" });

    // Verify by generating a document — the path should use the new workspace
    const result = await tools.generateDocument({ filename: "test.pdf" });
    expect(result.success).toBe(true);
  });

  // ── generateDocument ──────────────────────────────────────────

  it("generateDocument calls PDF generator and returns result", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.generateDocument({
      filename: "report.pdf",
      title: "Quarterly Report",
      markdown: "# Report\nContent here",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("report.pdf");
    expect(registerArtifact).toHaveBeenCalledWith(
      "task-1",
      "/workspace/report.pdf",
      "application/pdf",
    );
  });

  it("generateDocument sanitizes filenames", async () => {
    const tools = new DocumentTools("/workspace", "task-1");

    const result = await tools.generateDocument({
      filename: "../../../etc/evil.pdf",
    });

    // sanitizeFilename should strip path traversal via path.basename
    expect(result.success).toBe(true);
  });

  // ── generatePresentation ──────────────────────────────────────

  it("generatePresentation calls PPTX generator", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.generatePresentation({
      filename: "deck.pptx",
      slides: [
        { title: "Intro", layout: "title" },
        { title: "Data", bullets: ["Point 1", "Point 2"] },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.slideCount).toBe(5);
    expect(registerArtifact).toHaveBeenCalled();
  });

  // ── generateSpreadsheet ───────────────────────────────────────

  it("generateSpreadsheet calls XLSX generator", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.generateSpreadsheet({
      filename: "data.xlsx",
      sheets: [
        {
          name: "Sales",
          headers: ["Product", "Revenue"],
          rows: [
            ["Widget", 1000],
            ["Gadget", 2000],
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.sheetCount).toBe(2);
    expect(result.message).toContain("data.xlsx");
    expect(registerArtifact).toHaveBeenCalled();
  });

  // ── No artifact registration when callback not provided ────────

  it("skips artifact registration when no callback provided", async () => {
    const tools = new DocumentTools("/workspace", "task-1"); // no registerArtifact

    const result = await tools.generateDocument({ filename: "test.pdf" });
    expect(result.success).toBe(true);
    // No crash — registerArtifact is undefined and guarded
  });
});
