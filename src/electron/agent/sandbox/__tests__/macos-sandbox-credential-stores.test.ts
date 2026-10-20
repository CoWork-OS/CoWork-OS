import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import type { Workspace } from "../../../../shared/types";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { MacOSSandbox } from "../macos-sandbox";

let home: string;
const originalHome = process.env.HOME;

function makeWorkspace(
  workspacePath: string,
  permissions: Partial<Workspace["permissions"]> = {},
): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: workspacePath,
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: true,
      network: false,
      unrestrictedFileAccess: false,
      allowedPaths: [],
      ...permissions,
    },
    createdAt: Date.now(),
  };
}

async function profileFor(workspace: Workspace): Promise<string> {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  spawnMock.mockImplementationOnce(() => proc);
  const sandbox = new MacOSSandbox(workspace);
  const resultPromise = sandbox.execute("cat ~/.ssh/id_ed25519", [], {
    cwd: workspace.path,
    timeout: 1000,
  });
  const [, args] = spawnMock.mock.calls.at(-1)!;
  const profile = fs.readFileSync(args[1], "utf8");
  proc.emit("close", 0, null);
  await resultPromise;
  return profile;
}

const fullDeny = (target: string) => `(deny file-read* file-write* (subpath "${target}"))`;
const writeDeny = (target: string) => `(deny file-write* (subpath "${target}"))`;

beforeEach(() => {
  spawnMock.mockReset();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-home-")));
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.mkdirSync(path.join(home, ".aws"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("macOS sandbox credential stores", () => {
  it("denies ~/.ssh after the grant when the workspace is the home folder", async () => {
    const profile = await profileFor(makeWorkspace(home));
    const workspaceGrant = profile.indexOf("; Allow writing to workspace");

    expect(workspaceGrant).toBeGreaterThan(-1);
    expect(profile.lastIndexOf(fullDeny(path.join(home, ".ssh")))).toBeGreaterThan(workspaceGrant);
    expect(profile.lastIndexOf(fullDeny(path.join(home, ".aws")))).toBeGreaterThan(workspaceGrant);
  });

  it("keeps a store open when the workspace is inside it", async () => {
    const profile = await profileFor(makeWorkspace(path.join(home, ".ssh")));
    const closing = profile.slice(profile.indexOf("; Credential stores stay denied under"));

    expect(closing).not.toContain(fullDeny(path.join(home, ".ssh")));
    expect(closing).toContain(fullDeny(path.join(home, ".aws")));
  });

  it("lets a read rule on a store keep reads only", async () => {
    const profile = await profileFor(
      makeWorkspace(home, {
        accessFilesystemRules: [{ path: path.join(home, ".aws"), access: "read" }],
      }),
    );
    const closing = profile.slice(profile.indexOf("; Credential stores stay denied under"));

    expect(closing).toContain(writeDeny(path.join(home, ".aws")));
    expect(closing).not.toContain(fullDeny(path.join(home, ".aws")));
    expect(closing).toContain(fullDeny(path.join(home, ".ssh")));
  });
});
