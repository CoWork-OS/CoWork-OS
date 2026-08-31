import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChildProcess } from "child_process";
import type { Workspace } from "../../../../shared/types";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { MacOSSandbox } from "../macos-sandbox";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: "/tmp/cowork workspace",
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: true,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
    },
    settings: {
      useGuardrails: true,
      guardrails: {
        blockDangerousCommands: true,
        customBlockedPatterns: [],
        autoApproveTrustedCommands: false,
        trustedCommandPatterns: [],
        enforceAllowedDomains: false,
        allowedDomains: [],
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeChildProcess(
  options: {
    closeCode?: number;
    stdout?: string;
    stderr?: string;
    errorMessage?: string;
  } = {},
): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => {
    if (options.stdout) proc.stdout?.emit("data", Buffer.from(options.stdout));
    if (options.stderr) proc.stderr?.emit("data", Buffer.from(options.stderr));
    if (options.errorMessage) {
      proc.emit("error", new Error(options.errorMessage));
      return;
    }
    proc.emit("close", options.closeCode ?? 0, null);
  });
  return proc;
}

describe("MacOSSandbox", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeChildProcess());
  });

  it("passes multiline shell commands as a single -c argument to sandbox-exec", async () => {
    const sandbox = new MacOSSandbox(makeWorkspace());
    const command = "mkdir -p out && cat > out/viewer.html <<'EOF'\n<html></html>\nEOF";

    const result = await sandbox.execute(command, [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = spawnMock.mock.calls[0];
    expect(bin).toBe("sandbox-exec");
    expect(args.slice(2)).toEqual(["/bin/sh", "-c", command]);
    expect(options.shell).toBe(false);
  });

  it("passes explicit command arguments directly through sandbox-exec", async () => {
    const sandbox = new MacOSSandbox(makeWorkspace());

    const result = await sandbox.execute("node", ["script.js", "--flag"], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    expect(result.exitCode).toBe(0);
    const [bin, args, options] = spawnMock.mock.calls[0];
    expect(bin).toBe("sandbox-exec");
    expect(args.slice(2)).toEqual(["node", "script.js", "--flag"]);
    expect(options.shell).toBe(false);
  });

  it("allows the minimal macOS paths required to launch /bin/sh", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const sandbox = new MacOSSandbox(makeWorkspace());

    const resultPromise = sandbox.execute("pwd", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    expect(profile).toContain('(literal "/")');
    expect(profile).toContain('(subpath "/private/var/select")');

    proc.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("allows Homebrew launchers to resolve the /opt mount point", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const sandbox = new MacOSSandbox(makeWorkspace());

    const resultPromise = sandbox.execute("python3", ["-c", "print(123)"], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    expect(profile).toContain('(literal "/opt")');
    expect(profile).toContain('(subpath "/opt/homebrew")');
    expect(profile).not.toContain('(subpath "/opt")');

    proc.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("reports nonzero sandbox process exits", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeChildProcess({ closeCode: 2, stderr: "command failed\n" }),
    );
    const sandbox = new MacOSSandbox(makeWorkspace());

    const result = await sandbox.execute("false", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("command failed\n");
    expect(result.timedOut).toBe(false);
  });

  it("reports sandbox spawn errors", async () => {
    spawnMock.mockImplementationOnce(() => makeChildProcess({ errorMessage: "spawn failed" }));
    const sandbox = new MacOSSandbox(makeWorkspace());

    const result = await sandbox.execute("echo ok", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("spawn failed");
    expect(result.error).toBe("spawn failed");
  });

  it("rejects a denied profile path before spawning sandbox-exec", async () => {
    const sandbox = new MacOSSandbox(
      makeWorkspace({
        permissions: {
          ...makeWorkspace().permissions,
          accessFilesystemRules: [{ path: "/tmp/cowork workspace/secrets", access: "deny" }],
        },
      }),
    );

    const result = await sandbox.execute("echo ok", [], {
      cwd: "/tmp/cowork workspace/secrets",
      timeout: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 1,
      error: "Path access denied",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("allows both /var and /private/var aliases in generated sandbox profiles", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const workspacePath = "/var/folders/test/cowork workspace";
    const sandbox = new MacOSSandbox(makeWorkspace({ path: workspacePath }));

    const resultPromise = sandbox.execute("echo ok", [], {
      cwd: workspacePath,
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf-8");
    expect(profile).toContain("/var/folders/test/cowork workspace");
    expect(profile).toContain("/private/var/folders/test/cowork workspace");
    expect(profile).not.toContain('(allow file-read* (subpath "/private/var/folders"))');

    proc.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("isolates host temp access for finite profiles while allowing explicit script inputs", async () => {
    const scriptPath = path.join(os.tmpdir(), `cowork-scoped-script-${Date.now()}.js`);
    fs.writeFileSync(scriptPath, "console.log('ok')", "utf8");
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);

    try {
      const workspace = makeWorkspace({
        permissions: {
          ...makeWorkspace().permissions,
          accessProfileId: "scoped-profile",
          accessProfileScoped: true,
          accessFilesystemScoped: true,
          accessWorkspaceRoots: ["/tmp/cowork workspace/allowed"],
        },
      });
      const sandbox = new MacOSSandbox(workspace);
      const resultPromise = sandbox.execute("node", [scriptPath], {
        cwd: workspace.path,
        timeout: 1000,
        allowedReadPaths: [scriptPath],
      });

      const [, args] = spawnMock.mock.calls[0];
      const profile = fs.readFileSync(args[1], "utf8");
      expect(profile).not.toContain('(subpath "/private/tmp")');
      expect(profile).not.toContain('(subpath "/private/var/folders")');
      expect(profile).toContain(scriptPath);
      expect(profile).toContain("cowork-sandbox-");

      proc.emit("close", 0, null);
      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
      sandbox.cleanup();
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });
});
