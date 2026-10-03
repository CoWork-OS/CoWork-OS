/**
 * Background and foreground commands in the real macOS sandbox with shell
 * networking denied: loopback servers work, others are stopped.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      allowedSandboxTypes: ["macos"],
      requireSandboxForShell: true,
      allowUnsandboxedShell: false,
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
    },
  })),
}));

import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { ShellTools } from "../shell-tools";
import { getBackgroundProcessManager } from "../background-processes";
import type { AgentDaemon } from "../../daemon";
import type { Workspace } from "../../../../shared/types";

const node = JSON.stringify(process.execPath);

function serverCommand(host: string): string {
  const script = `const s = require("net").createServer((c) => c.end("pong")); s.listen(0, "${host}", () => console.log("listening on port " + s.address().port));`;
  return `${node} -e '${script}'`;
}

function fetchOnce(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe.skipIf(process.platform !== "darwin")(
  "shell commands serving on loopback in the macOS sandbox",
  () => {
    let base: string;
    let workspace: Workspace;
    const taskIds: string[] = [];

    function newShellTools() {
      const taskId = `task-${randomUUID()}`;
      taskIds.push(taskId);
      const daemon = { requestApproval: vi.fn().mockResolvedValue(true), logEvent: vi.fn() };
      return new ShellTools(workspace, daemon as unknown as AgentDaemon, taskId);
    }

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-shell-loopback-"));
      const root = path.join(base, "workspace");
      fs.mkdirSync(root);
      workspace = {
        id: "shell-loopback",
        name: "Shell loopback",
        path: root,
        permissions: {
          read: true,
          write: true,
          delete: true,
          shell: true,
          network: false,
          accessSandboxMode: "workspace-write",
          sandboxType: "macos",
        },
        createdAt: 0,
      } as Workspace;
      vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({ blocked: false });
      vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({ trusted: false });
      vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);
      vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
        "per_command",
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      for (const taskId of taskIds.splice(0)) {
        await getBackgroundProcessManager().stopAllForTask(taskId, "test_cleanup");
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("serves a background loopback server the host can reach", async () => {
      const shellTools = newShellTools();
      const started = await shellTools.startBackgroundCommand(serverCommand("127.0.0.1"), {
        cwd: workspace.path,
      });

      expect(started).toMatchObject({ success: true, running: true, sandbox: "macos" });
      expect(String((started.notes as string[])[0])).toMatch(/127\.0\.0\.1\/localhost/);
      const port = Number(String(started.startup_output).match(/port (\d+)/)?.[1]);
      expect(port).toBeGreaterThan(0);
      expect(await fetchOnce(port)).toBe("pong");
    }, 30_000);

    it("stops a background server that listens on all interfaces", async () => {
      const shellTools = newShellTools();
      const started = await shellTools.startBackgroundCommand(serverCommand("0.0.0.0"), {
        cwd: workspace.path,
      });
      const processId = started.process_id as string;
      const manager = getBackgroundProcessManager();
      const deadline = Date.now() + 10_000;
      let status = await shellTools.getBackgroundProcessOutput({
        process_id: processId,
        since_offset: 0,
      });
      while (status.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await shellTools.getBackgroundProcessOutput({
          process_id: processId,
          since_offset: 0,
        });
      }

      expect(status).toMatchObject({
        running: false,
        status: "stopped",
        stop_reason: "listened_on_non_loopback_address",
      });
      expect(status.output).toMatch(/listened on \*\.\d+/);
      expect(manager.list("nobody")).toEqual([]);
    }, 30_000);

    it("lets a foreground test server listen on loopback with networking denied", async () => {
      const shellTools = newShellTools();
      const script =
        'const s = require("net").createServer((c) => c.end("pong")); s.listen(0, "127.0.0.1", () => { require("net").connect(s.address().port, "127.0.0.1").on("data", (d) => { console.log("got " + d); process.exit(0); }); });';

      const result = await shellTools.runCommand(`${node} -e '${script}'`, {
        cwd: workspace.path,
        timeout: 20_000,
      });

      expect(result).toMatchObject({ success: true, exitCode: 0 });
      expect(result.stdout).toContain("got pong");
    }, 30_000);

    it("stops a foreground command that listens on all interfaces", async () => {
      const shellTools = newShellTools();
      const startedAt = Date.now();

      const result = await shellTools.runCommand(`${serverCommand("0.0.0.0")}; true`, {
        cwd: workspace.path,
        timeout: 20_000,
      });

      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(result).toMatchObject({ success: false, terminationReason: "error" });
      expect(result.stderr).toMatch(/listened on \*\.\d+ .*Bind servers to 127\.0\.0\.1/s);
    }, 30_000);
  },
);
