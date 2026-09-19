/**
 * Tests for workspace-local tool policy hook (.cowork/policy/tools.monty)
 */

import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { evaluateMontyToolPolicy, TOOL_POLICY_UNAVAILABLE_REASON } from "../monty-tool-policy";

function workspaceAt(workspacePath: string): Any {
  return {
    id: `ws-${path.basename(workspacePath)}`,
    name: "WS",
    path: workspacePath,
    isTemp: false,
    permissions: { read: true, write: true, delete: false, network: false, shell: false },
  };
}

async function policyPath(workspacePath: string): Promise<string> {
  const policyDir = path.join(workspacePath, ".cowork", "policy");
  await fs.mkdir(policyDir, { recursive: true });
  return path.join(policyDir, "tools.monty");
}

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

    const workspace = workspaceAt(tmpDir);

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

  it("passes when no workspace policy file exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-missing-"));

    const result = await evaluateMontyToolPolicy({
      workspace: workspaceAt(tmpDir),
      toolName: "read_file",
      toolInput: { path: "README.md" },
    });

    expect(result).toEqual({ decision: "pass" });
  });

  it("passes when the configured policy path is not a regular file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-directory-"));
    await fs.mkdir(await policyPath(tmpDir));

    const result = await evaluateMontyToolPolicy({
      workspace: workspaceAt(tmpDir),
      toolName: "read_file",
      toolInput: { path: "README.md" },
    });

    // A directory at this path is "no policy configured", not a policy
    // failure. Denying here turned a checked-in directory named tools.monty
    // into a blanket deny for every tool in the workspace, with no
    // user-visible remediation path.
    expect(result).toEqual({ decision: "pass" });
  });

  it("denies malformed policy code with a stable unavailable reason", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-malformed-"));
    await fs.writeFile(await policyPath(tmpDir), "out = {", "utf8");

    const result = await evaluateMontyToolPolicy({
      workspace: workspaceAt(tmpDir),
      toolName: "read_file",
      toolInput: { path: "README.md" },
    });

    expect(result).toEqual({
      decision: "deny",
      reason: TOOL_POLICY_UNAVAILABLE_REASON,
    });
  });

  it("denies a policy runtime failure with a stable unavailable reason", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-runtime-"));
    await fs.writeFile(await policyPath(tmpDir), "out = 1 / 0", "utf8");

    const result = await evaluateMontyToolPolicy({
      workspace: workspaceAt(tmpDir),
      toolName: "read_file",
      toolInput: { path: "README.md" },
    });

    expect(result).toEqual({
      decision: "deny",
      reason: TOOL_POLICY_UNAVAILABLE_REASON,
    });
  });

  it("denies a policy that returns an invalid decision", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-policy-output-"));
    await fs.writeFile(await policyPath(tmpDir), 'out = {"decision": "unknown"}', "utf8");

    const result = await evaluateMontyToolPolicy({
      workspace: workspaceAt(tmpDir),
      toolName: "read_file",
      toolInput: { path: "README.md" },
    });

    expect(result).toEqual({
      decision: "deny",
      reason: TOOL_POLICY_UNAVAILABLE_REASON,
    });
  });
});
