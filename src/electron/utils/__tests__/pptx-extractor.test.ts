import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPptxContentFromFile } from "../pptx-extractor";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pptx-extractor-test-"));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function buildDeck(
  filePath: string,
  build: (pptx: import("pptxgenjs").default) => void,
): Promise<void> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  build(pptx);
  await pptx.writeFile({ fileName: filePath });
}

describe("extractPptxContentFromFile", () => {
  it("keeps native table cells and the text that follows the table", async () => {
    const deckPath = path.join(tempRoot, "table-then-text.pptx");
    await buildDeck(deckPath, (pptx) => {
      const slide = pptx.addSlide();
      slide.addText("Quarterly numbers", { x: 0.6, y: 0.4, w: 6, h: 0.5, fontSize: 24 });
      slide.addTable(
        [
          [
            { text: "Region", options: { bold: true } },
            { text: "Revenue", options: { bold: true } },
          ],
          ["EMEA", "42"],
        ],
        { x: 0.6, y: 1.0, w: 6, h: 1.2 },
      );
      slide.addText("Text after the table", { x: 0.6, y: 2.6, w: 6, h: 0.5, fontSize: 18 });
    });

    const content = await extractPptxContentFromFile(deckPath);
    expect(content).toContain("Quarterly numbers");
    expect(content).toContain("Region");
    expect(content).toContain("EMEA");
    expect(content).toContain("42");
    expect(content).toContain("Text after the table");
    expect(content).not.toContain("[Graphic - Table");
  });

  it("extracts both tables on a slide with two native tables", async () => {
    const deckPath = path.join(tempRoot, "two-tables.pptx");
    await buildDeck(deckPath, (pptx) => {
      const slide = pptx.addSlide();
      slide.addTable(
        [
          ["A1", "B1"],
          ["A2", "B2"],
        ],
        { x: 0.6, y: 0.8, w: 3, h: 1.0 },
      );
      slide.addTable(
        [
          ["C1", "D1"],
          ["C2", "D2"],
        ],
        { x: 4.0, y: 0.8, w: 3, h: 1.0 },
      );
    });

    const content = await extractPptxContentFromFile(deckPath);
    for (const cell of ["A1", "B1", "A2", "B2", "C1", "D1", "C2", "D2"]) {
      expect(content).toContain(cell);
    }
  });

  it("still renders a chart as a placeholder", async () => {
    const deckPath = path.join(tempRoot, "chart.pptx");
    await buildDeck(deckPath, (pptx) => {
      const slide = pptx.addSlide();
      slide.addText("Revenue chart", { x: 0.6, y: 0.4, w: 6, h: 0.5, fontSize: 24 });
      slide.addChart(pptx.ChartType.bar, [
        { name: "Revenue", labels: ["Q1", "Q2"], values: [10, 20] },
      ]);
      slide.addText("Chart footnote", { x: 0.6, y: 4.6, w: 6, h: 0.5, fontSize: 14 });
    });

    const content = await extractPptxContentFromFile(deckPath);
    expect(content).toContain("Revenue chart");
    expect(content).toMatch(/\[Chart[^\]]*\]/);
    expect(content).toContain("Chart footnote");
  });
});
