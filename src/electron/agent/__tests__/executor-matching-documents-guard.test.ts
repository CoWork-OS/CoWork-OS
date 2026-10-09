import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileOperationTracker, ToolCallDeduplicator } from "../executor-helpers";
import { TaskExecutor } from "../executor";
import { buildRedundantFileOperationToolResult } from "../executor-tool-execution-utils";
import {
  MATCHING_DOCUMENT_FORMATS_PLAN_HINT,
  MatchingDocumentFormatsGuard,
  promptTreatsFileAsSource,
  requestsMatchingDocumentFormats,
  resolveMatchingDocumentSiblings,
} from "../executor-matching-documents-guard";

const LIVE_PROMPT =
  "Prepare a polished two-page client brief in Portuguese (Portugal) for the Northstar onboarding pilot. " +
  "Save both an editable Word document and a matching PDF: Northstar-brief.docx and Northstar-brief.pdf.\n\n" +
  "Facts: 8 customer-success staff; start 26 October 2026. Marta owns welcome copy. " +
  "Use clear headings and readable tables; keep page numbers correct. Give me links to both files.";

const CONTENT = [
  { type: "heading", level: 1, text: "Northstar — Brief do piloto" },
  { type: "paragraph", text: "Oito profissionais de sucesso do cliente." },
];

const proto = (TaskExecutor as Any).prototype;

