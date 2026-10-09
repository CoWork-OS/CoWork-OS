import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileOperationTracker,
  ToolCallDeduplicator,
  ToolFailureTracker,
} from "../executor-helpers";
import { TaskExecutor } from "../executor";
import {
  buildDuplicateCallSuggestion,
  buildDuplicateToolResult,
} from "../executor-tool-execution-utils";

describe("ToolCallDeduplicator read-history invalidation", () => {
  it("does not dedupe repeated screenshot calls", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("screenshot", { app: "Calculator" }, '{"captureId":"cap_1"}');
    dedupe.recordCall("screenshot", { app: "Calculator" }, '{"captureId":"cap_2"}');

    expect(dedupe.checkDuplicate("screenshot", { app: "Calculator" })).toEqual(
      expect.objectContaining({ isDuplicate: false }),
    );
  });

  it("clears read/list duplicate history while preserving write history", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 4, 20);

    dedupe.recordCall("read_file", { path: "doc.md" }, '{"content":"a"}');
    dedupe.recordCall("read_file", { path: "doc.md" }, '{"content":"a"}');
    dedupe.recordCall("write_file", { path: "doc.md", content: "x" }, '{"success":true}');
    dedupe.recordCall("write_file", { path: "doc.md", content: "x" }, '{"success":true}');

    expect(dedupe.checkDuplicate("read_file", { path: "doc.md" }).isDuplicate).toBe(true);
    expect(dedupe.checkDuplicate("write_file", { path: "doc.md", content: "x" }).isDuplicate).toBe(
      true,
    );

    dedupe.clearReadOnlyHistory();

    expect(dedupe.checkDuplicate("read_file", { path: "doc.md" }).isDuplicate).toBe(false);
    expect(dedupe.checkDuplicate("write_file", { path: "doc.md", content: "x" }).isDuplicate).toBe(
      true,
    );
  });

  it("treats browser_navigate URLs that differ only by tracking params as semantic duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("browser_navigate", {
      url: "https://example.com/news?utm_source=twitter",
    });
    dedupe.recordCall("browser_navigate", {
      url: "https://example.com/news?utm_source=linkedin&utm_medium=social",
    });

    const duplicate = dedupe.checkDuplicate("browser_navigate", {
      url: "https://example.com/news?utm_campaign=test",
    });
    expect(duplicate.isDuplicate).toBe(true);
  });

  it("does not treat distinct browser_navigate business queries as semantic duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("browser_navigate", { url: "https://example.com/news?page=1" });
    dedupe.recordCall("browser_navigate", { url: "https://example.com/news?page=2" });

    const duplicate = dedupe.checkDuplicate("browser_navigate", {
      url: "https://example.com/news?page=3",
    });
    expect(duplicate.isDuplicate).toBe(false);
  });

  it("allows higher per-minute throughput for read-only cloud action pagination", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    for (let i = 0; i < 20; i++) {
      dedupe.recordCall("box_action", {
        action: "list_folder_items",
        folder_id: "0",
        offset: i * 100,
      });
    }

    const nextPageCall = dedupe.checkDuplicate("box_action", {
      action: "list_folder_items",
      folder_id: "0",
      offset: 2000,
    });
    expect(nextPageCall.isDuplicate).toBe(false);
  });

  it("keeps strict rate limit for mutating cloud actions", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    for (let i = 0; i < 20; i++) {
      dedupe.recordCall("box_action", {
        action: "create_folder",
        parent_id: "0",
        name: `temp-${i}`,
      });
    }

    const createCall = dedupe.checkDuplicate("box_action", {
      action: "create_folder",
      parent_id: "0",
      name: "temp-over-limit",
    });
    expect(createCall.isDuplicate).toBe(true);
    expect(createCall.reason || "").toContain("Rate limit exceeded");
  });

  it("resets mutation duplicate history per step while preserving read duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 4, 20);

    dedupe.recordCall("read_file", { path: "styles.css" }, '{"content":"..."}');
    dedupe.recordCall("read_file", { path: "styles.css" }, '{"content":"..."}');
    dedupe.recordCall("write_file", { path: "styles.css", content: "a" }, '{"success":true}');
    dedupe.recordCall("write_file", { path: "styles.css", content: "a" }, '{"success":true}');

    expect(dedupe.checkDuplicate("read_file", { path: "styles.css" }).isDuplicate).toBe(true);
    expect(
      dedupe.checkDuplicate("write_file", { path: "styles.css", content: "a" }).isDuplicate,
    ).toBe(true);

    dedupe.resetMutationHistoryForNewStep();

    expect(dedupe.checkDuplicate("read_file", { path: "styles.css" }).isDuplicate).toBe(true);
    expect(
      dedupe.checkDuplicate("write_file", { path: "styles.css", content: "a" }).isDuplicate,
    ).toBe(false);
  });
});

