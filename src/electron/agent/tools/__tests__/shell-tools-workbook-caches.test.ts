/**
 * run_command restores the formula results a workbook-editing script (openpyxl) drops on save.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { testUserDataDir } = vi.hoisted(() => ({
  testUserDataDir: `/tmp/cowork-shell-tools-workbook-test-${process.pid}-${Date.now()}`,
}));

vi.mock("../../../utils/user-data-dir", () => ({
  getUserDataDir: () => testUserDataDir,
}));

vi.mock("../../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      allowedSandboxTypes: ["macos", "docker"],
      requireSandboxForShell: false,
      allowUnsandboxedShell: false,
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: true,
      },
    },
  })),
}));

vi.mock("../../sandbox/sandbox-factory", () => ({
  createSandbox: vi.fn(async () => {
    throw new Error("full-access commands in this test must not use the OS sandbox");
  }),
}));

import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { ShellSessionManager } from "../shell-session-manager";
import { ShellTools } from "../shell-tools";
import type { AgentDaemon } from "../../daemon";
import type { Workspace } from "../../../../shared/types";
import { buildOpenpyxlStyleWorkbook } from "../../../utils/document-generators/__tests__/openpyxl-style-workbook";

const workspacePath = path.join(testUserDataDir, "workspace");

function createWorkspace(write = true): Workspace {
  return {
    id: `workspace-${randomUUID()}`,
    name: "Workbook caches",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: {
      shell: true,
      read: true,
      write,
      delete: true,
      network: true,
      accessSandboxMode: "danger-full-access",
      accessApprovalPolicy: "never",
    },
  } as Workspace;
}

async function cachedResult(file: string, sheet: string, address: string): Promise<unknown> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  return workbook.getWorksheet(sheet)!.getCell(address).result;
}

describe.skipIf(process.platform === "win32")("run_command and workbook formula results", () => {
  const sessions: Array<{ taskId: string; workspaceId: string }> = [];

  beforeEach(async () => {
    await mkdir(path.join(workspacePath, "staging"), { recursive: true });
    // The "script" output: a workbook saved the way openpyxl saves it, without results.
    await writeFile(
      path.join(workspacePath, "staging", "formatted.xlsx"),
      await buildOpenpyxlStyleWorkbook(),
    );
    vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({ blocked: false });
    vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({ trusted: false });
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "per_command",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const manager = ShellSessionManager.getInstance();
    for (const { taskId, workspaceId } of sessions.splice(0)) {
      const session = manager.getSessionInfo(taskId, workspaceId);
      if (session) await manager.stopSessionById(session.id);
    }
    await rm(testUserDataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  function shellTools(workspace: Workspace): ShellTools {
    const taskId = `task-${randomUUID()}`;
    sessions.push({ taskId, workspaceId: workspace.id });
    const daemon = { requestApproval: vi.fn().mockResolvedValue(true), logEvent: vi.fn() };
    return new ShellTools(workspace, daemon as unknown as AgentDaemon, taskId);
  }

  it("restores the results of formulas in a workbook the command saved", async () => {
    const target = path.join(workspacePath, "Northstar-pilot-costs.xlsx");

    const result = await shellTools(createWorkspace()).runCommand(
      "cp staging/formatted.xlsx Northstar-pilot-costs.xlsx",
      { cwd: workspacePath, timeout: 20_000 },
    );

    expect(result.success).toBe(true);
    expect(result.workbookNotes).toEqual([
      expect.stringContaining(
        "Northstar-pilot-costs.xlsx: restored the saved results of 11 formula cell(s)",
      ),
    ]);
    expect(result.workbookNotes?.[0]).toContain("4 cell(s) hold text with a date number format");
    expect(await cachedResult(target, "Expenses", "F2")).toBe(27.6);
    expect(await cachedResult(target, "Expenses", "F5")).toBe(0);
    expect(await cachedResult(target, "Summary", "B2")).toBe(225.5);
    // The command names the staged copy but does not change it, so it is left as it was.
    expect(
      await cachedResult(path.join(workspacePath, "staging", "formatted.xlsx"), "Expenses", "F2"),
    ).toBeUndefined();
  }, 30_000);

  it("leaves workbooks alone when the command did not change them", async () => {
    await writeFile(path.join(workspacePath, "untouched.xlsx"), await buildOpenpyxlStyleWorkbook());

    const result = await shellTools(createWorkspace()).runCommand("echo done", {
      cwd: workspacePath,
      timeout: 20_000,
    });

    expect(result.workbookNotes).toBeUndefined();
    expect(
      await cachedResult(path.join(workspacePath, "untouched.xlsx"), "Expenses", "F2"),
    ).toBeUndefined();
  }, 30_000);
});
