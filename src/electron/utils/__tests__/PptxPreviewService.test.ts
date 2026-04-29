import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PptxPreviewService } from "../PptxPreviewService";

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
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const first = pptx.addSlide();
  first.addText("Intro", { x: 0.6, y: 0.7, w: 6, h: 0.5, fontSize: 28 });
  first.addText("Opening slide", { x: 0.6, y: 1.4, w: 6, h: 0.5, fontSize: 18 });
  first.addNotes("Presenter note A");

  const second = pptx.addSlide();
  second.addText("Findings", { x: 0.6, y: 0.7, w: 6, h: 0.5, fontSize: 28 });
  second.addText("First point\nSecond point", { x: 0.6, y: 1.4, w: 6, h: 1.5, fontSize: 18 });
  second.addNotes("Presenter note B");

  await pptx.writeFile({ fileName: filePath });
}

describe("PptxPreviewService", () => {
  it("returns fast text preview without rendering slide images", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async () => {
        calls.push("artifact-tool");
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "fast",
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("rendering");
    expect(preview.slides[0].text).toContain("Intro");
    expect(preview.slides[0].imageDataUrl).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("extracts structured slide text and speaker notes", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
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
      artifactToolRunner: null,
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

  it("returns cached images during fast preview when render cache exists", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "full",
    });
    const fast = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "fast",
    });

    expect(fast.renderStatus).toBe("cached");
    expect(fast.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(calls).toEqual(["artifact-tool"]);
  });

  it("shares concurrent full render work for the same deck", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    const [first, second] = await Promise.all([
      service.buildPreview({ filePath: deckPath, workspaceRoot: workspace, renderMode: "full" }),
      service.buildPreview({ filePath: deckPath, workspaceRoot: workspace, renderMode: "full" }),
    ]);

    expect(first.renderStatus).toBe("rendered");
    expect(second.renderStatus).toBe("rendered");
    expect(calls).toEqual(["artifact-tool"]);
  });

  it("prefers the Codex presentation renderer when available", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.renderStatus).toBe("rendered");
    expect(preview.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(calls).toEqual(["artifact-tool"]);
  });

  it("falls back to text-only preview when converters fail", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
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
      artifactToolRunner: null,
    });

    await expect(
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/outside the workspace/);
  });
});
