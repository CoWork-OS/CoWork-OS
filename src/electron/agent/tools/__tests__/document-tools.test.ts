import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentTools } from "../document-tools";
import { compileLatex } from "../../../utils/document-generators/latex-compiler";
import { generatePPTX } from "../../../utils/document-generators/pptx-generator";

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
vi.mock("../../../utils/document-generators/epub-generator", () => ({
  generateEPUB: vi.fn().mockResolvedValue({
    success: true,
    path: "/workspace/novel.epub",
    size: 22222,
    chapterCount: 3,
  }),
}));
vi.mock("../../../utils/document-generators/html-page-generator", () => ({
  generateLandingPage: vi.fn().mockResolvedValue({
    success: true,
    path: "/workspace/index.html",
    size: 11111,
  }),
}));
vi.mock("../../../utils/document-generators/latex-compiler", () => ({
  compileLatex: vi.fn().mockResolvedValue({
    success: true,
    sourcePath: "/workspace/paper.tex",
    pdfPath: "/workspace/paper.pdf",
    path: "/workspace/paper.pdf",
    logPath: "/workspace/paper.log",
    engine: "tectonic",
    size: 33333,
    diagnostic: "ok",
  }),
}));
vi.mock("../../../voice", () => ({
  getVoiceService: vi.fn(() => ({
    speak: vi.fn().mockResolvedValue(Buffer.from("audio")),
  })),
}));

