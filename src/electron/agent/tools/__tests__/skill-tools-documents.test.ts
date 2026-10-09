import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Workspace } from "../../../../shared/types";
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
});
