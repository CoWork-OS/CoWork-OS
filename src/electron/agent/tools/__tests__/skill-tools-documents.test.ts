import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as mammoth from "mammoth";
import type { Workspace } from "../../../../shared/types";
import { parsePdfBuffer } from "../../../utils/pdf-parser";
import { SkillTools } from "../skill-tools";

// Render decks with pptxgenjs; the artifact-tool runtime is machine-specific.
vi.mock("../../../utils/codex-artifact-tool-runtime", () => ({
  resolveCodexArtifactToolRuntime: vi.fn(async () => null),
}));

const tempDirs: string[] = [];

function makeWorkspace(): Workspace {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-documents-"));
  tempDirs.push(directory);
  return {
    id: "workspace-1",
    name: "Workspace",
    path: directory,
    createdAt: Date.now(),
    permissions: { read: true, write: true, delete: true, network: false, shell: false },
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SkillTools document results", () => {
  it("create_document counts the blocks it wrote and reports the ones it could not", async () => {
    const workspace = makeWorkspace();
    const daemon = { logEvent: vi.fn() } as Any;
    const tools = new SkillTools(workspace, daemon, "task-1");

    const result = await tools.createDocument({
      filename: "report",
      format: "docx",
      content: [
        { type: "heading", text: "Q3 Report", level: 1 },
        {
          type: "table",
          rows: [
            ["Region", "Revenue"],
            ["EMEA", "1200"],
          ],
        },
        { type: "list", items: ["Hire 2 engineers"] },
        { type: "paragraph", text: "" },
      ],
    });

    expect(result.contentBlocks).toBe(3);
    expect(result.requestedBlocks).toBe(4);
    expect(result.droppedBlocks).toEqual([{ index: 3, type: "paragraph", reason: "no text" }]);
    expect(result.warnings).toEqual(["Content block 4 (paragraph) was not written: no text."]);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "file_created",
      expect.objectContaining({ path: "report.docx", contentBlocks: 3 }),
    );
  });

  it("create_document writes the exact requested file names for a DOCX and PDF pair", async () => {
    const workspace = makeWorkspace();
    const daemon = { logEvent: vi.fn() } as Any;
    const tools = new SkillTools(workspace, daemon, "task-1");
    const content = [
      { type: "heading", text: "Northstar", level: 1 },
      { type: "paragraph", text: "Overview." },
      { type: "page_break" },
      { type: "heading", text: "Responsibilities", level: 1 },
    ];

    const docx = await tools.createDocument({
      filename: "Northstar-brief.docx",
      format: "docx",
      content,
      pageNumbers: true,
    });
    const pdf = await tools.createDocument({
      filename: "Northstar-brief.pdf",
      format: "pdf",
      content,
      pageNumbers: true,
    });

    expect(docx.path).toBe("Northstar-brief.docx");
    expect(pdf.path).toBe("Northstar-brief.pdf");
    expect(fs.readdirSync(workspace.path).sort()).toEqual([
      "Northstar-brief.docx",
      "Northstar-brief.pdf",
    ]);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "file_created",
      expect.objectContaining({ path: "Northstar-brief.pdf", format: "pdf" }),
    );
  });

  it("create_document reports the PDF page count and whether it fits maxPages", async () => {
    const workspace = makeWorkspace();
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
    const content = [
      { type: "heading", text: "Brief", level: 1 },
      { type: "paragraph", text: "Overview." },
      { type: "page_break" },
      { type: "paragraph", text: "Details." },
    ];

    const plain = await tools.createDocument({ filename: "plain.pdf", format: "pdf", content });
    expect(plain.pageCount).toBe(2);
    expect(plain.fittedToMaxPages).toBeUndefined();

    const fits = await tools.createDocument({
      filename: "fits.pdf",
      format: "pdf",
      content,
      maxPages: 2,
    });
    expect(fits).toMatchObject({ pageCount: 2, fittedToMaxPages: true });
    expect(fits.warnings).toBeUndefined();

    const over = await tools.createDocument({
      filename: "over.pdf",
      format: "pdf",
      content,
      maxPages: 1,
    });
    expect(over).toMatchObject({ success: true, pageCount: 2, fittedToMaxPages: false });
    expect(over.warnings?.join("\n")).toMatch(/The PDF has 2 pages, more than maxPages 1/);

    await expect(
      tools.createDocument({ filename: "bad.pdf", format: "pdf", content, maxPages: 0 }),
    ).rejects.toThrow(/maxPages/);
    expect(fs.existsSync(path.join(workspace.path, "bad.pdf"))).toBe(false);
  });

  it("create_document does not claim a DOCX page count", async () => {
    const workspace = makeWorkspace();
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
    const content = [{ type: "paragraph", text: "Body." }];

    const docx = await tools.createDocument({
      filename: "brief.docx",
      format: "docx",
      content,
      maxPages: 2,
    });
    expect(docx.pageCount).toBeUndefined();
    expect(docx.fittedToMaxPages).toBeUndefined();
    expect(docx.pageCountNote).toMatch(/not measured/);

    const plain = await tools.createDocument({ filename: "plain.docx", format: "docx", content });
    expect(plain.pageCountNote).toBeUndefined();
  });

  it("create_document only appends a missing extension and rejects a conflicting one", async () => {
    const workspace = makeWorkspace();
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
    const content = [{ type: "paragraph", text: "Body." }];

    expect((await tools.createDocument({ filename: "brief", format: "pdf", content })).path).toBe(
      "brief.pdf",
    );
    expect(
      (await tools.createDocument({ filename: "Brief.PDF", format: "pdf", content })).path,
    ).toBe("Brief.PDF");
    expect(
      (await tools.createDocument({ filename: "notes.v2", format: "docx", content })).path,
    ).toBe("notes.v2.docx");
    // The extension states the format when the format is left out.
    expect((await tools.createDocument({ filename: "memo.docx", content } as Any)).path).toBe(
      "memo.docx",
    );
    await expect(
      tools.createDocument({ filename: "report.docx", format: "pdf", content }),
    ).rejects.toThrow('Use filename "report.pdf"');
    expect(fs.existsSync(path.join(workspace.path, "report.docx.pdf"))).toBe(false);
  });

  it("create_presentation reports the slides written and why the deck differs from the request", async () => {
    const workspace = makeWorkspace();
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");

    const result = await tools.createPresentation({
      filename: "review",
      slides: [
        { title: "Review", layout: "title" },
        {
          title: "Agenda",
          content: Array.from({ length: 12 }, (_, index) => `Topic ${index + 1}`),
        },
      ],
    });

    expect(fs.existsSync(path.join(workspace.path, "review.pptx"))).toBe(true);
    expect(result.slideCount).toBe(3);
    expect(result.warnings?.join("\n")).toMatch(/Slide 2 "Agenda" needed 2 slides/);
  });

  describe("create_document with formats", () => {
    const briefContent = [
      { type: "heading", text: "Briefing Northstar", level: 1 },
      { type: "paragraph", text: "Piloto de onboarding com início a 26 de outubro de 2026." },
      {
        type: "table",
        rows: [
          ["Sessão", "Data"],
          ["Orientação", "26 out"],
          ["Perguntas comuns", "28 out"],
        ],
      },
      { type: "page_break" },
      { type: "heading", text: "Verbas propostas", level: 1 },
      {
        type: "table",
        rows: [
          ["Rubrica", "Verba proposta"],
          ["Materiais impressos", "€100"],
          ["Legendagem", "€150"],
          ["Reserva", "€100"],
        ],
      },
      { type: "list", items: ["Marta: textos de boas-vindas", "James: verificação de legendas"] },
    ];

    it("writes a DOCX and a PDF with the same text from one call", async () => {
      const workspace = makeWorkspace();
      const daemon = { logEvent: vi.fn() } as Any;
      const tools = new SkillTools(workspace, daemon, "task-1");

      const result = await tools.createDocument({
        filename: "Northstar-brief",
        formats: ["docx", "pdf"],
        content: briefContent,
        pageNumbers: true,
        maxPages: 2,
      });

      expect(result.path).toBe("Northstar-brief.docx");
      expect(result.files).toEqual([
        { path: "Northstar-brief.docx", format: "docx" },
        { path: "Northstar-brief.pdf", format: "pdf", pageCount: 2, fittedToMaxPages: true },
      ]);
      expect(result).toMatchObject({ success: true, pageCount: 2, fittedToMaxPages: true });
      expect(result.pageCountNote).toMatch(/PDF written from the same content/);
      expect(fs.readdirSync(workspace.path).sort()).toEqual([
        "Northstar-brief.docx",
        "Northstar-brief.pdf",
      ]);
      for (const [file, format] of [
        ["Northstar-brief.docx", "docx"],
        ["Northstar-brief.pdf", "pdf"],
      ]) {
        expect(daemon.logEvent).toHaveBeenCalledWith(
          "task-1",
          "file_created",
          expect.objectContaining({ path: file, format, type: "document" }),
        );
      }

      const docxText = (
        await mammoth.extractRawText({ path: path.join(workspace.path, "Northstar-brief.docx") })
      ).value;
      const pdf = await parsePdfBuffer(
        fs.readFileSync(path.join(workspace.path, "Northstar-brief.pdf")),
      );
      expect(pdf.numpages).toBe(2);
      const amounts = (text: string) =>
        text.match(/€\s?\d+/g)?.map((value) => value.replace(/\s/g, ""));
      expect(amounts(docxText)).toEqual(["€100", "€150", "€100"]);
      expect(amounts(pdf.text)).toEqual(amounts(docxText));
      const normalize = (text: string) => text.replace(/\s+/g, " ");
      for (const phrase of [
        "Briefing Northstar",
        "Verbas propostas",
        "26 de outubro de 2026",
        "Marta: textos de boas-vindas",
        "James: verificação de legendas",
      ]) {
        expect(normalize(docxText)).toContain(phrase);
        expect(normalize(pdf.text)).toContain(phrase);
      }
    });

    it("names the files from filenames, or replaces a .docx/.pdf extension on filename", async () => {
      const workspace = makeWorkspace();
      const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
      const content = [{ type: "paragraph", text: "Body." }];

      const derived = await tools.createDocument({
        filename: "brief.pdf",
        formats: ["pdf", "docx"],
        content,
      });
      expect(derived.files.map((file) => file.path)).toEqual(["brief.pdf", "brief.docx"]);

      const named = await tools.createDocument({
        filename: "ignored",
        formats: ["docx", "pdf"],
        filenames: ["Editable brief.docx", "Print brief"],
        content,
      });
      expect(named.files.map((file) => file.path)).toEqual([
        "Editable brief.docx",
        "Print brief.pdf",
      ]);

      const mapped = await tools.createDocument({
        filename: "ignored",
        formats: ["docx", "pdf"],
        filenames: { pdf: "map.pdf", docx: "map.docx" },
        content,
      });
      expect(mapped.files.map((file) => file.path)).toEqual(["map.docx", "map.pdf"]);
    });

    it("rejects formats it cannot write before writing anything", async () => {
      const workspace = makeWorkspace();
      const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
      const content = [{ type: "paragraph", text: "Body." }];

      await expect(
        tools.createDocument({ filename: "x", formats: ["docx", "odt"] as Any, content }),
      ).rejects.toThrow(/Unsupported document format/);
      await expect(tools.createDocument({ filename: "x", formats: [], content })).rejects.toThrow(
        /non-empty array/,
      );
      await expect(
        tools.createDocument({ filename: "x", format: "pdf", formats: ["docx"], content }),
      ).rejects.toThrow(/List every format/);
      await expect(
        tools.createDocument({
          filename: "x",
          formats: ["docx", "pdf"],
          filenames: ["only-one.docx"],
          content,
        }),
      ).rejects.toThrow(/one name per format/);
      await expect(
        tools.createDocument({
          filename: "x",
          formats: ["docx", "pdf"],
          filenames: ["a.docx", "a.docx"],
          content,
        }),
      ).rejects.toThrow(/ends in .docx but format is "pdf"/);
      expect(fs.readdirSync(workspace.path)).toEqual([]);
    });
  });
});