describe("FileOperationTracker cache invalidation", () => {
  it("invalidates read cache for a modified file", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileRead("NexusChain-Whitepaper.md", "one");
    tracker.recordFileRead("NexusChain-Whitepaper.md", "two");

    expect(tracker.checkFileRead("NexusChain-Whitepaper.md").blocked).toBe(true);

    tracker.invalidateFileRead("NexusChain-Whitepaper.md");

    expect(tracker.checkFileRead("NexusChain-Whitepaper.md").blocked).toBe(false);
  });

  it("invalidates directory listing cache after filesystem changes", () => {
    const tracker = new FileOperationTracker();

    tracker.recordDirectoryListing("research", ["01-state-of-the-art-research.md"]);
    tracker.recordDirectoryListing("research", ["01-state-of-the-art-research.md"]);

    expect(tracker.checkDirectoryListing("research").blocked).toBe(true);

    tracker.invalidateDirectoryListing("research");

    expect(tracker.checkDirectoryListing("research").blocked).toBe(false);
  });

  it("tracks created files per full path without collapsing different extensions", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileCreation("deliverables/report.csv");
    tracker.recordFileCreation("deliverables/report.json");

    expect(tracker.getCreatedFiles()).toEqual(
      expect.arrayContaining(["deliverables/report.csv", "deliverables/report.json"]),
    );
    expect(tracker.getCreatedFiles()).toHaveLength(2);
  });

  it("does not flag rewriting the same file path as a duplicate creation", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileCreation("deliverables/report.md");

    expect(tracker.checkFileCreation("deliverables/report.md")).toEqual(
      expect.objectContaining({ isDuplicate: false }),
    );
  });

  it("moves cached file knowledge to the rename destination", () => {
    const tracker = new FileOperationTracker();
    tracker.recordFileRead("inbox/invoice_final_FINAL.txt", "invoice");
    tracker.recordFileCreation("inbox/invoice_final_FINAL.txt");

    tracker.recordFileRename("inbox/invoice_final_FINAL.txt", "inbox/Invoices/invoice.txt");

    expect(tracker.getKnowledgeSummary()).toContain("inbox/invoices/invoice.txt");
    expect(tracker.getKnowledgeSummary()).not.toContain("invoice_final_final.txt");
    expect(tracker.getCreatedFiles()).toEqual(["inbox/Invoices/invoice.txt"]);
  });

  it("blocks duplicate file creation within the same tool batch", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const first = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/skills/demo/novelist/chapters/ch_08.md", content: "one" },
      batchCreatedPaths,
    );
    const second = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/skills/demo/novelist/chapters/ch_08.md", content: "two" },
      batchCreatedPaths,
    );

    expect(first.blocked).toBe(false);
    expect(second.blocked).toBe(true);
    expect(second.reason || "").toContain("tool batch");
  });

  it("treats a DOCX/PDF pair sharing one base name as two files in a batch", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const check = (input: Any) =>
      (TaskExecutor as Any).prototype.checkFileOperation.call(
        fakeThis,
        "create_document",
        input,
        batchCreatedPaths,
      );

    expect(check({ filename: "Northstar-brief", format: "docx" }).blocked).toBe(false);
    expect(check({ filename: "Northstar-brief", format: "pdf" }).blocked).toBe(false);
    expect(check({ filename: "Northstar-brief.pdf", format: "pdf" }).blocked).toBe(true);
  });

  it("reserves every file of a create_document call with formats", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const check = (input: Any) =>
      (TaskExecutor as Any).prototype.checkFileOperation.call(
        fakeThis,
        "create_document",
        input,
        batchCreatedPaths,
      );
    const pair = { filename: "Northstar-brief.docx", formats: ["docx", "pdf"] };

    expect(check(pair).blocked).toBe(false);
    expect(Array.from(batchCreatedPaths).sort()).toEqual([
      "northstar-brief.docx",
      "northstar-brief.pdf",
    ]);
    const second = check({ filename: "Northstar-brief.pdf", format: "pdf" });
    expect(second.blocked).toBe(true);
    expect(second.reason).toContain("Northstar-brief.pdf");

    (TaskExecutor as Any).prototype.releaseBatchCreatedPathReservation.call(
      fakeThis,
      batchCreatedPaths,
      "create_document",
      pair,
    );
    expect(batchCreatedPaths.size).toBe(0);
  });

  it("records every file a create_document call with formats wrote as created", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.toolCallDeduplicator = new ToolCallDeduplicator(3, 120_000, 4);
    fakeThis.workspace = { path: "/workspace" };
    fakeThis.logTag = "[Executor:test]";

    (TaskExecutor as Any).prototype.recordFileOperation.call(
      fakeThis,
      "create_document",
      { filename: "Northstar-brief", formats: ["docx", "pdf"] },
      {
        success: true,
        path: "Northstar-brief.docx",
        files: [
          { path: "Northstar-brief.docx", format: "docx" },
          { path: "Northstar-brief.pdf", format: "pdf", pageCount: 2 },
        ],
      },
    );

    expect(fakeThis.fileOperationTracker.getCreatedFiles().sort()).toEqual([
      "Northstar-brief.docx",
      "Northstar-brief.pdf",
    ]);
  });

  it("releases a failed batch file reservation so the same path can be retried", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const first = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/seed.txt", content: "one" },
      batchCreatedPaths,
    );

    (TaskExecutor as Any).prototype.releaseBatchCreatedPathReservation.call(
      fakeThis,
      batchCreatedPaths,
      "write_file",
      { path: "artifacts/seed.txt", content: "one" },
    );

    const retry = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/seed.txt", content: "two" },
      batchCreatedPaths,
    );

    expect(first.blocked).toBe(false);
    expect(retry.blocked).toBe(false);
  });
});

