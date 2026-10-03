import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePPTX } from "../pptx-generator";
import { extractPptxStructuredContentFromFile } from "../../pptx-extractor";

// Force the pptxgenjs renderer: the bundled artifact-tool runtime only exists on
// machines with a Codex install, and the slide plan both renderers share is
// what these tests pin down.
vi.mock("../../codex-artifact-tool-runtime", () => ({
  resolveCodexArtifactToolRuntime: vi.fn(async () => null),
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pptx-generator-"));
  tempDirs.push(dir);
  return dir;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

async function readSlideXml(filePath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entries = Object.keys(zip.files)
    .map((name) => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => Boolean(entry.match))
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  return Promise.all(entries.map((entry) => zip.file(entry.name)!.async("string")));
}

/** Text runs of each slide, in order. */
async function readSlideRuns(filePath: string): Promise<string[][]> {
  const slides = await readSlideXml(filePath);
  return slides.map((xml) =>
    Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) =>
      decodeXmlText(match[1]),
    ),
  );
}

/**
 * Table rows of the whole deck. The shared PPTX extractor collapses native
 * table frames into a "[Graphic - Table]" marker, so cells are read here.
 */
async function readTableRows(filePath: string): Promise<string[][]> {
  const slides = await readSlideXml(filePath);
  const rows: string[][] = [];
  for (const xml of slides) {
    for (const row of xml.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      rows.push(
        Array.from(row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g), (cell) =>
          Array.from(cell[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (run) =>
            decodeXmlText(run[1]),
          ).join(""),
        ),
      );
    }
  }
  return rows;
}

async function readDeckText(filePath: string): Promise<string> {
  const extracted = await extractPptxStructuredContentFromFile(filePath);
  return extracted.slides.map((slide) => slide.text).join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generatePPTX", () => {
  it("keeps every bullet and table row instead of truncating or re-laying out slides", async () => {
    const outputPath = path.join(makeTempDir(), "review.pptx");
    const agenda = [
      "A1 Results",
      "A2 Pipeline",
      "A3 Hiring",
      "A4 Risks",
      "A5 Budget",
      "A6 Asks",
      "A7 Next steps",
    ];
    const highlights = [
      "H1 Closed 3 enterprise deals",
      "H2 Churn down",
      "H3 NPS up",
      "H4 Launched v2",
      "H5 New region",
      "H6 Partner deal",
    ];
    const challenges = ["C1 Hiring delays", "C2 Infra costs", "C3 Support backlog"];
    const plan = ["P1 Hire 4 SREs", "P2 Cut infra 10 percent", "P3 Clear backlog"];
    const regionRows = Array.from({ length: 9 }, (_, index) => [`R${index + 1}`, index + 1]);

    const result = await generatePPTX(outputPath, {
      title: "Q3 Business Review",
      slides: [
        { title: "Q3 Business Review", subtitle: "Ops team" },
        { title: "Agenda", bullets: agenda },
        { title: "Highlights", bullets: highlights },
        { title: "Challenges", bullets: challenges },
        { title: "Plan", bullets: plan },
        {
          title: "Regional revenue",
          slideType: "table",
          data: { headers: ["Region", "Revenue"], rows: regionRows },
        },
      ],
    });

    const deckText = await readDeckText(outputPath);
    for (const bullet of [...agenda, ...highlights, ...challenges, ...plan]) {
      expect(deckText).toContain(bullet);
    }

    const tableRows = await readTableRows(outputPath);
    for (const [region, revenue] of regionRows) {
      expect(tableRows).toContainEqual([String(region), String(revenue)]);
    }

    const extracted = await extractPptxStructuredContentFromFile(outputPath);
    expect(result.slideCount).toBe(extracted.slideCount);
    expect(result.slideCount).toBeGreaterThan(6);
    expect(result.requestedSlideCount).toBe(6);
    // Continuation slides are reported, not silent.
    expect(result.warnings.join("\n")).toMatch(/Regional revenue/);
  });

  it("does not turn text bullets into KPI numbers", async () => {
    const outputPath = path.join(makeTempDir(), "kpi.pptx");

    await generatePPTX(outputPath, {
      slides: [
        { title: "Quarter review", subtitle: "Board" },
        { title: "Wins", bullets: ["Closed 3 enterprise deals", "Opened Berlin office"] },
        { title: "Revenue growth", bullets: ["H1 Closed 3 enterprise deals", "Churn down"] },
      ],
    });

    const runs = await readSlideRuns(outputPath);
    for (const slideRuns of runs.slice(1)) {
      // Numbers only appear inside the original sentences or as slide numbers.
      const standaloneNumbers = slideRuns.filter((run) => /^[+-]?\d+(\.\d+)?%?$/.test(run.trim()));
      expect(standaloneNumbers.every((run) => /^0\d$/.test(run.trim()))).toBe(true);
    }
    const deckText = runs.flat().join("\n");
    expect(deckText).toContain("H1 Closed 3 enterprise deals");
    expect(deckText).toContain("Closed 3 enterprise deals");
  });

  it("never invents chart values and draws every series it is given", async () => {
    const outputPath = path.join(makeTempDir(), "charts.pptx");

    const result = await generatePPTX(outputPath, {
      slides: [
        { title: "Charts", subtitle: "Data" },
        {
          title: "Growth by quarter",
          slideType: "chart",
          data: { categories: ["Q1", "Q2", "Q3"] },
        },
        {
          title: "Revenue vs cost",
          slideType: "chart",
          data: {
            categories: ["North", "South"],
            series: [
              { name: "Revenue", values: [120, 95] },
              { name: "Cost", values: [70, 61] },
            ],
          },
        },
      ],
    });

    const runs = await readSlideRuns(outputPath);
    const missingData = runs[1];
    expect(missingData).toEqual(expect.arrayContaining(["Q1", "Q2", "Q3"]));
    const invented = missingData.filter(
      (run) => /^[+-]?\d+(\.\d+)?$/.test(run.trim()) && !/^0\d$/.test(run.trim()),
    );
    expect(invented).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/Growth by quarter.*(series|values)/i);

    const twoSeries = runs[2];
    expect(twoSeries).toEqual(
      expect.arrayContaining(["120", "95", "70", "61", "North", "South", "Revenue", "Cost"]),
    );
  });

  it("respects explicit slide types and renders their structured content", async () => {
    const outputPath = path.join(makeTempDir(), "explicit.pptx");
    const tableSlide = (title: string) => ({
      title,
      slideType: "table" as const,
      data: { headers: ["Owner", "Status"], rows: [[`${title} owner`, "On track"]] },
    });

    const result = await generatePPTX(outputPath, {
      slides: [
        { title: "Explicit layouts", slideType: "cover" },
        tableSlide("Table one"),
        tableSlide("Table two"),
        tableSlide("Table three"),
        {
          title: "Customer voice",
          slideType: "quote",
          quote: "The rollout saved our team a week every month.",
          attribution: "Ops lead, Acme",
        },
        {
          title: "Roadmap",
          slideType: "timeline",
          data: {
            items: [
              { label: "Q1", value: "Beta", detail: "Internal users" },
              { label: "Q2", value: "GA", detail: "All customers" },
            ],
          },
        },
        {
          title: "Key numbers",
          slideType: "metric",
          data: { items: [{ label: "ARR", value: "$1.2M", detail: "up from $0.9M" }] },
        },
      ],
    });

    const slidesXml = await readSlideXml(outputPath);
    expect(slidesXml).toHaveLength(7);
    for (const index of [1, 2, 3]) {
      expect(slidesXml[index]).toContain("<a:tbl>");
    }

    const runs = await readSlideRuns(outputPath);
    const quoteText = runs[4].join("\n");
    expect(quoteText).toContain("The rollout saved our team a week every month.");
    expect(quoteText).toContain("Ops lead, Acme");

    const timelineText = runs[5].join("\n");
    for (const value of ["Q1", "Beta", "Internal users", "Q2", "GA", "All customers"]) {
      expect(timelineText).toContain(value);
    }

    const metricText = runs[6].join("\n");
    for (const value of ["$1.2M", "ARR", "up from $0.9M"]) {
      expect(metricText).toContain(value);
    }
    expect(result.warnings).toEqual([]);
  });
});
