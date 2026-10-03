import PDFDocument from "pdfkit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { boundedParseSpy, mainThreadParserMock } = vi.hoisted(() => ({
  boundedParseSpy: vi.fn(),
  mainThreadParserMock: vi.fn(async () => {
    throw new Error("PDFs must not be parsed on the main thread");
  }),
}));

// Pass-through spy: the real worker-backed parser runs, but calls are recorded.
vi.mock("../../utils/bounded-pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/bounded-pdf-parser")>();
  boundedParseSpy.mockImplementation(actual.parsePdfBufferBounded);
  return { ...actual, parsePdfBufferBounded: boundedParseSpy };
});

vi.mock("../../utils/pdf-parser", () => ({
  parsePdfBuffer: mainThreadParserMock,
}));

import { PdfParseLimitError } from "../../utils/bounded-pdf-parser";
import { MailboxService } from "../MailboxService";

type ExtractText = (
  row: { filename: string; mime_type: string | null },
  bytes: Buffer,
) => Promise<{ text: string; mode: string }>;

const extractTextFromAttachmentBytes = (
  MailboxService.prototype as unknown as { extractTextFromAttachmentBytes: ExtractText }
).extractTextFromAttachmentBytes;

function createPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(12).text(text);
    doc.end();
  });
}

describe("mailbox PDF attachment text", () => {
  beforeEach(() => {
    boundedParseSpy.mockClear();
    mainThreadParserMock.mockClear();
  });

  it("extracts attachment text in the bounded worker", async () => {
    const pdf = await createPdf("Invoice 2026-114: total due within thirty days.");

    const extracted = await extractTextFromAttachmentBytes.call(
      {},
      { filename: "invoice.pdf", mime_type: "application/pdf" },
      pdf,
    );

    expect(extracted.mode).toBe("pdf-parse");
    expect(extracted.text).toContain("Invoice 2026-114: total due within thirty days.");
    expect(boundedParseSpy).toHaveBeenCalledTimes(1);
    expect(mainThreadParserMock).not.toHaveBeenCalled();
  });

  it("reports an attachment that hits a parse limit as too large or complex", async () => {
    boundedParseSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );

    await expect(
      extractTextFromAttachmentBytes.call(
        {},
        { filename: "bomb.pdf", mime_type: "application/pdf" },
        Buffer.from("%PDF-1.7"),
      ),
    ).rejects.toThrow(
      "PDF attachment is too large or complex to extract (PDF parsing did not finish within 30 seconds).",
    );
  });
});