describe("TaskExecutor matching document formats guard", () => {
  let workspace: string;
  let executor: Any;
  let runTool: ReturnType<typeof vi.fn>;

  function makeExecutor(prompt: string): Any {
    const fake: Any = Object.create(TaskExecutor.prototype);
    fake.fileOperationTracker = new FileOperationTracker();
    fake.toolCallDeduplicator = new ToolCallDeduplicator(3, 120_000, 4);
    fake.workspace = { path: workspace };
    fake.logTag = "[Executor:test]";
    fake.task = { id: "task-1", prompt };
    fake.emitEvent = vi.fn();
    // Stands in for the tool runtime: writes each requested file and reports it.
    runTool = vi.fn(async (_toolName: string, input: Any) => {
      const formats: string[] = Array.isArray(input.formats) ? input.formats : [input.format];
      const named = input.filenames || {};
      const base = String(input.filename).replace(/\.(docx|pdf)$/i, "");
      const files = formats.map((format) => {
        const filename =
          named[format] ||
          (formats.length === 1 && /\.(docx|pdf)$/i.test(input.filename)
            ? input.filename
            : `${base}.${format}`);
        fs.writeFileSync(
          path.join(workspace, filename),
          `${format}:${JSON.stringify(input.content)}`,
        );
        return { path: filename, format, ...(format === "pdf" ? { pageCount: 2 } : {}) };
      });
      return {
        result: { success: true, path: files[0].path, files },
        durationMs: 1,
        resultJson: "",
        envelope: { toolUseId: "tool-1" },
      };
    });
    fake.runToolWithHeartbeat = runTool;
    return fake;
  }

  const check = (input: Any, options?: { preview?: boolean }) =>
    proto.checkFileOperation.call(executor, "create_document", input, new Set<string>(), options);

  async function run(input: Any) {
    const coordinated = await proto.executeToolWithHeartbeat.call(
      executor,
      "create_document",
      input,
      30_000,
    );
    proto.recordFileOperation.call(executor, "create_document", input, coordinated.result);
    return coordinated;
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "matching-docs-"));
    executor = makeExecutor(LIVE_PROMPT);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("blocks a single PDF call and names both formats and both files", () => {
    const outcome = check({
      filename: "Northstar-brief.pdf",
      format: "pdf",
      maxPages: 2,
      pageNumbers: true,
      content: CONTENT,
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("This request needs matching files.");
    expect(outcome.reason).toContain(
      'Call create_document once with formats: ["docx","pdf"] (filenames: {"docx":"Northstar-brief.docx","pdf":"Northstar-brief.pdf"})',
    );
    expect(outcome.reason).toContain("pageNumbers: true, maxPages: 2");
    const toolResult = buildRedundantFileOperationToolResult({
      toolUseId: "tool-1",
      fileOpCheck: outcome,
    });
    expect(toolResult.is_error).toBe(true);
    expect(JSON.parse(String(toolResult.content))).toMatchObject({ blocked: true });
    expect(fs.existsSync(path.join(workspace, "Northstar-brief.pdf"))).toBe(false);
  });

  it("runs the retry with formats and records both files", async () => {
    expect(
      check({ filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT }).blocked,
    ).toBe(true);

    const retry = {
      filename: "Northstar-brief",
      formats: ["docx", "pdf"],
      filenames: { docx: "Northstar-brief.docx", pdf: "Northstar-brief.pdf" },
      content: CONTENT,
    };
    expect(check(retry).blocked).toBe(false);
    const coordinated = await run(retry);

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(coordinated.result.success).toBe(true);
    expect(executor.fileOperationTracker.getCreatedFiles().sort()).toEqual([
      "Northstar-brief.docx",
      "Northstar-brief.pdf",
    ]);
  });

  it("reports a file the formats call already wrote instead of rewriting it", async () => {
    await run({
      filename: "Northstar-brief.docx",
      formats: ["docx", "pdf"],
      pageNumbers: true,
      content: CONTENT,
    });
    const pdfPath = path.join(workspace, "Northstar-brief.pdf");
    fs.writeFileSync(pdfPath, "written by the formats call");
    runTool.mockClear();

    const later = {
      filename: "Northstar-brief.pdf",
      format: "pdf",
      pageNumbers: true,
      content: JSON.parse(JSON.stringify(CONTENT)),
    };
    const outcome = check(later);
    expect(outcome.blocked).toBe(false);
    const coordinated = await run(later);

    expect(runTool).not.toHaveBeenCalled();
    expect(coordinated.result).toMatchObject({
      success: true,
      alreadyWritten: true,
      path: "Northstar-brief.pdf",
      files: [{ path: "Northstar-brief.pdf", format: "pdf", pageCount: 2 }],
    });
    expect(coordinated.result.message).toContain("already written from the same content");
    expect(JSON.parse(coordinated.resultJson)).toMatchObject({ alreadyWritten: true });
    expect(fs.readFileSync(pdfPath, "utf8")).toBe("written by the formats call");

    // The step after it sees the same file again, not a new write.
    const again = { ...later, content: JSON.parse(JSON.stringify(CONTENT)) };
    expect(check(again).blocked).toBe(false);
    expect((await run(again)).result.alreadyWritten).toBe(true);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("redirects a later single call with changed content to rewrite both files", async () => {
    await run({ filename: "Northstar-brief.docx", formats: ["docx", "pdf"], content: CONTENT });

    const outcome = check({
      filename: "Northstar-brief.docx",
      format: "docx",
      content: [...CONTENT, { type: "paragraph", text: "Extra" }],
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("was written together with Northstar-brief.pdf");
    expect(outcome.reason).toContain('formats: ["docx","pdf"]');
  });

  it("redirects the other file when one was already written by a single-format call", async () => {
    const docx = { filename: "Northstar-brief.docx", format: "docx", content: CONTENT };
    // Written before the guard applied (it was let through after repeated blocks).
    expect(check(docx).blocked).toBe(true);
    expect(check(docx).blocked).toBe(true);
    expect(check(docx).blocked).toBe(false);
    await run(docx);
    expect(fs.existsSync(path.join(workspace, "Northstar-brief.docx"))).toBe(true);

    const outcome = check({ filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT });

    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain(
      "Northstar-brief.docx was already written by an earlier single-format call",
    );
    expect(outcome.reason).toContain(
      '(filenames: {"docx":"Northstar-brief.docx","pdf":"Northstar-brief.pdf"})',
    );
  });

  it("lets a single call through with a warning after the block is ignored twice", async () => {
    const single = { filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT };

    expect(check(single).blocked).toBe(true);
    expect(check(single).blocked).toBe(true);
    const third = { ...single };
    expect(check(third).blocked).toBe(false);
    const coordinated = await run(third);

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(coordinated.result.success).toBe(true);
    expect(coordinated.result.warnings).toEqual([
      expect.stringContaining("may not match Northstar-brief.docx"),
    ]);
    expect(JSON.parse(coordinated.resultJson).warnings).toHaveLength(1);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "tool_warning",
      expect.objectContaining({ tool: "create_document" }),
    );
    // Still allowed afterwards: no endless loop of blocks.
    expect(check({ ...single }).blocked).toBe(false);
  });

  it("does not count a previewed batch check as a block", () => {
    const single = { filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT };

    for (let i = 0; i < 3; i += 1) {
      expect(check(single, { preview: true }).blocked).toBe(true);
    }
    expect(check(single).blocked).toBe(true);
    expect(check(single).blocked).toBe(true);
    expect(check(single).blocked).toBe(false);
  });

  it("allows a single call that converts a supplied file", () => {
    fs.writeFileSync(path.join(workspace, "report.pdf"), "user input");
    executor = makeExecutor("Convert report.pdf to report.docx");

    const outcome = check({ filename: "report.docx", format: "docx", content: CONTENT });

    expect(outcome.blocked).toBe(false);
  });

  it("never asks to overwrite a matching file that existed before the task", () => {
    fs.writeFileSync(path.join(workspace, "brief.pdf"), "user input");
    executor = makeExecutor("Make brief.docx and a matching brief.pdf");

    expect(check({ filename: "brief.docx", format: "docx", content: CONTENT }).blocked).toBe(false);
  });

  it("does not apply when the request asks only for a PDF", () => {
    executor = makeExecutor(
      "Write a two-page PDF brief about the Northstar pilot: Northstar-brief.pdf",
    );

    expect(
      check({ filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT }).blocked,
    ).toBe(false);
  });

  it("adds the one-call plan hint to matching document tasks only", async () => {
    const analyze = async (prompt: string) => {
      const fake = makeExecutor(prompt);
      fake.toolRegistry = { executeTool: vi.fn(async () => []) };
      return proto.analyzeTask.call(fake);
    };

    const matching = await analyze(LIVE_PROMPT);
    expect(matching.additionalContext).toContain(MATCHING_DOCUMENT_FORMATS_PLAN_HINT);
    expect(MATCHING_DOCUMENT_FORMATS_PLAN_HINT).toContain(
      "create them in one step with a single create_document call using formats",
    );

    const pdfOnly = await analyze("Create a PDF report about the Northstar pilot.");
    expect(pdfOnly.additionalContext || "").not.toContain("MATCHING DOCUMENTS");
  });
});

describe("matching document helpers", () => {
  it("detects matching DOCX/PDF requests", () => {
    expect(requestsMatchingDocumentFormats(LIVE_PROMPT)).toBe(true);
    expect(
      requestsMatchingDocumentFormats("Write the memo as a Word document and a matching PDF."),
    ).toBe(true);
    expect(requestsMatchingDocumentFormats("Write the memo as a PDF.")).toBe(false);
    expect(requestsMatchingDocumentFormats("Build budget.xlsx and a matching budget.pdf")).toBe(
      false,
    );
  });

  it("derives the paired file from the prompt or the target name", () => {
    expect(
      resolveMatchingDocumentSiblings(LIVE_PROMPT, {
        filename: "Northstar-brief.pdf",
        format: "pdf",
      }),
    ).toEqual([{ filename: "Northstar-brief.docx", format: "docx" }]);
    expect(
      resolveMatchingDocumentSiblings("Write a Word document and a matching PDF of the memo.", {
        filename: "out/memo.docx",
        format: "docx",
      }),
    ).toEqual([{ filename: path.join("out", "memo.pdf"), format: "pdf" }]);
    expect(
      resolveMatchingDocumentSiblings("Save brief.docx and a matching print copy brief-print.pdf", {
        filename: "brief.docx",
        format: "docx",
      }),
    ).toEqual([{ filename: "brief-print.pdf", format: "pdf" }]);
    // A file the request does not name is not part of the pair.
    expect(
      resolveMatchingDocumentSiblings(LIVE_PROMPT, { filename: "notes.docx", format: "docx" }),
    ).toBeNull();
  });

  it("recognizes files the request reads from", () => {
    expect(promptTreatsFileAsSource("Convert report.pdf to report.docx", "report.pdf")).toBe(true);
    expect(promptTreatsFileAsSource("Turn the attached `report.pdf` into Word", "report.pdf")).toBe(
      true,
    );
    expect(promptTreatsFileAsSource(LIVE_PROMPT, "Northstar-brief.docx")).toBe(false);
  });

  it("keeps a file written by formats out of the guard after another tool changes it", () => {
    const guard = new MatchingDocumentFormatsGuard("/workspace");
    const input = { filename: "Northstar-brief", formats: ["docx", "pdf"], content: CONTENT };
    guard.recordCreateDocument(input, {
      success: true,
      files: [
        { path: "Northstar-brief.docx", format: "docx" },
        { path: "Northstar-brief.pdf", format: "pdf" },
      ],
    });
    const evaluate = () =>
      guard.evaluate({
        input: { filename: "Northstar-brief.pdf", format: "pdf", content: CONTENT },
        prompt: LIVE_PROMPT,
        fileExists: () => true,
        preview: true,
      });

    expect(evaluate().action).toBe("already_written");
    guard.forget(["/workspace/Northstar-brief.pdf"]);
    expect(evaluate().action).toBe("block");
  });
});