describe("TaskExecutor output links for a create_document call with formats", () => {
  it("links both files of one call when the answer omits them", () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-formats-links-"));
    try {
      fs.writeFileSync(path.join(workspacePath, "Northstar-brief.docx"), "docx");
      fs.writeFileSync(path.join(workspacePath, "Northstar-brief.pdf"), "pdf");
      const fakeThis: Any = Object.create(TaskExecutor.prototype);
      fakeThis.fileOperationTracker = new FileOperationTracker();
      fakeThis.toolCallDeduplicator = new ToolCallDeduplicator(3, 120_000, 4);
      fakeThis.workspace = { path: workspacePath };
      fakeThis.logTag = "[Executor:test]";
      fakeThis.task = { id: "task-1", title: "Northstar brief", prompt: "" };
      fakeThis.getContractPrompt = () =>
        "Save Northstar-brief.docx and Northstar-brief.pdf. Give me links to both files.";
      fakeThis.daemon = { getTaskEvents: () => [] };

      (TaskExecutor as Any).prototype.recordFileOperation.call(
        fakeThis,
        "create_document",
        { filename: "Northstar-brief", formats: ["docx", "pdf"] },
        {
          success: true,
          path: "Northstar-brief.docx",
          files: [
            { path: "Northstar-brief.docx", format: "docx" },
            { path: "Northstar-brief.pdf", format: "pdf" },
          ],
        },
      );
      const answer = (TaskExecutor as Any).prototype.reconcileOutputAvailabilityClaims.call(
        fakeThis,
        "The brief is ready.",
      );

      expect(answer).toContain("[Northstar-brief.docx](Northstar-brief.docx)");
      expect(answer).toContain("[Northstar-brief.pdf](Northstar-brief.pdf)");
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("ToolCallDeduplicator only blocks genuine repeats", () => {
  const failedTestRun = JSON.stringify({
    success: false,
    exitCode: 1,
    stdout: "1 failed",
    stderr: "AssertionError: expected 200, got 302",
  });

  it("lets the model keep polling a background process with the same call", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const input = { process_id: "bg-1a2b3c4d", wait_ms: 5_000 };

    for (let i = 0; i < 8; i++) {
      expect(dedupe.checkDuplicate("process_output", input)).toEqual({ isDuplicate: false });
      dedupe.recordCall("process_output", input, `{"success":true,"output":"tick ${i}"}`);
    }
  });

  it("allows six distinct edits to different files in a row", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);

    for (let i = 0; i < 6; i++) {
      const input = {
        file_path: `src/feature${i}.ts`,
        old_string: "getUser(",
        new_string: "fetchUser(",
      };
      expect(dedupe.checkDuplicate("edit_file", input)).toEqual({ isDuplicate: false });
      dedupe.recordCall("edit_file", input, '{"success":true}');
    }
  });

  it("allows different edits to the same file", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);

    for (let i = 0; i < 6; i++) {
      const input = {
        file_path: "src/app.ts",
        old_string: `const v${i} = 0;`,
        new_string: `const v${i} = 1;`,
      };
      expect(dedupe.checkDuplicate("edit_file", input).isDuplicate).toBe(false);
      dedupe.recordCall("edit_file", input, '{"success":true}');
    }
  });

  it("does not cap distinct edits per run, including across follow-up resets", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const now = vi.spyOn(Date, "now");
    try {
      for (let i = 1; i <= 30; i++) {
        now.mockReturnValue(1_000_000 + i * 180_000);
        if (i === 7) dedupe.reset();
        const input = { file_path: `src/f${i}.ts`, old_string: "a", new_string: "b" };
        expect(dedupe.checkDuplicate("edit_file", input).isDuplicate).toBe(false);
        dedupe.recordCall("edit_file", input, "{}");
      }
    } finally {
      now.mockRestore();
    }
  });

  it("still blocks an identical edit repeated over and over", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const input = { file_path: "src/app.ts", old_string: "a", new_string: "b" };

    for (let i = 0; i < 3; i++) dedupe.recordCall("edit_file", input, '{"success":true}');

    const check = dedupe.checkDuplicate("edit_file", input);
    expect(check.isDuplicate).toBe(true);
    expect(check.reason).toMatch(/exact parameters/);
  });

  it("does not collapse distinct numbered source files written with write_file", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);

    for (let i = 1; i <= 6; i++) {
      const input = { path: `src/steps/step-${i}.ts`, content: `export const step = ${i};\n` };
      expect(dedupe.checkDuplicate("write_file", input).isDuplicate).toBe(false);
      dedupe.recordCall("write_file", input, '{"success":true}');
    }
  });

  it("still flags renamed variants of the same document", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const names = ["report_v2.md", "report_v3.md", "report_final.md", "report_updated.md"];
    for (const name of names) {
      const input = { path: `out/${name}`, content: `# Report (${name})` };
      expect(dedupe.checkDuplicate("write_file", input).isDuplicate).toBe(false);
      dedupe.recordCall("write_file", input, '{"success":true}');
    }

    const check = dedupe.checkDuplicate("write_file", {
      path: "out/report_complete.md",
      content: "# Report (complete)",
    });
    expect(check.isDuplicate).toBe(true);
    expect(check.reason).toMatch(/versions of the same document/);
  });

  it("treats rewriting the same document as editing it, not as a new variant", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);

    for (let i = 1; i <= 6; i++) {
      const input = { path: "out/report.md", content: `# Report\n\nDraft ${i}` };
      expect(dedupe.checkDuplicate("write_file", input).isDuplicate).toBe(false);
      dedupe.recordCall("write_file", input, '{"success":true}');
    }
  });

  it("does not treat calls with different nested inputs as identical", () => {
    const dedupe = new ToolCallDeduplicator(2, 120_000, 4);
    const doc = (text: string) => ({
      filename: "notes.docx",
      content: [{ type: "paragraph", text }],
    });

    dedupe.recordCall("create_document", doc("first"), '{"success":true}');
    dedupe.recordCall("create_document", doc("second"), '{"success":true}');

    expect(dedupe.checkDuplicate("create_document", doc("third")).isDuplicate).toBe(false);
  });

  it("allows the same test command again after a workspace mutation", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const testRun = { command: "pytest tests/test_login.py -x" };
    for (let i = 0; i < 3; i++) dedupe.recordCall("run_command", testRun, failedTestRun);
    expect(dedupe.checkDuplicate("run_command", testRun).isDuplicate).toBe(true);

    dedupe.clearHistoryAfterWorkspaceMutation();

    expect(dedupe.checkDuplicate("run_command", testRun).isDuplicate).toBe(false);
  });

  it("keeps blocking a command repeated back-to-back when only that command ran", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const testRun = { command: "npm test" };
    for (let i = 0; i < 3; i++) {
      dedupe.recordCall("run_command", testRun, failedTestRun);
      dedupe.clearHistoryAfterWorkspaceMutation({ toolName: "run_command", input: testRun });
    }

    expect(dedupe.checkDuplicate("run_command", testRun).isDuplicate).toBe(true);
  });

  it("allows 25 distinct reads and searches within a minute", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);

    for (let i = 0; i < 25; i++) {
      for (const [tool, input] of [
        ["read_file", { path: `src/module${i}.ts` }],
        ["grep", { pattern: `symbol${i}` }],
      ] as const) {
        expect(dedupe.checkDuplicate(tool, input).isDuplicate).toBe(false);
        dedupe.recordCall(tool, input, '{"content":"export {}"}');
      }
    }
  });

  it("states that the previous identical call failed instead of claiming success", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const testRun = { command: "npm test" };
    for (let i = 0; i < 3; i++) dedupe.recordCall("run_command", testRun, failedTestRun);

    const check = dedupe.checkDuplicate("run_command", testRun);
    const suggestion = buildDuplicateCallSuggestion(check);

    expect(check.isDuplicate).toBe(true);
    expect(check.previousOutcome).toBe("failed");
    expect(check.reason).toMatch(/failed \(exit code 1/);
    expect(`${check.reason} ${suggestion}`).not.toMatch(/succeeded/);
    expect(suggestion).toMatch(/fail the same way/);
  });

  it("states that the previous identical call succeeded only when it did", () => {
    const dedupe = new ToolCallDeduplicator(3, 120_000, 4);
    const listing = { command: "ls" };
    for (let i = 0; i < 3; i++) {
      dedupe.recordCall("run_command", listing, '{"success":true,"exitCode":0,"stdout":"a"}');
    }

    const check = dedupe.checkDuplicate("run_command", listing);

    expect(check.previousOutcome).toBe("succeeded");
    expect(check.reason).toMatch(/last one succeeded/);
  });
});

