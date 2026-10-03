import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pageTextSpy, pdfjsImportedOnMainThread } = vi.hoisted(() => ({
  pageTextSpy: vi.fn(),
  pdfjsImportedOnMainThread: vi.fn(),
}));

// Pass-through spy: the real worker-backed reader runs, but calls are recorded.
vi.mock("../../utils/bounded-pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/bounded-pdf-parser")>();
  pageTextSpy.mockImplementation(actual.extractPdfPageTextBounded);
  return { ...actual, extractPdfPageTextBounded: pageTextSpy };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  pdfjsImportedOnMainThread();
  throw new Error("pdf.js must not be loaded on the main thread");
});

import { PdfParseLimitError, parsePdfBufferBounded } from "../../utils/bounded-pdf-parser";
import { editPdfRegion } from "../pdf-region-editor";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  pageTextSpy.mockClear();
});

function writePdf(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.font("Helvetica").fontSize(14).text("Quarterly results", 72, 72);
    doc.font("Helvetica").fontSize(10).text("Footer note far below.", 72, 700);
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

describe("editPdfRegion", () => {
  it("reads the selected text with pdf.js in the bounded worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-region-"));
    tempDirs.push(dir);
    const source = path.join(dir, "report.pdf");
    const dest = path.join(dir, "report-edited.pdf");
    await writePdf(source);

    await editPdfRegion({
      sourcePath: source,
      destPath: dest,
      pageIndex: 0,
      bbox: { x: 0.1, y: 0.07, w: 0.6, h: 0.06 },
      instruction: "make the selected text bold",
    });

    expect(pageTextSpy).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      { pageIndexes: [0] },
      expect.objectContaining({ deadlineMs: expect.any(Number) }),
    );
    expect(pdfjsImportedOnMainThread).not.toHaveBeenCalled();
    const edited = await parsePdfBufferBounded(fs.readFileSync(dest));
    // The original run stays under the white-out; the redrawn copy is the extracted selection.
    expect(edited.text.match(/Quarterly results/g)).toHaveLength(2);
    expect(edited.text).not.toContain("selected text");
    expect(edited.text).not.toMatch(/Footer note[\s\S]*Footer note/);
  });

  it("surfaces a parse limit while reading the selection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-region-"));
    tempDirs.push(dir);
    const source = path.join(dir, "report.pdf");
    await writePdf(source);
    pageTextSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );

    await expect(
      editPdfRegion({
        sourcePath: source,
        destPath: path.join(dir, "out.pdf"),
        pageIndex: 0,
        bbox: { x: 0.1, y: 0.07, w: 0.6, h: 0.06 },
        instruction: "make the selected text bold",
      }),
    ).rejects.toBeInstanceOf(PdfParseLimitError);
    expect(fs.existsSync(path.join(dir, "out.pdf"))).toBe(false);
  });
});
