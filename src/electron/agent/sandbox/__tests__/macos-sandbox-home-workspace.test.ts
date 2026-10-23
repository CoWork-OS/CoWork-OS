import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

// Runs real sandbox-exec processes with the workspace set to a stand-in home folder.
describe.skipIf(process.platform !== "darwin")("macOS sandbox with a home-folder workspace", () => {
  let home: string;
  let originalHome: string | undefined;
  const sandboxes: MacOSSandbox[] = [];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-home-ws-")));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
    fs.writeFileSync(path.join(home, "notes.txt"), "hello");
    // The profile and the command both read HOME; keep them off the real one.
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = async (workspacePath: string, command: string) => {
    const workspace = {
      id: "sandbox-home-workspace",
      name: "Home",
      path: workspacePath,
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
    const sandbox = new MacOSSandbox(workspace);
    sandboxes.push(sandbox);
    return sandbox.execute(command, [], { cwd: workspacePath, timeout: 30_000 });
  };

  it("reads ordinary home files but not ~/.ssh", async () => {
    const notes = await run(home, `cat "${path.join(home, "notes.txt")}"`);
    expect(notes.exitCode, notes.stderr).toBe(0);
    expect(notes.stdout).toContain("hello");

    const key = await run(home, `cat "${path.join(home, ".ssh", "id_ed25519")}"`);
    expect(key.exitCode).not.toBe(0);
    expect(key.stdout).not.toContain("PRIVATE KEY");

    const write = await run(home, `echo planted > "${path.join(home, ".ssh", "authorized_keys")}"`);
    expect(write.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(home, ".ssh", "authorized_keys"))).toBe(false);
  });

  it("reads ~/.ssh when the workspace is ~/.ssh itself", async () => {
    const sshFolder = path.join(home, ".ssh");
    const key = await run(sshFolder, `cat "${path.join(sshFolder, "id_ed25519")}"`);
    expect(key.exitCode, key.stderr).toBe(0);
    expect(key.stdout).toContain("PRIVATE KEY");
  });
});
