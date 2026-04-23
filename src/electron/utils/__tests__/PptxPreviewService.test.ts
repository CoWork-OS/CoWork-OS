import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PptxPreviewService } from "../PptxPreviewService";
import { generatePPTX } from "../document-generators/pptx-generator";

const PNG_BYTES = Buffer.from("presentation-preview");

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pptx-preview-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function createDeck(filePath: string): Promise<void> {
  await generatePPTX(filePath, {
    title: "Preview test deck",
    slides: [
      {
        title: "Intro",
        subtitle: "Opening slide",
        layout: "title",
        notes: "Presenter note A",
      },
      {
        title: "Findings",
        bullets: ["First point", "Second point"],
        layout: "content",
        notes: "Presenter note B",
      },
    ],
  });
}

describe("PptxPreviewService", () => {
  it("extracts structured slide text and speaker notes", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      commandRunner: async () => {
        throw new Error("converter unavailable");
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("text_only");
    expect(preview.slides[0].title).toContain("Intro");
    expect(preview.slides[0].notes).toContain("Presenter note A");
    expect(preview.slides[1].text).toContain("First point");
  });

  it("renders images once and reuses the preview cache", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      commandRunner: async (command, args) => {
        calls.push(command);
        if (command === "soffice") {
          const outDir = String(args[args.indexOf("--outdir") + 1]);
          await fs.writeFile(path.join(outDir, "deck.pdf"), "%PDF");
          return;
        }
        if (command === "pdftoppm") {
          const outputPrefix = String(args[args.length - 1]);
          await fs.writeFile(`${outputPrefix}-1.png`, PNG_BYTES);
          await fs.writeFile(`${outputPrefix}-2.png`, PNG_BYTES);
          return;
        }
      },
    });

    const first = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });
    const second = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(first.renderStatus).toBe("rendered");
    expect(first.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(second.renderStatus).toBe("rendered");
    expect(calls).toEqual(["soffice", "pdftoppm"]);
  });

  it("falls back to text-only preview when converters fail", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      commandRunner: async () => {
        throw new Error("soffice missing");
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.renderStatus).toBe("text_only");
    expect(preview.renderMessage).toContain("soffice missing");
    expect(preview.slides[0].text).toContain("Intro");
  });

  it("rejects files outside the workspace", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const deckPath = path.join(outside, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
    });

    await expect(
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/outside the workspace/);
  });
});