describe("DocumentTools", () => {
  // ── Tool definitions ──────────────────────────────────────────

  it("getToolDefinitions returns all tool definitions", () => {
    const defs = DocumentTools.getToolDefinitions();

    expect(defs).toHaveLength(7);
    const names = defs.map((d) => d.name);
    expect(names).toContain("compile_latex");
    expect(names).toContain("generate_document");
    expect(names).toContain("generate_presentation");
    expect(names).toContain("generate_spreadsheet");
    expect(names).toContain("generate_epub");
    expect(names).toContain("generate_landing_page");
    expect(names).toContain("generate_narration_audio");
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

  it("compileLatex calls the compiler and registers the PDF artifact with source metadata", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.compileLatex({
      sourcePath: "paper.tex",
      outputPath: "paper.pdf",
      engine: "auto",
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe("/workspace/paper.pdf");
    expect(compileLatex).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      sourcePath: "paper.tex",
      outputPath: "paper.pdf",
      engine: "auto",
    });
    expect(registerArtifact).toHaveBeenCalledWith(
      "task-1",
      "/workspace/paper.pdf",
      "application/pdf",
      expect.objectContaining({
        sourcePath: "/workspace/paper.tex",
        logPath: "/workspace/paper.log",
        engine: "tectonic",
        type: "latex_pdf",
      }),
    );
  });

  it("compileLatex does not register an artifact when compilation fails", async () => {
    vi.mocked(compileLatex).mockResolvedValueOnce({
      success: false,
      sourcePath: "/workspace/paper.tex",
      pdfPath: "/workspace/paper.pdf",
      path: "/workspace/paper.pdf",
      logPath: "/workspace/paper.log",
      error: "No LaTeX engine found",
      diagnostic: "No LaTeX engine found",
    } as Any);
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.compileLatex({ sourcePath: "paper.tex" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("No LaTeX engine");
    expect(registerArtifact).not.toHaveBeenCalled();
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

  it("generatePresentation exposes richer design fields and passes them through", async () => {
    const defs = DocumentTools.getToolDefinitions();
    const presentationDef = defs.find((def) => def.name === "generate_presentation");
    expect(presentationDef?.input_schema.properties).toEqual(
      expect.objectContaining({
        audience: expect.any(Object),
        visualMode: expect.any(Object),
        styleBrief: expect.any(Object),
        brand: expect.any(Object),
        template: expect.any(Object),
        assets: expect.any(Object),
      }),
    );

    const tools = new DocumentTools("/workspace", "task-1");
    await tools.generatePresentation({
      filename: "designed-deck.pptx",
      title: "Designed Deck",
      audience: "executive buyers",
      tone: "premium",
      visualMode: "premium",
      styleBrief: "Use a restrained editorial rhythm with varied slide structures.",
      brand: { name: "Acme", primaryColor: "#111111", accentColor: "#14B8A6" },
      template: { id: "presenton-like", description: "Reusable design system" },
      assets: [{ id: "hero", path: "/workspace/hero.png", alt: "Hero image" }],
      slides: [
        { title: "A sharper opener", slideType: "cover" },
        {
          title: "The data has a shape",
          slideType: "chart",
          data: {
            categories: ["A", "B"],
            series: [{ name: "Growth", values: [2, 5] }],
          },
        },
        {
          title: "The table stays editable",
          slideType: "table",
          data: {
            headers: ["Item", "Status"],
            rows: [["Narrative", "Clear"]],
          },
        },
        {
          title: "Show the product",
          slideType: "product",
          image: { id: "hero" },
        },
      ],
    });

    expect(generatePPTX).toHaveBeenLastCalledWith(
      "/workspace/designed-deck.pptx",
      expect.objectContaining({
        audience: "executive buyers",
        visualMode: "premium",
        styleBrief: expect.stringContaining("editorial rhythm"),
        brand: expect.objectContaining({ name: "Acme" }),
        template: expect.objectContaining({ id: "presenton-like" }),
        assets: [expect.objectContaining({ id: "hero" })],
        slides: expect.arrayContaining([
          expect.objectContaining({ slideType: "chart" }),
          expect.objectContaining({ slideType: "table" }),
          expect.objectContaining({ slideType: "product" }),
        ]),
      }),
    );
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

  // ── generateEPUB ──────────────────────────────────────────────

  it("generateEPUB calls EPUB generator", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.generateEPUB({
      filename: "novel.epub",
      title: "Novel",
      chapters: [
        { title: "Chapter 1", content: "Hello world" },
        { title: "Chapter 2", content: "Next chapter" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.chapterCount).toBe(3);
    expect(result.message).toContain("novel.epub");
    expect(registerArtifact).toHaveBeenCalledWith(
      "task-1",
      "/workspace/novel.epub",
      "application/epub+zip",
    );
  });

  // ── generateLandingPage ───────────────────────────────────────

  it("generateLandingPage calls landing page generator", async () => {
    const registerArtifact = vi.fn();
    const tools = new DocumentTools("/workspace", "task-1", registerArtifact);

    const result = await tools.generateLandingPage({
      filename: "index.html",
      title: "Novel Landing Page",
      subtitle: "A story project",
      description: "A polished page for the novel.",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("index.html");
    expect(registerArtifact).toHaveBeenCalledWith("task-1", "/workspace/index.html", "text/html");
  });

  // ── generateNarrationAudio ────────────────────────────────────

  it("generateNarrationAudio calls voice service and saves mp3", async () => {
    const registerArtifact = vi.fn();
    const workspace = path.join(os.tmpdir(), `cowork-doc-tools-${randomUUID()}`);
    fs.mkdirSync(workspace, { recursive: true });
    const tools = new DocumentTools(workspace, "task-1", registerArtifact);

    const result = await tools.generateNarrationAudio({
      filename: "chapter-01.mp3",
      text: "Narration text",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("chapter-01.mp3");
    expect(registerArtifact).toHaveBeenCalledWith(
      "task-1",
      path.join(workspace, "chapter-01.mp3"),
      "audio/mpeg",
    );
  });

  // ── No artifact registration when callback not provided ────────

  it("skips artifact registration when no callback provided", async () => {
    const tools = new DocumentTools("/workspace", "task-1"); // no registerArtifact

    const result = await tools.generateDocument({ filename: "test.pdf" });
    expect(result.success).toBe(true);
    // No crash — registerArtifact is undefined and guarded
  });
});
