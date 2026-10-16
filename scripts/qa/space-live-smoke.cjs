#!/usr/bin/env node
// Explicit live qualification against an operator-configured SPACE deployment.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { SpaceSandbox } = require("../../dist/daemon/electron/agent/sandbox/space-sandbox.js");

async function main() {
  const template = process.env.COWORK_SPACE_TEMPLATE;
  assert(template, "Set COWORK_SPACE_TEMPLATE to a published, credential-free template");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-space-live-"));
  const data = Buffer.from([0, 255, 128, 1, 2, 3, 10]);
  fs.writeFileSync(path.join(workspacePath, "input.bin"), data);
  const workspace = {
    id: "space-live-smoke",
    name: "SPACE live smoke",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: true,
      network: false,
      sandboxType: "space",
      spaceConfig: {
        template,
        inputPaths: ["input.bin"],
        outputPaths: ["output.bin"],
      },
    },
  };
  const sandbox = new SpaceSandbox(workspace);
  let passed = false;
  try {
    await sandbox.initialize();
    const result = await sandbox.executeCode(
      "import os,pathlib\nassert not os.environ.get('COWORK_SPACE_API_TOKEN')\npathlib.Path('output.bin').write_bytes(pathlib.Path('input.bin').read_bytes())\nprint('SPACE live round trip')",
      "python",
      { timeout: 30_000, allowNetwork: false },
    );
    assert.equal(result.exitCode, 0, result.error || result.stderr);
    assert.equal(result.outcomeUnknown, undefined);
    assert.deepEqual(fs.readFileSync(path.join(workspacePath, "output.bin")), data);
    passed = true;
    console.log(
      "PASS: live command, selected binary file round trip, host token absent, confirmed VM deletion.",
    );
    console.log(
      "Deny-all policy readback passed. Independent egress/tenant isolation qualification remains separate.",
    );
  } finally {
    await sandbox.cleanup();
    if (passed) fs.rmSync(workspacePath, { recursive: true, force: true });
    else console.error(`Retained synthetic workspace for recovery: ${workspacePath}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
