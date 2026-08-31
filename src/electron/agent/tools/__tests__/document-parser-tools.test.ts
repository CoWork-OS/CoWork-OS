import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { extractPdfTextMock, sensitiveSourceRefMock } = vi.hoisted(() => ({
  extractPdfTextMock: vi.fn(),
  sensitiveSourceRefMock: vi.fn(),
}));

vi.mock("../../../utils/pdf-text", () => ({
  extractPdfText: extractPdfTextMock,
}));

vi.mock("../../security/export-permission-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/export-permission-context")>();
  return {
    ...actual,
    buildSensitiveSourceRefForPath: sensitiveSourceRefMock,
  };
});

import { calculateDocumentWindow, DocumentParserTools } from "../document-parser-tools";

describe("DocumentParserTools", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sensitiveSourceRefMock.mockImplementation((_workspace, filePath) => ({
      path: filePath,
      sourceKind: "workspace_native",
      trustLevel: "trusted",
    }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-document-parser-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the plain PDF text extractor for parse_document", async () => {
    const pdfPath = path.join(tmpDir, "book.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.7"));
    extractPdfTextMock.mockResolvedValue({
      text: "Le texte du livre est clair.",
      pageCount: 4,
      extractionMode: "pdf-parse",
      usedFallback: false,
      previewLimited: false,
      extractionStatus: "complete",
      extractionNote: "complete via embedded text layer; OCR not needed",
    });

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
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
    } as Any);

    const result = await tools.parseDocument({ path: "book.pdf" });

    expect(result.content).toBe("Le texte du livre est clair.");
    expect(result.detected_type).toBe("pdf");
    expect(result.pdf_extraction).toEqual({
      status: "complete",
      mode: "pdf-parse",
      used_fallback: false,
      preview_limited: false,
      note: "complete via embedded text layer; OCR not needed",
      page_count: 4,
    });
    expect(extractPdfTextMock).toHaveBeenCalledWith(fs.realpathSync(pdfPath), {
      includeOcr: true,
      maxFallbackPages: 16,
      maxFallbackCharsPerPage: 1600,
      maxFallbackOcrPages: 4,
    });
  });

  it("rejects missing documents with a clear error", async () => {
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
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
    } as Any);

    await expect(tools.parseDocument({ path: "missing.pdf" })).rejects.toThrow(/file not found/i);
  });

  it("reads plain text documents without using the PDF extractor", async () => {
    const textPath = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(textPath, "Plain text note.");

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
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
    } as Any);

    const result = await tools.parseDocument({ path: "notes.txt" });

    expect(result.content).toBe("Plain text note.");
    expect(result.detected_type).toBe("txt");
    expect(extractPdfTextMock).toHaveBeenCalledTimes(0);
  });

  it("returns lossless continuation metadata for bounded document windows", async () => {
    fs.writeFileSync(path.join(tmpDir, "long.txt"), "0123456789".repeat(30));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
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
    } as Any);

    const windows = [];
    let startChar: number | undefined;
    do {
      const result = await tools.parseDocument({
        path: "long.txt",
        start_char: startChar,
        max_chars: 100,
      });
      windows.push(result);
      startChar = result.next_start_char;
    } while (startChar !== undefined);
    const tail = await tools.parseDocument({
      path: "long.txt",
      start_char: 200,
      max_chars: 100,
    });

    expect(windows[0].window.start).toBe(0);
    expect(windows.at(-1)?.window.end).toBe(300);
    expect(windows.every((result) => result.content.length <= 100)).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].window.start).toBe(windows[index - 1].window.end);
    }
    expect(tail.window).toEqual({ start: 200, end: 300, total: 300 });
    expect(tail.truncated).toBe(false);
    expect(tail.next_start_char).toBeUndefined();
  });

  it("paginates formatted JSON without discarding the remainder", async () => {
    const jsonPath = path.join(tmpDir, "long.json");
    const parsed = {
      records: Array.from({ length: 40 }, (_, index) => ({ index, value: `v-${index}` })),
    };
    fs.writeFileSync(jsonPath, JSON.stringify(parsed));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    } as Any);

    const source = JSON.stringify(parsed, null, 2);
    let reconstructed = "";
    let startChar: number | undefined;
    do {
      const result = await tools.parseDocument({
        path: jsonPath,
        max_chars: 100,
        start_char: startChar,
      });
      reconstructed += source.slice(result.window.start, result.window.end);
      startChar = result.next_start_char;
    } while (startChar !== undefined);

    expect(reconstructed).toBe(source);
  });

  it("keeps output within max_chars across continuation-note digit boundaries", async () => {
    fs.writeFileSync(path.join(tmpDir, "boundary.txt"), "x".repeat(141));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    } as Any);

    const result = await tools.parseDocument({ path: "boundary.txt", max_chars: 140 });

    expect(result.content.length).toBeLessThanOrEqual(140);
    expect(result.window.end).toBeLessThan(141);
  });

  it("enforces workspace read permission and project ACCESS.md", async () => {
    const projectDir = path.join(tmpDir, ".cowork", "projects", "private");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "ACCESS.md"), "## Deny\n- role: reviewer\n");
    fs.writeFileSync(path.join(projectDir, "notes.txt"), "restricted");

    const deniedByWorkspace = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: false, write: true, delete: true, network: false, shell: false },
    } as Any);
    await expect(deniedByWorkspace.parseDocument({ path: "notes.txt" })).rejects.toThrow(
      /read permission not granted/i,
    );

    const deniedByProject = new DocumentParserTools(
      {
        id: "ws-1",
        name: "Test Workspace",
        path: tmpDir,
        createdAt: Date.now(),
        permissions: { read: true, write: true, delete: true, network: false, shell: false },
      } as Any,
      { getTask: () => ({ assignedAgentRoleId: "reviewer" }) } as Any,
      "task-1",
    );
    await expect(
      deniedByProject.parseDocument({ path: ".cowork/projects/private/notes.txt" }),
    ).rejects.toThrow(/denied by ACCESS\.md/i);
  });

  it("keeps trust banners and continuation notes inside max_chars", async () => {
    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath);
    const externalPath = path.join(tmpDir, "external.txt");
    fs.writeFileSync(externalPath, "x".repeat(300));
    sensitiveSourceRefMock.mockReturnValueOnce({
      path: externalPath,
      sourceKind: "download",
      trustLevel: "untrusted",
    });
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: workspacePath,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [tmpDir],
      },
    } as Any);

    const result = await tools.parseDocument({ path: externalPath, max_chars: 100 });

    expect(result.content.length).toBeLessThanOrEqual(100);
    expect(result.content).toContain("UNTRUSTED EXTERNAL CONTENT");
    expect(result.next_start_char).toBe(result.window.end);
    expect(result.window.end).toBeGreaterThan(0);
  });

  it("rejects a document denied by the active access profile", async () => {
    const deniedPath = path.join(tmpDir, "private.txt");
    fs.writeFileSync(deniedPath, "do not read");
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        accessFilesystemRules: [{ path: deniedPath, access: "deny" }],
      },
    } as Any);

    await expect(tools.parseDocument({ path: "private.txt" })).rejects.toThrow(
      /denied by the active access profile/i,
    );
  });

  it("advances high-offset untrusted windows when an in-band note cannot fit", () => {
    const window = calculateDocumentWindow({
      total: 100_000_010,
      start: 100_000_000,
      maxChars: 100,
      prefixLength: 40,
    });

    expect(window.end).toBeGreaterThan(100_000_000);
    expect(window.note).toBe("");
    expect(40 + window.end - 100_000_000).toBeLessThanOrEqual(100);
  });
});