describe("FileOperationTracker read windows", () => {
  it("never answers a read of one window with another window's content", () => {
    const tracker = new FileOperationTracker();
    tracker.recordFileRead("src/big.ts", "chunk-0", { path: "src/big.ts", startChar: 0 });
    tracker.recordFileRead("src/big.ts", "chunk-1", { path: "src/big.ts", startChar: 20000 });

    const next = tracker.checkFileRead("src/big.ts", { path: "src/big.ts", startChar: 40000 });

    expect(next.blocked).toBe(false);
    expect(next.cachedResult).toBeUndefined();
  });

  it("serves a repeated identical read with that read's own content", () => {
    const tracker = new FileOperationTracker();
    tracker.recordFileRead("src/big.ts", "chunk-0", { path: "src/big.ts" });
    tracker.recordFileRead("src/big.ts", "chunk-1", { path: "src/big.ts", startChar: 20000 });
    tracker.recordFileRead("src/big.ts", "chunk-1", { path: "src/big.ts", startChar: "20000" });

    const repeat = tracker.checkFileRead("src/big.ts", { path: "src/big.ts", startChar: 20000 });
    expect(repeat.blocked).toBe(true);
    expect(repeat.cachedResult).toBe("chunk-1");
    // The first window was read once, so reading it again is not throttled.
    expect(tracker.checkFileRead("src/big.ts", { path: "src/big.ts", startChar: 0 }).blocked).toBe(
      false,
    );
  });
});

