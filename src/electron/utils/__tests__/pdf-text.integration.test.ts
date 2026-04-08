import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it, vi } from "vitest";

const { extractPdfReviewDataMock } = vi.hoisted(() => ({
  extractPdfReviewDataMock: vi.fn(async () => {
    throw new Error("review path should not be used for normal PDFs");
  }),
}));

vi.mock("../pdf-review", async () => {
  const actual = await vi.importActual<typeof import("../pdf-review")>("../pdf-review");
  return {
    ...actual,
    extractPdfReviewData: extractPdfReviewDataMock,
  };
});

import { extractPdfText } from "../pdf-text";

function createSimplePdf(outputPath: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.font("Helvetica").fontSize(12).text(text, { lineGap: 4 });
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

describe("extractPdfText integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("extracts text from a real PDF without depending on the review pipeline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-text-int-"));
    tempDirs.push(dir);
    const pdfPath = path.join(dir, "sample.pdf");

    await createSimplePdf(
      pdfPath,
      "Bonjour tout le monde.\nCe PDF doit etre lu directement par la librairie PDF.",
    );

    const result = await extractPdfText(pdfPath);

    expect(result.extractionMode).toBe("pdf-parse");
    expect(result.usedFallback).toBe(false);
    expect(result.text).toContain("Bonjour tout le monde.");
    expect(extractPdfReviewDataMock).not.toHaveBeenCalled();
  });
});
