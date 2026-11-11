import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import {
  extractPptxContentFromFile,
  extractPptxStructuredContentFromFile,
} from "../../src/electron/utils/pptx-extractor";

let tempDirs: string[] = [];

async function createTempPptx(slideXml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pptx-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "sample.pptx");
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", slideXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function buildDeck(
  name: string,
  build: (pptx: import("pptxgenjs").default) => void,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pptx-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  build(pptx);
  await pptx.writeFile({ fileName: filePath });
  return filePath;
}

describe("pptx-extractor", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("separates paragraphs without separating styled runs in a title", async () => {
    const file = await createTempPptx(
      "<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Park </a:t></a:r><a:r><a:t>Meetup</a:t></a:r></a:p><a:p><a:r><a:t>Sunday 25 October</a:t></a:r></a:p></p:txBody></p:sp></p:sld>",
    );
    const result = await extractPptxStructuredContentFromFile(file);
    expect(result.slides[0].title).toBe("Park Meetup");
    expect(result.slides[0].text).toBe("Park Meetup\nSunday 25 October");
  });

  it("keeps table cells inside a graphicFrame and the text that follows it", async () => {
    const file = await createTempPptx(
      "<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Morning schedule</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>11:20–11:35</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Water break</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:txBody><a:p><a:r><a:t>Bring gloves</a:t></a:r></a:p></p:txBody></p:sp></p:sld>",
    );
    const result = await extractPptxContentFromFile(file);
    expect(result).toContain("| 11:20–11:35 | Water break |");
    expect(result).toContain("Bring gloves");
    expect(result).not.toContain("[Graphic");
  });

  it("extracts both tables on a slide with two native tables", async () => {
    const deckPath = await buildDeck("two-tables.pptx", (pptx) => {
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
    const deckPath = await buildDeck("chart.pptx", (pptx) => {
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

  it.each(["1000000000", "1e9", "9007199254740993"])(
    "rejects oversized span %s before expansion",
    async (span) => {
      const file = await createTempPptx(
        `<p:sld><a:tbl><a:tr><a:tc><a:txBody><a:p><a:t>Cell</a:t></a:p></a:txBody><a:tcPr><a:gridSpan val=${span}/></a:tcPr></a:tc></a:tr></a:tbl></p:sld>`,
      );
      await expect(extractPptxContentFromFile(file)).rejects.toThrow("span exceeds");
    },
  );
  it("preserves a legitimate merged table", async () => {
    const file = await createTempPptx(
      `<p:sld><a:tbl><a:tr><a:tc><a:txBody><a:p><a:t>Merged</a:t></a:p></a:txBody><a:tcPr><a:gridSpan val="2"/></a:tcPr></a:tc></a:tr></a:tbl></p:sld>`,
    );
    expect(await extractPptxContentFromFile(file)).toContain("Merged");
  });
  it("extracts slide text from pptx files", async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>Hello from slide</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath);
    expect(content).toContain("[PPTX Slides: 1]");
    expect(content).toContain("Hello from slide");
  });

  it("applies output truncation limit when configured", async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>${"A".repeat(500)}</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath, { outputCharLimit: 120 });
    expect(content).toContain("[... Content truncated. Showing first");
  });
});