describe("TaskExecutor read cache invalidation", () => {
  const readResult = {
    content: "export const a = 1;\n",
    size: 20,
    truncated: false,
    path: "src/a.ts",
    window: { start: 0, end: 20, total: 20 },
  };

  function createFileOpExecutor(): Any {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.toolCallDeduplicator = new ToolCallDeduplicator(3, 120_000, 4);
    fakeThis.workspace = { path: "/workspace" };
    fakeThis.logTag = "[Executor:test]";
    return fakeThis;
  }

  function checkFileOperation(executor: Any, toolName: string, input: Any, batch = new Set()) {
    return (TaskExecutor as Any).prototype.checkFileOperation.call(
      executor,
      toolName,
      input,
      batch,
    );
  }

  function recordFileOperation(executor: Any, toolName: string, input: Any, result: Any) {
    (TaskExecutor as Any).prototype.recordFileOperation.call(executor, toolName, input, result);
  }

  function readTwice(executor: Any, filePath = "src/a.ts") {
    recordFileOperation(executor, "read_file", { path: filePath }, readResult);
    recordFileOperation(executor, "read_file", { path: filePath }, readResult);
  }

  it("labels a cached read_file result explicitly and keeps it valid JSON", () => {
    const executor = createFileOpExecutor();
    readTwice(executor);

    const check = checkFileOperation(executor, "read_file", { path: "src/a.ts" });

    expect(check.blocked).toBe(true);
    const served = JSON.parse(check.cachedResult);
    expect(served._cached).toMatch(/identical read_file call \(same path and window\)/);
    expect(served.content).toBe(readResult.content);
    expect(served.window).toEqual(readResult.window);
  });

  it("does not serve cached content after a failed edit of the file", () => {
    const executor = createFileOpExecutor();
    readTwice(executor);

    recordFileOperation(
      executor,
      "edit_file",
      { file_path: "/workspace/src/a.ts", old_string: "a = 2", new_string: "a = 3" },
      { success: false, error: "old_string not found" },
    );

    expect(checkFileOperation(executor, "read_file", { path: "src/a.ts" }).blocked).toBe(false);
  });

  it("does not answer a read from cache when an earlier call in the same batch edits the file", () => {
    const executor = createFileOpExecutor();
    readTwice(executor);
    const batch = new Set<string>();

    const edit = checkFileOperation(
      executor,
      "edit_file",
      { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
      batch,
    );
    const read = checkFileOperation(executor, "read_file", { path: "src/a.ts" }, batch);

    expect(edit.blocked).toBe(false);
    expect(read.blocked).toBe(false);
  });

  it("drops every cached read after a shell command", () => {
    const executor = createFileOpExecutor();
    readTwice(executor);

    recordFileOperation(executor, "run_command", { command: "npm run fmt" }, { exitCode: 0 });

    expect(checkFileOperation(executor, "read_file", { path: "src/a.ts" }).blocked).toBe(false);
  });

  it("lets an identical test command run again after a successful edit", () => {
    const executor = createFileOpExecutor();
    const testRun = { command: "npm test" };
    for (let i = 0; i < 3; i++) {
      executor.toolCallDeduplicator.recordCall("run_command", testRun, '{"exitCode":1}');
    }
    expect(executor.toolCallDeduplicator.checkDuplicate("run_command", testRun).isDuplicate).toBe(
      true,
    );

    recordFileOperation(
      executor,
      "edit_file",
      { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
      { success: true, file_path: "src/a.ts", replacements: 1 },
    );

    expect(executor.toolCallDeduplicator.checkDuplicate("run_command", testRun).isDuplicate).toBe(
      false,
    );
  });

  it("labels a duplicate read served from the duplicate-call cache", () => {
    const cached = JSON.stringify({ content: "export const a = 1;\n", path: "src/a.ts" });
    const { toolResult, hasDuplicateAttempt } = buildDuplicateToolResult({
      toolName: "read_file",
      toolUseId: "tool-1",
      duplicateCheck: {
        reason: "Tool read_file was already called 3 times.",
        cachedResult: cached,
      },
      isIdempotentTool: () => true,
      suggestion: "",
    });

    const served = JSON.parse(String(toolResult.content));
    expect(hasDuplicateAttempt).toBe(false);
    expect(served._cached).toMatch(/Served from cache/);
    expect(served.content).toBe("export const a = 1;\n");
  });

  it("drops cached reads of a renamed or deleted file whatever the tool-semantics flag", () => {
    for (const toolSemanticsV2Enabled of [true, false]) {
      const executor = createFileOpExecutor();
      executor.toolSemanticsV2Enabled = toolSemanticsV2Enabled;
      readTwice(executor, "src/a.ts");
      readTwice(executor, "src/b.ts");

      recordFileOperation(executor, "delete_file", { path: "src/a.ts" }, { success: false });
      recordFileOperation(
        executor,
        "rename_file",
        { oldPath: "src/b.ts", newPath: "src/c.ts" },
        { success: false },
      );

      expect(checkFileOperation(executor, "read_file", { path: "src/a.ts" }).blocked).toBe(false);
      expect(checkFileOperation(executor, "read_file", { path: "src/b.ts" }).blocked).toBe(false);
    }
  });

  it("keeps cached reads of other files when one file is edited", () => {
    const executor = createFileOpExecutor();
    readTwice(executor, "src/a.ts");

    recordFileOperation(
      executor,
      "edit_file",
      { file_path: "src/b.ts", old_string: "b = 1", new_string: "b = 2" },
      { success: true, file_path: "src/b.ts", replacements: 1 },
    );

    expect(checkFileOperation(executor, "read_file", { path: "src/a.ts" }).blocked).toBe(true);
  });
});

describe("ToolFailureTracker browser HTTP status handling", () => {
  it("treats browser HTTP status failures as input-dependent (no immediate disable)", () => {
    const tracker = new ToolFailureTracker();

    for (let i = 0; i < 9; i++) {
      expect(tracker.recordFailure("browser_navigate", "Navigation failed with HTTP 403")).toBe(
        false,
      );
    }
    expect(tracker.isDisabled("browser_navigate")).toBe(false);

    expect(tracker.recordFailure("browser_navigate", "Navigation failed with HTTP 403")).toBe(true);
    expect(tracker.isDisabled("browser_navigate")).toBe(true);
  });

  it("still immediately disables non-browser non-retryable failures", () => {
    const tracker = new ToolFailureTracker();

    expect(tracker.recordFailure("web_fetch", "HTTP 429 rate limit exceeded")).toBe(true);
    expect(tracker.isDisabled("web_fetch")).toBe(true);
  });

  it("does not globally disable web_search for provider-scoped quota failures", () => {
    const tracker = new ToolFailureTracker();

    expect(
      tracker.recordFailure(
        "web_search",
        'Tavily API error: 432 - {"detail":{"error":"This request exceeds your plan\'s set usage limit"}}',
      ),
    ).toBe(false);
    expect(tracker.isDisabled("web_search")).toBe(false);
  });

  it("treats missing-module runtime errors as input-dependent before disabling monty_run", () => {
    const tracker = new ToolFailureTracker();

    for (let i = 0; i < 7; i++) {
      expect(
        tracker.recordFailure("monty_run", "ModuleNotFoundError: No module named 'datetime'"),
      ).toBe(false);
    }
    expect(tracker.isDisabled("monty_run")).toBe(false);

    expect(
      tracker.recordFailure("monty_run", "ModuleNotFoundError: No module named 'datetime'"),
    ).toBe(true);
    expect(tracker.isDisabled("monty_run")).toBe(true);
  });

  it("treats write_file runtime timeouts as systemic failures", () => {
    const tracker = new ToolFailureTracker();
    const message =
      "write_file timed out during enforce symlink safe access for PRIORITIES.md after 29500ms";

    expect(tracker.recordFailure("write_file", message)).toBe(false);
    expect(tracker.isDisabled("write_file")).toBe(false);

    expect(tracker.recordFailure("write_file", message)).toBe(true);
    expect(tracker.isDisabled("write_file")).toBe(true);
  });

  it("treats sandbox aborts from run_command as low-threshold systemic failures", () => {
    const tracker = new ToolFailureTracker();
    const message =
      "Shell sandbox failed before command completion: sandbox-exec aborted (exit 134)";

    expect(tracker.recordFailure("run_command", message)).toBe(false);
    expect(tracker.isDisabled("run_command")).toBe(false);

    expect(tracker.recordFailure("run_command", message)).toBe(true);
    expect(tracker.isDisabled("run_command")).toBe(true);
  });

  it("keeps ordinary empty run_command exits on the normal failure threshold", () => {
    const tracker = new ToolFailureTracker();
    const message =
      "Command exited with no output (exit 1). This can be normal for shell predicates such as test, false, or grep -q.";

    expect(tracker.recordFailure("run_command", message)).toBe(false);
    expect(tracker.isDisabled("run_command")).toBe(false);

    expect(tracker.recordFailure("run_command", message)).toBe(false);
    expect(tracker.isDisabled("run_command")).toBe(false);
  });

  it("immediately disables get_current_location after desktop geolocation provider failure", () => {
    const tracker = new ToolFailureTracker();
    const message =
      "Desktop geolocation timed out. Do not retry get_current_location in this task.";

    expect(tracker.recordFailure("get_current_location", message)).toBe(true);
    expect(tracker.isDisabled("get_current_location")).toBe(true);
  });
});
