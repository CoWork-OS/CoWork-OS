import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { DockerSandbox } from "../docker-sandbox";

// Opt in with an already-installed image; this suite never initializes/pulls.
const image = process.env.COWORK_SANDBOX_TEST_DOCKER_IMAGE;
describe.skipIf(!image)("Docker filesystem policy execution", () => {
  let base: string;
  let workspace: Workspace;
  const sandboxes: DockerSandbox[] = [];
  beforeEach(() => {
    expect(spawnSync("docker", ["image", "inspect", image!], { timeout: 5000 }).status).toBe(0);
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-docker-live-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "input.txt"), "original");
    workspace = {
      id: "policy-test",
      name: "Policy test",
      path: root,
      permissions: { read: true, write: false, delete: false, shell: true, network: false },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });
  const makeSandbox = () => {
    const sandbox = new DockerSandbox(workspace, { image });
    // Image availability was proved above; avoid initialize's pull behavior.
    Object.assign(sandbox, { initialized: true });
    sandboxes.push(sandbox);
    return sandbox;
  };

  it("reads host input, refuses host writes, and writes to private container scratch", async () => {
    const result = await makeSandbox().execute("node", [
      "-e",
      "const fs=require('fs');console.log(fs.readFileSync('/workspace/input.txt','utf8'));let denied=false;try{fs.writeFileSync('/workspace/input.txt','changed')}catch(e){denied=e.code==='EROFS'||e.code==='EACCES'}if(!denied)process.exit(2);fs.writeFileSync('/tmp/output.txt','ok');console.log(fs.readFileSync('/tmp/output.txt','utf8'))",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("original");
    expect(result.stdout).toContain("ok");
    expect(fs.readFileSync(path.join(workspace.path, "input.txt"), "utf8")).toBe("original");
  }, 15000);

  it("keeps host-read-disabled workspaces ephemeral and writable", async () => {
    workspace.permissions.read = false;
    workspace.permissions.write = true;
    const result = await makeSandbox().execute("node", [
      "-e",
      "const fs=require('fs');if(fs.existsSync('/workspace/input.txt'))process.exit(2);fs.writeFileSync('/workspace/output.txt','ephemeral');console.log('ok')",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(workspace.path, "output.txt"))).toBe(false);
  }, 15000);

  it("writes an approved regular-file mount while unlink and replacement remain blocked", async () => {
    const output = path.join(base, "output.txt");
    fs.writeFileSync(output, "original");
    workspace.permissions.write = true;
    workspace.permissions.accessFilesystemRules = [
      { path: workspace.path, access: "read" },
      { path: output, access: "write" },
    ];
    const result = await makeSandbox().execute(
      "node",
      [
        "-e",
        "const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,'updated');let denied=false;try{fs.unlinkSync(p)}catch(e){denied=true}if(!denied)process.exit(2);console.log('ok')",
        output,
      ],
      { allowedWritePaths: [output] },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe("updated");
  }, 15000);

  it("preserves ordinary external directory writes and deletes when fully granted", async () => {
    const external = path.join(base, "external");
    fs.mkdirSync(external);
    workspace.permissions.write = true;
    workspace.permissions.delete = true;
    workspace.permissions.accessWorkspaceRoots = [external];
    workspace.permissions.accessFilesystemRules = [{ path: workspace.path, access: "read" }];
    const result = await makeSandbox().execute("node", [
      "-e",
      "const fs=require('fs'),path=require('path'),p=path.join(process.argv[1],'output');fs.writeFileSync(p,'ok');fs.unlinkSync(p);console.log('ok')",
      external,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 15000);

  it("refuses a writable mount that can retarget a denied rule outside its canonical subtree", async () => {
    const external = path.join(base, "external");
    const hidden = path.join(base, "hidden");
    fs.mkdirSync(external);
    fs.mkdirSync(hidden);
    const secret = path.join(external, "secret");
    fs.writeFileSync(secret, "original");
    const link = path.join(external, "policy-link");
    fs.symlinkSync(hidden, link);
    workspace.permissions.write = true;
    workspace.permissions.delete = true;
    workspace.permissions.accessWorkspaceRoots = [external];
    workspace.permissions.accessFilesystemRules = [
      { path: workspace.path, access: "read" },
      { path: link, access: "deny" },
    ];
    let processes = 0;
    const result = await makeSandbox().execute(
      "node",
      [
        "-e",
        "const fs=require('fs'),path=require('path'),b=process.argv[1];fs.unlinkSync(path.join(b,'policy-link'));fs.symlinkSync('secret',path.join(b,'policy-link'));fs.writeFileSync(path.join(b,'secret'),'changed')",
        external,
      ],
      {
        onProcess: () => {
          processes++;
        },
      },
    );
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("policy path resolution");
    expect(processes).toBe(0);
    expect(fs.readFileSync(secret, "utf8")).toBe("original");
  }, 15000);
});
