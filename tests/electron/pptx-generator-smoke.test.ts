import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generatePPTX } from "../../src/electron/utils/document-generators/pptx-generator";

describe("pptx-generator smoke", () => {
  it("generates a varied editable PPTX package from richer slide definitions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pptx-smoke-"));
    const outputPath = path.join(dir, "varied.pptx");

    const result = await generatePPTX(outputPath, {
      title: "Varied Deck",
      author: "CoWork OS",
      visualMode: "editorial",
      styleBrief: "Use varied editorial structures.",
      brand: { name: "Acme", primaryColor: "#0E7490", accentColor: "#E11D48" },
      slides: [
        { title: "Varied Deck", subtitle: "A non-repetitive editable deck", slideType: "cover" },
        {
          title: "The evidence has a shape",
          slideType: "chart",
          data: {
            categories: ["Alpha", "Beta", "Gamma"],
            series: [{ name: "Index", values: [2, 5, 3] }],
          },
        },
        {
          title: "The comparison is structured",
          slideType: "table",
          data: {
            headers: ["Area", "Status"],
            rows: [
              ["Narrative", "Clear"],
              ["Design", "Varied"],
            ],
          },
        },
        {
          title: "What changes next",
          slideType: "process",
          bullets: ["Frame the story", "Choose the visual role", "Render editable slides"],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.slideCount).toBe(4);
    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slideFiles).toHaveLength(4);
  }, 60_000);
});
