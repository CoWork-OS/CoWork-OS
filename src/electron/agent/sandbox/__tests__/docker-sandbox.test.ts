import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    spawnMock.mockReset();
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
      error: "Unsupported access-profile deny rule",
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
