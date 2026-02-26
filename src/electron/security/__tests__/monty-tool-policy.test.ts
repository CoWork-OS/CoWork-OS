/**
 * Tests for workspace-local tool policy hook (.cowork/policy/tools.monty)
 */

import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { evaluateMontyToolPolicy } from "../monty-tool-policy";

describe("evaluateMontyToolPolicy", () => {
  it("can deny a specific tool by name", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-"));
    const policyDir = path.join(tmpDir, ".cowork", "policy");
    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      path.join(policyDir, "tools.monty"),
      [
        'out = {"decision": "pass"}',
        'if input["tool"] == "run_command":',
        '  out = {"decision": "deny", "reason": "shell disabled"}',
        "out",
      ].join("\n"),
      "utf8",
    );

    const workspace: Any = {
      id: "ws1",
      name: "WS",
      path: tmpDir,
      isTemp: false,
      permissions: { read: true, write: true, delete: false, network: false, shell: false },
    };

    const denied = await evaluateMontyToolPolicy({
      workspace,
      toolName: "run_command",
      toolInput: { command: "echo hi" },
      gatewayContext: "private",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("shell disabled");

    const allowed = await evaluateMontyToolPolicy({
      workspace,
      toolName: "read_file",
      toolInput: { path: "README.md" },
      gatewayContext: "private",
    });
    expect(allowed.decision).toBe("pass");
  });
});
