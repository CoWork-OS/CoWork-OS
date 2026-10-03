import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runs real sandbox-exec processes: a timeout must end the command, not only its shell.
describe.skipIf(process.platform !== "darwin")("macOS sandbox command timeouts", () => {
  let base: string;
  let workspace: Workspace;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-timeout-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    workspace = {
      id: "sandbox-timeout",
      name: "Sandbox timeout",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("stops the child processes of a timed-out command", async () => {
    const sandbox = new MacOSSandbox(workspace);
    const startedAt = Date.now();
    try {
      const result = await sandbox.execute('sleep 20 & echo "child:$!"; wait', [], {
        cwd: workspace.path,
        timeout: 1_000,
      });

      expect(result.timedOut).toBe(true);
      // Without killing the tree, the orphaned child keeps the output pipes open
      // and the call returns only when it exits on its own.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      const childPid = Number(result.stdout.match(/child:(\d+)/)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      expect(isRunning(childPid)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  }, 30_000);
});
