import {
  LOCAL_PDF_PARSE_LIMITS,
  parsePdfBufferBounded,
  type PdfParseLimits,
} from "./bounded-pdf-parser";

export type LegacyPdfParseResult = {
  text: string;
  numpages?: number;
  info?: { Title?: string; Author?: string };
};

/**
 * Parse PDF bytes into text, page count and Title/Author metadata (the pdf-parse v1 result
 * shape). PDF bytes are untrusted, so this never runs pdf-parse on the calling thread: it parses
 * in a bounded worker and rejects with PdfParseLimitError past the deadline, heap or text limits.
 */
export async function parsePdfBuffer(
  dataBuffer: Uint8Array,
  limits: Partial<PdfParseLimits> = LOCAL_PDF_PARSE_LIMITS,
): Promise<LegacyPdfParseResult> {
  const parsed = await parsePdfBufferBounded(dataBuffer, limits);
  return {
    text: parsed.text,
    numpages: parsed.numpages,
    info:
      parsed.title !== undefined || parsed.author !== undefined
        ? { Title: parsed.title, Author: parsed.author }
        : undefined,
  };
}
