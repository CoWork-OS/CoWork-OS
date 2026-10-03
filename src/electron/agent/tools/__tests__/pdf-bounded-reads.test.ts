import * as fs from "fs";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";

const { boundedParseSpy, mainThreadParserMock } = vi.hoisted(() => ({
  boundedParseSpy: vi.fn(),
  mainThreadParserMock: vi.fn(async () => {
    throw new Error("PDFs must not be parsed on the main thread");
  }),
}));

// Pass-through spy: the real worker-backed parser runs, but calls are recorded.
vi.mock("../../../utils/bounded-pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/bounded-pdf-parser")>();
  boundedParseSpy.mockImplementation(actual.parsePdfBufferBounded);
  return { ...actual, parsePdfBufferBounded: boundedParseSpy };
});

vi.mock("../../../utils/pdf-parser", () => ({
  parsePdfBuffer: mainThreadParserMock,
}));

vi.mock("../../security/export-permission-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/export-permission-context")>();
  return {
    ...actual,
    buildSensitiveSourceRefForPath: (_workspace: unknown, filePath: string) => ({
      path: filePath,
      sourceKind: "workspace_native",
      trustLevel: "trusted",
    }),
  };
});

import { PdfParseLimitError } from "../../../utils/bounded-pdf-parser";
import { DocumentParserTools } from "../document-parser-tools";
import { FileTools } from "../file-tools";

function writePdf(outputPath: string, pages: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    pages.forEach((text, index) => {
      if (index > 0) doc.addPage();
      doc.font("Helvetica").fontSize(12).text(text, { lineGap: 4 });
    });
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

/** pdf-parse modules the test process itself has loaded (the workers have their own cache). */
function pdfParseModulesOnMainThread(): string[] {
  const cache = createRequire(import.meta.url).cache;
  return Object.keys(cache).filter((key) => /[\\/]pdf-parse[\\/]/.test(key));
}

const BODY =
  "The regional transit authority reported steady ridership growth across all bus lines this " +
  "quarter, with weekday boardings up eleven percent and weekend service expanding to new routes.";

describe("local PDF reads go through the bounded worker", () => {
  let tmpDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    boundedParseSpy.mockClear();
    mainThreadParserMock.mockClear();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-bounded-")));
    workspace = {
      id: "ws-1",
      name: "Test",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
      isTemp: true,
    } as Workspace;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read_file extracts a normal PDF in the worker, never on the main thread", async () => {
    await writePdf(path.join(tmpDir, "report.pdf"), [BODY, "Appendix: route tables."]);
    const fileTools = new FileTools(
      workspace,
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );

    const out = await fileTools.readFile("report.pdf");

    expect(out.format).toBe("pdf");
    expect(out.content).toContain("[PDF Metadata: Pages: 2 |");
    expect(out.content).toContain("regional transit authority");
    expect(out.content).toContain("Appendix: route tables.");
    expect(out.pdf_extraction).toMatchObject({ status: "complete", mode: "pdf-parse" });
    expect(boundedParseSpy).toHaveBeenCalledTimes(1);
    expect(mainThreadParserMock).not.toHaveBeenCalled();
    expect(pdfParseModulesOnMainThread()).toEqual([]);
  });

  it("parse_document extracts a normal PDF in the worker, never on the main thread", async () => {
    await writePdf(path.join(tmpDir, "report.pdf"), [BODY]);
    const tools = new DocumentParserTools(workspace as Any);

    const result = await tools.parseDocument({ path: "report.pdf" });

    expect(result.content).toContain("regional transit authority");
    expect(result.pdf_extraction).toMatchObject({ status: "complete", page_count: 1 });
    expect(boundedParseSpy).toHaveBeenCalledTimes(1);
    expect(mainThreadParserMock).not.toHaveBeenCalled();
    expect(pdfParseModulesOnMainThread()).toEqual([]);
  });

  it("read_file reports a PDF that hits a parse limit as too large or complex", async () => {
    await writePdf(path.join(tmpDir, "slow.pdf"), [BODY]);
    boundedParseSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );
    const fileTools = new FileTools(
      workspace,
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );

    await expect(fileTools.readFile("slow.pdf")).rejects.toThrow(
      /Failed to read PDF file: slow\.pdf is too large or complex to extract safely \(PDF parsing did not finish within 30 seconds\)\. Do not retry/,
    );
    expect(mainThreadParserMock).not.toHaveBeenCalled();
  });

  it("parse_document reports a PDF that hits a parse limit as too large or complex", async () => {
    await writePdf(path.join(tmpDir, "heavy.pdf"), [BODY]);
    boundedParseSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing exceeded its 512 MB memory limit"),
    );
    const tools = new DocumentParserTools(workspace as Any);

    await expect(tools.parseDocument({ path: "heavy.pdf" })).rejects.toThrow(
      /heavy\.pdf is too large or complex to extract safely \(PDF parsing exceeded its 512 MB memory limit\)/,
    );
    expect(mainThreadParserMock).not.toHaveBeenCalled();
  });
});
