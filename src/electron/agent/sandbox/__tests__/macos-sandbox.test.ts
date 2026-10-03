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

  it("grants /dev/null and the standard streams for data, but not the terminal", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const sandbox = new MacOSSandbox(makeWorkspace());
    const resultPromise = sandbox.execute("git status", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    proc.emit("close", 0, null);
    await resultPromise;
    const deviceRule = profile.slice(profile.indexOf("(allow file-read* file-write-data"));
    expect(deviceRule).toMatch(/^\(allow file-read\* file-write-data\n {2}\(literal "\/dev\/null"\)/);
    expect(deviceRule.slice(0, deviceRule.indexOf("\n)\n"))).toContain('(subpath "/dev/fd")');
    expect(profile).not.toContain('"/dev/tty"');
    expect(profile).not.toMatch(/file-write\*[^\n]*\/dev\//);
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

  it("scopes the localhost network exception to loopback outbound sockets", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const sandbox = new MacOSSandbox(makeWorkspace());

    const resultPromise = sandbox.execute("echo ok", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    expect(profile).toContain('(allow network-outbound\n  (remote tcp "localhost:*")');
    expect(profile).toContain('(remote udp "localhost:*")');
    expect(profile).not.toContain('(allow network* (local ip "localhost:*"))');

    proc.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
  });

  describe("loopback servers with network denied", () => {
    const LISTEN_RULES = [
      '(allow network-bind (local tcp "localhost:*"))',
      '(allow network-inbound (local tcp "localhost:*"))',
    ];

    function profileFor(options: { allowNetwork?: boolean; allowLoopbackListen?: boolean }) {
      const workspace = makeWorkspace();
      workspace.permissions.network = options.allowNetwork === true;
      const sandbox = new MacOSSandbox(workspace);
      const { process: proc } = sandbox.spawnProcess("/bin/sh", ["-c", "true"], {
        cwd: "/tmp/cowork workspace",
        ...options,
      });
      const [, args] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      const profile = fs.readFileSync(args[1], "utf8");
      proc.emit("close", 0, null);
      return profile;
    }

    it("keeps listening denied unless the caller opts in", () => {
      const profile = profileFor({});
      for (const rule of LISTEN_RULES) expect(profile).not.toContain(rule);
      expect(profile).toContain("(deny network*)");
    });

    it("allows TCP listening, keeps egress loopback-only and leaves UDP binds denied", () => {
      const profile = profileFor({ allowLoopbackListen: true });
      for (const rule of LISTEN_RULES) expect(profile).toContain(rule);
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain('(allow network-outbound\n  (remote tcp "localhost:*")');
      expect(profile).not.toContain("(allow network*)");
      expect(profile).not.toMatch(/\(local (?:ip|udp) "/);
      expect(profile).not.toContain('(local tcp "*:*")');
    });

    it("needs no listen rule when network is already allowed", () => {
      const profile = profileFor({ allowNetwork: true, allowLoopbackListen: true });
      expect(profile).toContain("(allow network*)");
      for (const rule of LISTEN_RULES) expect(profile).not.toContain(rule);
    });
  });

  it("starts long-running processes in their own process group only when asked", () => {
    const sandbox = new MacOSSandbox(makeWorkspace());
    sandbox.spawnProcess("/bin/sh", ["-c", "true"], { cwd: "/tmp/cowork workspace" });
    sandbox.spawnProcess("/bin/sh", ["-c", "true"], {
      cwd: "/tmp/cowork workspace",
      detached: true,
    });

    expect(spawnMock.mock.calls[0][2]).toMatchObject({ detached: false });
    expect(spawnMock.mock.calls[1][2]).toMatchObject({ detached: true });
  });

  it("runs commands with non-interactive defaults without overriding passed-through values", async () => {
    const previousPager = process.env.PAGER;
    process.env.PAGER = "less";
    try {
      const sandbox = new MacOSSandbox(makeWorkspace());
      await sandbox.execute("git commit", [], {
        cwd: "/tmp/cowork workspace",
        timeout: 1000,
        envPassthrough: ["PATH", "HOME", "PAGER"],
      });

      const [, , options] = spawnMock.mock.calls[0];
      expect(options.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_PAGER: "cat",
        PAGER: "less",
        PIP_NO_INPUT: "1",
        DEBIAN_FRONTEND: "noninteractive",
      });
      expect(options.env.CI).toBeUndefined();
    } finally {
      if (previousPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = previousPager;
    }
  });

  it("keeps the start and the end of long command output", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const sandbox = new MacOSSandbox(makeWorkspace());

    const resultPromise = sandbox.execute("npm test", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
      maxOutputSize: 1_000,
    });
    proc.stdout?.emit("data", Buffer.from(`RUN v1\n${"ok\n".repeat(2_000)}`));
    proc.stdout?.emit("data", Buffer.from("FAIL src/x.test.ts > adds\n"));
    proc.stderr?.emit("data", Buffer.from("short stderr"));
    proc.emit("close", 1, null);
    const result = await resultPromise;

    expect(result.stdout.startsWith("RUN v1")).toBe(true);
    expect(result.stdout).toContain("FAIL src/x.test.ts > adds");
    expect(result.stdout).toMatch(/\[Output truncated\] \[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(result.stdout.length).toBeLessThan(1_100);
    expect(result.stderr).toBe("short stderr");
    expect(result.truncated).toBe(true);
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

  it("does not let a disabled read capability fall through to host temp access", async () => {
    const workspace = makeWorkspace({
      permissions: {
        ...makeWorkspace().permissions,
        read: false,
      },
    });
    const sandbox = new MacOSSandbox(workspace);

    const result = await sandbox.execute("echo ok", [], {
      cwd: os.tmpdir(),
      timeout: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 1,
      error: "Path access denied",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses execution when no sandbox profile is available", async () => {
    const sandbox = new MacOSSandbox(makeWorkspace());
    const internals = sandbox as unknown as {
      generateSandboxProfile: () => string | undefined;
    };
    internals.generateSandboxProfile = () => undefined;

    const result = await sandbox.execute("echo should-not-run", [], {
      cwd: "/tmp/cowork workspace",
      timeout: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 1,
      error: "Sandbox profile unavailable",
    });
    expect(result.stderr).toContain("refusing unsandboxed execution");
    expect(spawnMock).not.toHaveBeenCalled();
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

  it("allows literal ancestors for workspaces under /private without opening /private/tmp", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);
    const workspacePath = "/private/tmp/cowork-real-use-qa/developer";
    const sandbox = new MacOSSandbox(
      makeWorkspace({
        path: workspacePath,
        permissions: {
          ...makeWorkspace().permissions,
          accessProfileId: "scoped-profile",
          accessProfileScoped: true,
          accessFilesystemScoped: true,
          accessWorkspaceRoots: [workspacePath],
        },
      }),
    );

    const resultPromise = sandbox.execute("pwd", [], {
      cwd: workspacePath,
      timeout: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    expect(profile).toContain('(literal "/private")');
    expect(profile).toContain('(literal "/private/tmp")');
    expect(profile).not.toContain('(subpath "/private/tmp")');

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

  it.each(["workspace-write", "read-only"] as const)(
    "bounds host temp access for the %s named sandbox mode",
    async (accessSandboxMode) => {
      const proc = new EventEmitter() as ChildProcess;
      proc.stdout = new EventEmitter() as ChildProcess["stdout"];
      proc.stderr = new EventEmitter() as ChildProcess["stderr"];
      proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
      spawnMock.mockImplementationOnce(() => proc);

      const workspace = makeWorkspace({
        permissions: {
          ...makeWorkspace().permissions,
          accessProfileId: `named-${accessSandboxMode}`,
          accessSandboxMode,
        },
      });
      const sandbox = new MacOSSandbox(workspace);
      const resultPromise = sandbox.execute("echo ok", [], {
        cwd: workspace.path,
        timeout: 1000,
      });

      const [, args] = spawnMock.mock.calls[0];
      const profile = fs.readFileSync(args[1], "utf8");
      expect(profile).not.toContain('  (subpath "/private/tmp")');
      expect(profile).not.toContain('  (subpath "/private/var/folders")');
      expect(profile).toContain("cowork-sandbox-");

      proc.emit("close", 0, null);
      await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
      sandbox.cleanup();
    },
  );

  it("places executeCode sources in the private runtime temp directory", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementationOnce(() => proc);

    const workspace = makeWorkspace({
      permissions: {
        ...makeWorkspace().permissions,
        accessProfileId: "named-workspace-write",
        accessSandboxMode: "workspace-write",
      },
    });
    const sandbox = new MacOSSandbox(workspace);
    const resultPromise = sandbox.executeCode("print('ok')", "python");

    const [, args] = spawnMock.mock.calls[0];
    const profile = fs.readFileSync(args[1], "utf8");
    const sourcePath = args[3] as string;
    expect(sourcePath).toContain("cowork-sandbox-");
    expect(profile).toContain(sourcePath);

    proc.stdout?.emit("data", Buffer.from("ok\n"));
    proc.emit("close", 0, null);
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(fs.existsSync(sourcePath)).toBe(false);
    sandbox.cleanup();
  });
});
