import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalStepVerification, VerificationEvidenceEntry } from "../../../shared/types";
import { buildMemoryExecutionReceipt } from "../../memory/repo/memory-repo-execution-receipt";
import { TaskExecutor } from "../executor";
import { SessionRuntime } from "../runtime/SessionRuntime";

function harness(result = { success: true, exitCode: 0, stdout: "", stderr: "" }) {
  const entries: VerificationEvidenceEntry[] = [];
  const runtime = Object.create(SessionRuntime.prototype) as Any;
  runtime.state = { verification: { verificationEvidenceEntries: entries } };
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-verification" };
  executor.workspace = { path: os.tmpdir() };
  executor.daemon = {};
  executor.emitEvent = vi.fn();
  executor.canReadWorkspacePath = vi.fn().mockReturnValue(true);
  executor.getSessionRuntime = () => runtime;
  executor.toolRegistry = { executeTool: vi.fn().mockResolvedValue(result) };
  return {
    entries,
    executor,
    verify: (verification: ExternalStepVerification) =>
      executor.runStepExternalVerification(verification) as Promise<{
        success: boolean;
        message: string;
      }>,
    receipt: () =>
      buildMemoryExecutionReceipt({
        status: "completed",
        terminalStatus: "ok",
        evidenceBundle: { entries },
      }),
  };
}

describe("runtime verification evidence for memory", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the complete successful command through the runtime recorder", async () => {
    const run = harness();
    const command = "npm run test:upgrade -- --database fixtures/older-schema.db";
    expect(await run.verify({ type: "shell_command", command })).toMatchObject({ success: true });
    expect(run.receipt()?.checks).toEqual([
      {
        kind: "shell_command",
        detail: `Verification passed: ${command}`,
        capturedAt: expect.any(Number),
      },
    ]);
  });

  it("omits an overlong command instead of retaining a truncated target", async () => {
    const run = harness();
    const command = `npm run test -- ${"fixture-".repeat(180)}last-target`;
    expect(await run.verify({ type: "shell_command", command })).toMatchObject({ success: true });
    expect(run.entries[0].detail).toBe(`Verification passed: ${command}`);
    expect(run.entries[0].detail.length).toBeGreaterThan(1_200);
    expect(run.receipt()).toBeUndefined();
  });

  it("does not trust a zero exit code when command execution reports failure", async () => {
    const run = harness({ success: false, exitCode: 0, stdout: "", stderr: "execution failed" });
    expect(await run.verify({ type: "shell_command", command: "npm test" })).toMatchObject({
      success: false,
    });
    expect(run.receipt()).toBeUndefined();
  });

  it("keeps a complete HTTP target past the old display cap", async () => {
    const run = harness({ success: true, exitCode: 0, stdout: "200", stderr: "" });
    const httpUrl = `https://example.test/${"checked-path/".repeat(25)}health`;
    expect(await run.verify({ type: "http_head", httpUrl })).toMatchObject({ success: true });
    expect(run.receipt()?.checks[0].detail).toBe(`HTTP 200 for ${httpUrl}`);
  });

  it("omits an overlong HTTP target instead of retaining a partial URL", async () => {
    const run = harness({ success: true, exitCode: 0, stdout: "200", stderr: "" });
    const httpUrl = `https://example.test/${"checked-path/".repeat(110)}health`;
    expect(await run.verify({ type: "http_head", httpUrl })).toMatchObject({ success: true });
    expect(run.entries[0].detail).toBe(`HTTP 200 for ${httpUrl}`);
    expect(run.receipt()).toBeUndefined();
  });

  it.each([
    { success: false, exitCode: 22, stdout: "200", stderr: "curl failed" },
    { success: true, exitCode: 22, stdout: "200", stderr: "curl failed" },
    { success: false, exitCode: 0, stdout: "200", stderr: "execution failed" },
  ])(
    "does not treat a status printed by unsuccessful HTTP execution as proof: %j",
    async (result) => {
      const run = harness(result);
      expect(
        await run.verify({ type: "http_head", httpUrl: "https://example.test/health" }),
      ).toMatchObject({ success: false });
      expect(run.entries[0].ok).toBe(false);
      expect(run.receipt()).toBeUndefined();
    },
  );

  it("does not produce an existence receipt when no paths were checked", async () => {
    const run = harness();
    await run.verify({ type: "file_exists", filePaths: [] });
    expect(run.entries.every((entry) => entry.kind !== "file_exists")).toBe(true);
    expect(run.receipt()).toBeUndefined();
  });

  it("retains the explicit checked paths for successful existence checks", async () => {
    const run = harness();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-verification-evidence-"));
    temporaryDirectories.push(directory);
    run.executor.workspace.path = directory;
    fs.writeFileSync(path.join(directory, "report.md"), "A report");
    expect(await run.verify({ type: "file_exists", filePaths: ["report.md"] })).toMatchObject({
      success: true,
    });
    expect(run.receipt()?.checks[0]).toMatchObject({
      kind: "file_exists",
      detail: 'All required files exist (existence only): "report.md"',
    });
  });
});
