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
