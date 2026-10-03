import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Workspace } from "../../../../shared/types";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { DockerSandbox } from "../docker-sandbox";

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

describe("DockerSandbox access-profile enforcement", () => {
  const fixtureRoots: string[] = [];
  const fixture = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-docker-policy-"));
    fixtureRoots.push(base);
    const workspacePath = path.join(base, "workspace");
    const external = path.join(base, "external");
    fs.mkdirSync(workspacePath);
    fs.mkdirSync(external);
    const workspace = makeWorkspace({
      path: workspacePath,
      permissions: {
        ...makeWorkspace().permissions,
        write: false,
        delete: true,
      },
    });
    return { base, workspace, external };
  };
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["root", "rule", "option", "alias"])(
    "rejects nested deny rules through an external %s mount",
    async (kind) => {
      const { workspace, external, base } = fixture();
      const deny = path.join(external, "missing", "secret.txt");
      workspace.permissions.accessFilesystemRules = [{ path: deny, access: "deny" }];
      const options = { allowedReadPaths: [] as string[] };
      if (kind === "root") workspace.permissions.accessWorkspaceRoots = [external];
      if (kind === "rule")
        workspace.permissions.accessFilesystemRules.push({ path: external, access: "read" });
      if (kind === "option") options.allowedReadPaths = [external];
      if (kind === "alias") {
        const alias = path.join(base, "alias");
        fs.symlinkSync(external, alias);
        workspace.permissions.accessWorkspaceRoots = [alias];
      }
      const sandbox = new DockerSandbox(workspace);
      Object.assign(sandbox, { initialized: true });
      const result = await sandbox.execute("cat", [deny], options);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot safely mask the denied path inside a host mount");
      expect(() => sandbox.spawnProcess("cat", [deny], options)).toThrow("cannot safely mask");
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a denied descendant of a legacy root in the actual final mount plan", () => {
    const { workspace, external } = fixture();
    workspace.permissions.allowedPaths = [external];
    const sandbox = new DockerSandbox(workspace);
    // A legacy root is inactive once profile rules create finite scope. The
    // final boundary still checks any mount, independent of its source.
    workspace.permissions.accessFilesystemRules = [
      { path: path.join(external, "secret"), access: "deny" },
    ];
    expect(() => (sandbox as Any).assertMountPolicy({ hostPath: external, mode: "ro" })).toThrow(
      "cannot safely mask",
    );
  });

  it.each(["existing", "intermediate", "missing", "chain"])(
    "refuses %s policy namespace entries inside a writable external mount",
    async (kind) => {
      const { workspace, external, base } = fixture();
      const hidden = path.join(base, "hidden");
      fs.mkdirSync(hidden);
      const link = path.join(external, "link");
      if (kind === "chain") {
        const outsideLink = path.join(base, "outside-link");
        fs.symlinkSync(link, outsideLink);
        fs.symlinkSync(hidden, link);
        workspace.permissions.accessFilesystemRules = [{ path: outsideLink, access: "deny" }];
      } else {
        if (kind !== "missing") fs.symlinkSync(hidden, link);
        const rulePath = kind === "existing" ? link : path.join(link, "secret");
        workspace.permissions.accessFilesystemRules = [{ path: rulePath, access: "deny" }];
      }
      workspace.permissions.write = true;
      workspace.permissions.accessFilesystemRules.push({ path: workspace.path, access: "read" });
      workspace.permissions.accessWorkspaceRoots = [external];
      const sandbox = new DockerSandbox(workspace);
      Object.assign(sandbox, { initialized: true });
      const result = await sandbox.execute("echo", ["ok"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/policy path resolution|cannot safely mask/);
      expect(() => sandbox.spawnProcess("echo", ["ok"])).toThrow(
        /policy path resolution|cannot safely mask/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a read child inside a writable external parent, including caller options", async () => {
    const { workspace, external } = fixture();
    workspace.permissions.write = true;
    workspace.permissions.accessFilesystemRules = [
      { path: workspace.path, access: "read" },
      { path: path.join(external, "inputs"), access: "read" },
    ];
    workspace.permissions.accessWorkspaceRoots = [external];
    const sandbox = new DockerSandbox(workspace);
    Object.assign(sandbox, { initialized: true });
    const result = await sandbox.execute("echo", ["ok"], { allowedWritePaths: [external] });
    expect(result.stderr).toContain("read-only path inside a writable host mount");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects writable workspace directories even when protected entries exist=%s",
    async (existing) => {
      const { workspace } = fixture();
      workspace.permissions.write = true;
      if (existing) fs.mkdirSync(path.join(workspace.path, ".git"));
      const sandbox = new DockerSandbox(workspace);
      Object.assign(sandbox, { initialized: true });
      const result = await sandbox.execute("mkdir", ["nested/.git"]);
      expect(result.stderr).toContain("cannot protect current and future .git");
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("rejects writable external directory mounts when delete is disabled", async () => {
    const { workspace, external } = fixture();
    workspace.permissions.write = true;
    workspace.permissions.delete = false;
    workspace.permissions.accessFilesystemRules = [{ path: workspace.path, access: "read" }];
    workspace.permissions.accessWorkspaceRoots = [external];
    const sandbox = new DockerSandbox(workspace);
    Object.assign(sandbox, { initialized: true });
    const result = await sandbox.execute("rm", [path.join(external, "input")]);
    expect(result.stderr).toContain("cannot enforce delete restrictions");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves a read-only workspace and writable regular file with a write union", () => {
    const { workspace, external } = fixture();
    workspace.permissions.write = true;
    workspace.permissions.delete = false;
    const output = path.join(external, "output.txt");
    fs.writeFileSync(output, "original");
    workspace.permissions.accessFilesystemRules = [
      { path: workspace.path, access: "read" },
      { path: output, access: "read" },
      { path: output, access: "write" },
    ];
    const sandbox = new DockerSandbox(workspace);
    const args = (sandbox as Any).buildDockerArgs({ allowedWritePaths: [output] }) as string[];
    expect(args).toContain(`${fs.realpathSync(workspace.path)}:/workspace:ro`);
    expect(
      args.some((arg) => arg.startsWith(`${fs.realpathSync(output)}:`) && arg.endsWith(":rw")),
    ).toBe(true);
  });

  it("keeps the start and the end of long command output", async () => {
    const { workspace } = fixture();
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    spawnMock.mockImplementation(() => proc);
    const sandbox = new DockerSandbox(workspace);
    Object.assign(sandbox, { initialized: true });

    const resultPromise = sandbox.execute("npm test", [], { maxOutputSize: 1_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    proc.stdout?.emit("data", Buffer.from(`RUN v1\n${"ok\n".repeat(2_000)}`));
    proc.stdout?.emit("data", Buffer.from("FAIL src/x.test.ts > adds\n"));
    proc.emit("close", 1, null);
    const result = await resultPromise;

    expect(result.stdout.startsWith("RUN v1")).toBe(true);
    expect(result.stdout).toContain("FAIL src/x.test.ts > adds");
    expect(result.stdout).toContain("[Output truncated]");
    expect(result.truncated).toBe(true);
  });

  it("runs commands with non-interactive defaults without overriding configured values", () => {
    const { workspace } = fixture();
    const sandbox = new DockerSandbox(workspace, { env: { PAGER: "more" } });
    const args = (sandbox as Any).buildDockerArgs({}) as string[];
    const envValues = args.filter((_arg, index) => args[index - 1] === "-e");

    expect(envValues).toEqual(
      expect.arrayContaining([
        "GIT_TERMINAL_PROMPT=0",
        "GIT_EDITOR=true",
        "GIT_PAGER=cat",
        "PIP_NO_INPUT=1",
        "DEBIAN_FRONTEND=noninteractive",
        "PAGER=more",
      ]),
    );
    expect(envValues).not.toContain("PAGER=cat");
    expect(envValues.some((value) => value.startsWith("CI="))).toBe(false);
  });

  it("does not let explicit temporary write options expose a protected workspace file", () => {
    const { workspace } = fixture();
    workspace.permissions.write = true;
    const protectedFile = path.join(workspace.path, ".git");
    fs.writeFileSync(protectedFile, "gitdir: protected");
    workspace.permissions.accessFilesystemRules = [{ path: workspace.path, access: "read" }];
    const sandbox = new DockerSandbox(workspace);
    expect(() => (sandbox as Any).buildDockerArgs({ allowedWritePaths: [protectedFile] })).toThrow(
      "denied write access",
    );
  });

  it("fails closed when a custom deny rule is nested inside the workspace mount", async () => {
    const workspace = makeWorkspace({
      permissions: {
        ...makeWorkspace().permissions,
        accessFilesystemRules: [{ path: "/tmp/cowork workspace/secrets", access: "deny" }],
      },
    });
    const sandbox = new DockerSandbox(workspace);
    Object.assign(sandbox, { initialized: true });

    const result = await sandbox.execute("echo", ["ok"]);

    expect(result).toMatchObject({
      exitCode: 1,
      error: "Path access denied",
    });
    expect(result.stderr).toContain("/tmp/cowork workspace/secrets");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses an ephemeral container workspace when host read access is disabled", () => {
    const sandbox = new DockerSandbox(
      makeWorkspace({
        permissions: {
          ...makeWorkspace().permissions,
          read: false,
          write: true,
        },
      }),
    );

    const args = (sandbox as Any).buildDockerArgs({
      cwd: "/workspace",
      allowNetwork: false,
      allowedReadPaths: [],
      allowedWritePaths: [],
    }) as string[];

    expect(args).toContainEqual(expect.stringMatching(/^\/workspace:rw,/));
    expect(args).not.toContain("-v");
  });

  it("maps an explicitly readable host file to its private container mount", () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-docker-workspace-"));
    const inputPath = path.join(os.tmpdir(), `cowork-docker-input-${Date.now()}.txt`);
    fs.writeFileSync(inputPath, "input", "utf8");

    try {
      const sandbox = new DockerSandbox(
        makeWorkspace({
          path: workspacePath,
          permissions: {
            ...makeWorkspace().permissions,
            write: false,
            allowedPaths: [inputPath],
          },
        }),
      );
      const options = {
        cwd: "/workspace",
        allowedReadPaths: [inputPath],
        allowedWritePaths: [],
      };

      const mapped = (sandbox as Any).mapHostArgumentToContainer(inputPath, options);
      const args = (sandbox as Any).buildDockerArgs(options) as string[];
      const canonicalInputPath = fs.realpathSync(inputPath);

      expect(mapped).toMatch(/^\/tmp\/cowork-mount-[a-f0-9]{16}$/);
      expect(mapped).not.toBe(inputPath);
      expect(args).toContainEqual(expect.stringContaining(`${canonicalInputPath}:${mapped}:ro`));
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.rmSync(inputPath, { force: true });
    }
  });

  it("does not start a networked process when the profile has domain rules", async () => {
    const workspace = makeWorkspace({
      permissions: {
        ...makeWorkspace().permissions,
        network: true,
        accessDomainRules: [{ pattern: "example.com", access: "allow" }],
      },
    });
    const sandbox = new DockerSandbox(workspace);
    Object.assign(sandbox, { initialized: true });

    const result = await sandbox.execute("echo", ["ok"], { allowNetwork: true });

    expect(result).toMatchObject({
      exitCode: 1,
      error: "Network access denied",
    });
    expect(result.stderr).toContain("domain-scoped network rules");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects container cwd traversal before spawning Docker", async () => {
    const sandbox = new DockerSandbox(makeWorkspace());
    Object.assign(sandbox, { initialized: true });

    const result = await sandbox.execute("echo", ["ok"], {
      cwd: "/workspace/../outside",
    });

    expect(result).toMatchObject({ exitCode: 1, error: "Path access denied" });
    expect(result.stderr).toContain("escapes /workspace");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("DockerSandbox default container", () => {
  const fakeProc = () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as ChildProcess["stdout"];
    proc.stderr = new EventEmitter() as ChildProcess["stderr"];
    proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
    return proc;
  };
  const argAfter = (args: string[], flag: string): string[] =>
    args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  // A read-only workspace mount keeps these tests about container defaults, not mount policy.
  const readOnlyWorkspace = () =>
    makeWorkspace({ permissions: { ...makeWorkspace().permissions, write: false } });

  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs in a Debian-based Node image that ships git, python and build tools", async () => {
    const proc = fakeProc();
    spawnMock.mockImplementation(() => proc);
    const sandbox = new DockerSandbox(readOnlyWorkspace());
    Object.assign(sandbox, { initialized: true });

    const resultPromise = sandbox.execute("git status");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    proc.emit("close", 0, null);
    await resultPromise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const image = args[args.indexOf("/bin/sh") - 1];
    expect(image).toBe("node:24-bookworm");
    expect(image).not.toMatch(/alpine|slim/);
  });

  it("keeps the image and resource limits overridable through dockerConfig", () => {
    const workspace = readOnlyWorkspace();
    (workspace.permissions as { dockerConfig?: unknown }).dockerConfig = {
      image: "mcr.microsoft.com/devcontainers/python:3",
      cpuLimit: 0.5,
      memoryLimit: "1g",
    };
    const sandbox = new DockerSandbox(workspace);
    const args = (sandbox as Any).buildDockerArgs({}) as string[];

    expect((sandbox as Any).config.image).toBe("mcr.microsoft.com/devcontainers/python:3");
    expect(argAfter(args, "--cpus")).toEqual(["0.5"]);
    expect(argAfter(args, "--memory")).toEqual(["1g"]);
  });

  it("gives builds enough CPU and memory by default", () => {
    const sandbox = new DockerSandbox(readOnlyWorkspace());
    const args = (sandbox as Any).buildDockerArgs({}) as string[];

    expect(argAfter(args, "--memory")).toEqual(["4g"]);
    const hostCpus = Math.max(1, os.availableParallelism());
    expect(argAfter(args, "--cpus")).toEqual([String(Math.min(2, hostCpus))]);
  });

  it("lets build tools execute from /tmp and write to a private HOME", () => {
    const sandbox = new DockerSandbox(readOnlyWorkspace());
    const args = (sandbox as Any).buildDockerArgs({}) as string[];
    const tmpfs = argAfter(args, "--tmpfs");
    const envValues = argAfter(args, "-e");

    const tmp = tmpfs.find((mount) => mount.startsWith("/tmp:"));
    expect(tmp).toBeDefined();
    expect(tmp).not.toContain("noexec");
    expect(tmp).toContain("nosuid");
    expect(tmp).toMatch(/size=1g\b/);

    const home = tmpfs.find((mount) => mount.startsWith("/home/cowork:"));
    expect(home).toBeDefined();
    expect(home).toContain("rw");
    expect(home).toContain("mode=1777");
    expect(envValues).toContain("HOME=/home/cowork");

    // The hardening around those mounts is unchanged.
    expect(args).toContain("--read-only");
    expect(argAfter(args, "--cap-drop")).toEqual(["ALL"]);
    expect(argAfter(args, "--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(argAfter(args, "--network")).toEqual(["none"]);
  });

  it("does not override a HOME the workspace configures", () => {
    const sandbox = new DockerSandbox(readOnlyWorkspace(), { env: { HOME: "/workspace/.home" } });
    const envValues = argAfter((sandbox as Any).buildDockerArgs({}) as string[], "-e");

    expect(envValues).toContain("HOME=/workspace/.home");
    expect(envValues).not.toContain("HOME=/home/cowork");
  });

  it("lets a large default image finish pulling instead of killing it after two minutes", async () => {
    vi.useFakeTimers();
    const inspect = fakeProc();
    const pull = fakeProc();
    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "image" ? inspect : pull,
    );
    const sandbox = new DockerSandbox(readOnlyWorkspace());

    const pulled = (sandbox as Any).pullImageIfNeeded() as Promise<void>;
    inspect.emit("close", 1, null);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(spawnMock.mock.calls[1][1]).toEqual(["pull", "node:24-bookworm"]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(pull.kill).not.toHaveBeenCalled();
    pull.emit("close", 0, null);
    await expect(pulled).resolves.toBeUndefined();
  });
});
