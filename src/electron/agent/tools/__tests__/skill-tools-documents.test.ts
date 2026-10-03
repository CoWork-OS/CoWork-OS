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
