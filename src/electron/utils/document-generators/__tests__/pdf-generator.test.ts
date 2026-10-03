import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// generatePDF also probes `default` and `playwright` for the chromium export.
const { playwright } = vi.hoisted(() => ({
  playwright: { chromium: undefined as unknown, default: undefined, playwright: undefined },
}));
vi.mock("playwright", () => playwright);

import { generatePDF } from "../pdf-generator";

const tempDirs: string[] = [];
const originalChromePath = process.env.CHROME_PATH;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-generator-"));
  tempDirs.push(dir);
  return dir;
}

/** A stand-in browser that records the HTML it is asked to print. */
function fakeChromium(): { pages: string[] } {
  const pages: string[] = [];
  playwright.chromium = {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        setContent: async (html: string) => {
          pages.push(html);
        },
        emulateMedia: async () => undefined,
        pdf: async ({ path: pdfPath }: { path: string }) => {
          fs.writeFileSync(pdfPath, "%PDF-1.7\n");
        },
      }),
      close: async () => undefined,
    })),
  };
  return { pages };
}

beforeEach(() => {
  // Any existing file works: the fake browser never executes it.
  process.env.CHROME_PATH = process.execPath;
  playwright.chromium = undefined;
});

afterEach(() => {
  if (originalChromePath === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = originalChromePath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generatePDF", () => {
  it("renders markdown tables as HTML tables", async () => {
    const { pages } = fakeChromium();
    const outputPath = path.join(makeTempDir(), "report.pdf");

    const result = await generatePDF(outputPath, {
      title: "Q3",
      markdown: [
        "Revenue by region:",
        "",
        "| Region | Revenue | Note |",
        "| --- | ---: | :-: |",
        "| EMEA | 1,200 | **best** |",
        "| APAC | 800 | a \\| b |",
        "",
        "Done.",
      ].join("\n"),
    });

    expect(result).toMatchObject({ success: true, format: "pdf", path: outputPath });
    const html = pages[0];
    expect(html).toContain(
      '<table><thead><tr><th>Region</th><th style="text-align: right">Revenue</th>' +
        '<th style="text-align: center">Note</th></tr></thead>',
    );
    expect(html).toContain(
      '<tr><td>EMEA</td><td style="text-align: right">1,200</td>' +
        '<td style="text-align: center"><strong>best</strong></td></tr>',
    );
    expect(html).toContain('<td style="text-align: center">a | b</td>');
    expect(html).not.toMatch(/<p>\s*\|/);
    expect(html).toContain("<p>Done.</p>");
  });

  it("leaves pipes inside fenced code blocks alone", async () => {
    const { pages } = fakeChromium();
    const outputPath = path.join(makeTempDir(), "code.pdf");

    await generatePDF(outputPath, {
      markdown: ["```", "| a | b |", "| - | - |", "```"].join("\n"),
    });

    expect(pages[0]).not.toContain("<table>");
  });

  it("reports the HTML fallback as a failed PDF instead of a generated document", async () => {
    const outputPath = path.join(makeTempDir(), "report.pdf");

    const result = await generatePDF(outputPath, { markdown: "# Report\nBody" });

    const htmlPath = path.join(path.dirname(outputPath), "report.html");
    expect(result).toMatchObject({ success: false, format: "html", path: htmlPath });
    expect(result.error).toMatch(/Playwright/);
    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("names the browser failure when PDF rendering breaks", async () => {
    playwright.chromium = {
      launch: vi.fn(async () => {
        throw new Error("Executable doesn't exist");
      }),
    };
    const outputPath = path.join(makeTempDir(), "report.pdf");

    const result = await generatePDF(outputPath, { markdown: "Body" });

    expect(result).toMatchObject({ success: false, format: "html" });
    expect(result.error).toMatch(/Executable doesn't exist/);
  });
});
