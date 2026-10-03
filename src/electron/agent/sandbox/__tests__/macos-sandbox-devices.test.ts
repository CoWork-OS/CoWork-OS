import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Runs real sandbox-exec processes under the default workspace-write profile.
describe.skipIf(process.platform !== "darwin")("macOS sandbox device nodes", () => {
  let base: string;
  let workspace: Workspace;
  let originalHome: string | undefined;
  const sandboxes: MacOSSandbox[] = [];

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-devices-")));
    const root = path.join(base, "workspace");
    const home = path.join(base, "home");
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    // The profile and the command both read HOME; keep them off the real one.
    originalHome = process.env.HOME;
    process.env.HOME = home;
    workspace = {
      id: "sandbox-devices",
      name: "Sandbox devices",
      path: root,
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
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const run = async (command: string) => {
    const sandbox = new MacOSSandbox(workspace);
    sandboxes.push(sandbox);
    return sandbox.execute(command, [], { cwd: workspace.path, timeout: 30_000 });
  };

  it("lets shells redirect to and read from /dev/null", async () => {
    const result = await run(
      "echo hidden >/dev/null && ls /definitely-missing 2>/dev/null; : </dev/null && head -c 4 /dev/zero | wc -c",
    );
    expect(result.stderr).not.toContain("/dev/null");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("4");
  });

  it("lets a command write its own standard streams by path", async () => {
    const result = await run("echo out >/dev/stdout; echo err >/dev/stderr; echo fd >/dev/fd/1");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stdout).toContain("fd");
    expect(result.stderr).toContain("err");
  });

  it.skipIf(!hasGit)("runs read-only git commands, which open /dev/null read-write", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: workspace.path,
        env: { ...process.env, HOME: process.env.HOME },
        stdio: "ignore",
      });
    git("init", "-q");
    fs.writeFileSync(path.join(workspace.path, "tracked.txt"), "one\n");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "initial");
    fs.writeFileSync(path.join(workspace.path, "tracked.txt"), "two\n");

    const status = await run("git status --short");
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.stdout).toContain("M tracked.txt");

    const log = await run("git log --oneline -1 && git diff --stat");
    expect(log.exitCode, log.stderr).toBe(0);
    expect(log.stdout).toContain("initial");
    expect(log.stdout).toContain("tracked.txt");
  });

  it.skipIf(!hasGit)("still refuses writes into .git", async () => {
    execFileSync("git", ["init", "-q"], { cwd: workspace.path, stdio: "ignore" });
    const result = await run(
      "git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m blocked",
    );
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(workspace.path, ".git", "index.lock"))).toBe(false);
  });
});
