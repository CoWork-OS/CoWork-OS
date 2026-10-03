/**
 * Tests for EditTools - surgical file editing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// The Node daemon has no Electron app object. Exercise the shared runtime
// user-data resolver through an isolated environment override instead.
vi.mock("electron", () => ({}));

// Import after mocking
import { EditTools } from "../edit-tools";
import { Workspace } from "../../../../shared/types";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";

class PausedTransactionEditTools extends EditTools {
  protected override writeTargetBuffer(targetFd: number, content: Buffer): void {
    const marker = process.env.COWORK_EDIT_LIVE_MARKER;
    const release = process.env.COWORK_EDIT_LIVE_RELEASE;
    if (!marker || !release) throw new Error("Missing live transaction fixture paths");
    fs.writeFileSync(marker, "transaction owns recovery record");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw new Error("Live transaction fixture timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    super.writeTargetBuffer(targetFd, content);
  }
}

class PartialWriteEditTools extends EditTools {
  didInjectPartial = false;

  protected override writeTargetBuffer(targetFd: number, content: Buffer): void {
    if (!this.didInjectPartial) {
      this.didInjectPartial = true;
      fs.ftruncateSync(targetFd, 0);
      fs.writeSync(targetFd, content, 0, Math.min(3, content.length), 0);
      throw new Error("injected partial write");
    }
    super.writeTargetBuffer(targetFd, content);
  }
}

class ExternalWriteBeforeFailureEditTools extends EditTools {
  constructor(
    workspace: Workspace,
    private readonly externalWrite: () => void,
  ) {
    super(workspace, { logEvent: vi.fn() } as Any, "test-external-failure");
  }

  protected override writeTargetBuffer(targetFd: number, content: Buffer): void {
    super.writeTargetBuffer(targetFd, content);
    this.externalWrite();
    throw new Error("injected failure after another writer changed the file");
  }
}

class KillDuringWriteEditTools extends EditTools {
  protected override writeTargetBuffer(targetFd: number, content: Buffer): void {
    const marker = process.env.COWORK_EDIT_KILL_MARKER;
    if (!marker) throw new Error("Missing kill marker path");
    fs.ftruncateSync(targetFd, 0);
    fs.writeSync(targetFd, content, 0, Math.min(3, content.length), 0);
    fs.writeFileSync(marker, "kill-point reached");
    process.kill(process.pid, "SIGKILL");
  }
}

class RebindSymlinkDuringCommitEditTools extends EditTools {
  didRebind = false;

  constructor(
    workspace: Workspace,
    daemon: Any,
    taskId: string,
    private readonly rebind: () => void,
  ) {
    super(workspace, daemon, taskId);
  }

  protected override writeTargetBuffer(targetFd: number, content: Buffer): void {
    if (!this.didRebind) {
      this.didRebind = true;
      this.rebind();
    }
    super.writeTargetBuffer(targetFd, content);
  }
}

class SwapParentAfterRecoveryValidationEditTools extends EditTools {
  validationCount = 0;

  constructor(
    workspace: Workspace,
    daemon: Any,
    taskId: string,
    private readonly swapParent: () => void,
  ) {
    super(workspace, daemon, taskId);
  }

  protected override async revalidateEditTarget(options: {
    requestedFullPath: string;
    realPath: string;
    initialStats: fs.Stats;
    initialParentStats: fs.Stats;
    targetFd: number;
    externalApprovalGranted: boolean;
  }): Promise<void> {
    await super.revalidateEditTarget(options);
    this.validationCount += 1;
    if (this.validationCount === 1) this.swapParent();
  }
}

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

// Mock workspace
const mockWorkspace: Workspace = {
  id: "test-workspace",
  name: "Test Workspace",
  path: "/test/workspace",
  permissions: {
    fileRead: true,
    fileWrite: true,
    shell: false,
  },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
};

let editTools: EditTools;
let editRecoveryRoot: string;

let ownsEditRecoveryRoot = false;

beforeEach(() => {
  vi.clearAllMocks();
  const configuredRoot = process.env.COWORK_EDIT_TEST_USER_DATA_DIR;
  ownsEditRecoveryRoot = !configuredRoot;
  editRecoveryRoot =
    configuredRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-recovery-root-"));
  vi.stubEnv("COWORK_USER_DATA_DIR", editRecoveryRoot);
  vi.stubEnv("COWORK_PROFILE", "default");
  vi.stubEnv("COWORK_PROFILE_ID", "default");
  editTools = new EditTools(mockWorkspace, mockDaemon as Any, "test-task-id");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ownsEditRecoveryRoot) fs.rmSync(editRecoveryRoot, { recursive: true, force: true });
});

function recoveryRecordId(target: string): string {
  const realPath = fs.realpathSync(target);
  const identity = fs.statSync(realPath);
  const key =
    identity.dev !== 0 && identity.ino !== 0
      ? `inode:${identity.dev}:${identity.ino}`
      : `path:${realPath}`;
  return createHash("sha256").update(key).digest("hex");
}

function writePreparedRecoveryReceipt(options: {
  target: string;
  before: Buffer;
  after: Buffer;
  ownerPid?: number;
  ownerBootTimeMs?: number;
  transactionId?: string;
  state?: "prepared" | "committed";
}): string {
  const realPath = fs.realpathSync(options.target);
  const identity = fs.statSync(realPath);
  const payload = {
    version: 1,
    path: realPath,
    fileDev: identity.dev,
    fileIno: identity.ino,
    ownerPid: options.ownerPid ?? process.pid,
    ...(options.transactionId !== undefined
      ? { ownerBootTimeMs: options.ownerBootTimeMs, transactionId: options.transactionId }
      : {}),
    state: options.state ?? "prepared",
    beforeBase64: options.before.toString("base64"),
    afterBase64: options.after.toString("base64"),
    beforeSha256: createHash("sha256").update(options.before).digest("hex"),
    afterSha256: createHash("sha256").update(options.after).digest("hex"),
  };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const recoveryDirectory = path.join(editRecoveryRoot, "edit-recovery");
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const recoveryId = recoveryRecordId(realPath);
  const recordPath = path.join(recoveryDirectory, `${recoveryId}.json`);
  fs.writeFileSync(recordPath, JSON.stringify({ ...payload, checksum }), {
    mode: 0o600,
    flag: "wx",
  });
  return recordPath;
}

function runEditCrashWorker(options: {
  target: string;
  workspacePath: string;
  recoveryRoot: string;
  marker: string;
}): ReturnType<typeof spawnSync> {
  const testFile = "src/electron/agent/tools/__tests__/edit-tools.test.ts";
  const vitestCli = path.resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
  return spawnSync(
    process.execPath,
    [
      vitestCli,
      "run",
      testFile,
      "--testNamePattern=edit kill-point worker for recovery regression",
      "--maxWorkers=1",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        COWORK_EDIT_TEST_USER_DATA_DIR: options.recoveryRoot,
        COWORK_EDIT_KILL_CHILD: "1",
        COWORK_EDIT_KILL_TARGET: options.target,
        COWORK_EDIT_KILL_WORKSPACE: options.workspacePath,
        COWORK_EDIT_KILL_MARKER: options.marker,
      },
    },
  );
}

describe("EditTools", () => {
  describe("getToolDefinitions", () => {
    it("should return edit_file tool definition", () => {
      const tools = EditTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("edit_file");
      expect(tools[0].description).toContain("surgical");
      expect(tools[0].input_schema.required).toContain("file_path");
      expect(tools[0].input_schema.required).toContain("old_string");
      expect(tools[0].input_schema.required).toContain("new_string");
    });

    it("should have correct input schema properties", () => {
      const tools = EditTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty("file_path");
      expect(schema.properties).toHaveProperty("old_string");
      expect(schema.properties).toHaveProperty("new_string");
      expect(schema.properties).toHaveProperty("replace_all");
    });
  });

  describe("input validation", () => {
    it("should reject empty old_string", async () => {
      const result = await editTools.editFile({
        file_path: "test.ts",
        old_string: "",
        new_string: "new",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("should reject identical strings", async () => {
      const result = await editTools.editFile({
        file_path: "test.ts",
        old_string: "same",
        new_string: "same",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("identical");
    });
  });

  describe("path validation", () => {
    it("should reject paths outside workspace", async () => {
      const result = await editTools.editFile({
        file_path: "../../../etc/passwd",
        old_string: "old",
        new_string: "new",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("within workspace");
    });

    it("should return error for non-existent files", async () => {
      const result = await editTools.editFile({
        file_path: "nonexistent-file-that-does-not-exist.ts",
        old_string: "old",
        new_string: "new",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should reject a file denied by the active access profile", async () => {
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-profile-"));
      const deniedPath = path.join(workspacePath, "secret.txt");
      fs.writeFileSync(deniedPath, "old\n");

      try {
        const tools = new EditTools(
          {
            ...mockWorkspace,
            path: workspacePath,
            permissions: {
              read: true,
              write: true,
              delete: true,
              network: false,
              shell: false,
              accessFilesystemRules: [{ path: deniedPath, access: "deny" }],
            },
          } as Workspace,
          mockDaemon as Any,
          "test-task-id",
        );
        const result = await tools.editFile({
          file_path: "secret.txt",
          old_string: "old",
          new_string: "new",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("denied by the active access profile");
        expect(fs.readFileSync(deniedPath, "utf8")).toBe("old\n");
      } finally {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    });
  });

  describe("logging", () => {
    it("should log edit event", async () => {
      await editTools.editFile({
        file_path: "test.ts",
        old_string: "old content",
        new_string: "new content",
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("Editing file"),
      });
    });

    it("should log tool result on error", async () => {
      await editTools.editFile({
        file_path: "test.ts",
        old_string: "",
        new_string: "new content",
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-id",
        "tool_result",
        expect.objectContaining({
          tool: "edit_file",
          error: expect.stringContaining("cannot be empty"),
        }),
      );
    });
  });
});

describe("edit descriptor authority", () => {
  it("rejects a substituted regular file before truncation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-descriptor-"));
    try {
      const target = path.join(directory, "target.txt");
      fs.writeFileSync(target, "original");
      const originalIdentity = fs.statSync(target);
      fs.renameSync(target, path.join(directory, "original.txt"));
      fs.writeFileSync(target, "replacement must survive");
      const editor = new EditTools(
        { ...mockWorkspace, path: directory },
        mockDaemon as Any,
        "task",
      );
      const targetFd = fs.openSync(target, fs.constants.O_RDWR);
      try {
        expect(() =>
          (editor as Any).writeFileThroughDescriptor({
            realPath: target,
            requestedFullPath: target,
            targetFd,
            contentBefore: Buffer.from("original"),
            contentAfter: Buffer.from("edited"),
            expectedIdentity: originalIdentity,
            expectedParentIdentity: fs.statSync(directory),
            externalApprovalGranted: false,
          }),
        ).toThrow(/changed/);
      } finally {
        fs.closeSync(targetFd);
      }
      expect(fs.readFileSync(target, "utf8")).toBe("replacement must survive");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("edit approval target identity", () => {
  it("rejects a symlink rebound to a different external file during consent", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-consent-"));
    try {
      const workspacePath = path.join(directory, "workspace");
      fs.mkdirSync(workspacePath);
      const first = path.join(directory, "first.txt");
      const second = path.join(directory, "second.txt");
      const link = path.join(workspacePath, "link.txt");
      fs.writeFileSync(first, "old");
      fs.writeFileSync(second, "old");
      fs.symlinkSync(first, link);
      const daemon = {
        logEvent: vi.fn(),
        requestApproval: vi.fn(async () => {
          fs.unlinkSync(link);
          fs.symlinkSync(second, link);
          return true;
        }),
      };
      const editor = new EditTools(
        {
          ...mockWorkspace,
          path: workspacePath,
          permissions: { read: true, write: true, delete: true, shell: false, network: false },
        },
        daemon as Any,
        "task",
      );
      const result = await editor.editFile({
        file_path: "link.txt",
        old_string: "old",
        new_string: "new",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/changed while awaiting approval/);
      expect(fs.readFileSync(first, "utf8")).toBe("old");
      expect(fs.readFileSync(second, "utf8")).toBe("old");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("edit target authority during commit", () => {
  it("rejects a regular inode replacement while the edit is awaiting its baseline hook", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-inode-rebind-"));
    const target = path.join(directory, "shared.txt");
    const displaced = path.join(directory, "displaced.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.renameSync(target, displaced);
        fs.writeFileSync(target, "replacement must survive\n");
      }),
    };
    const editor = new EditTools({ ...mockWorkspace, path: directory }, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/file target changed/i);
      expect(fs.readFileSync(target, "utf8")).toBe("replacement must survive\n");
      expect(fs.readFileSync(displaced, "utf8")).toBe("alpha=1\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves recovery evidence without touching the replacement when a symlink swaps at commit", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-late-symlink-rebind-"));
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const link = path.join(directory, "link.txt");
    fs.writeFileSync(first, "alpha=1\n");
    fs.writeFileSync(second, "replacement must survive\n");
    fs.symlinkSync(first, link);
    const editor = new RebindSymlinkDuringCommitEditTools(
      { ...mockWorkspace, path: directory },
      mockDaemon as Any,
      "task",
      () => {
        fs.unlinkSync(link);
        fs.symlinkSync(second, link);
      },
    );

    try {
      const result = await editor.editFile({
        file_path: "link.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(editor.didRebind).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/file path changed during edit/i);
      expect(fs.readFileSync(first, "utf8")).toBe("alpha=2\n");
      expect(fs.readFileSync(second, "utf8")).toBe("replacement must survive\n");
      const records = fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"));
      expect(records).toHaveLength(1);
      const receipt = JSON.parse(
        fs.readFileSync(path.join(editRecoveryRoot, "edit-recovery", records[0]), "utf8"),
      );
      expect(Buffer.from(receipt.beforeBase64, "base64").toString()).toBe("alpha=1\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlink swap before writing through the original descriptor", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-symlink-rebind-"));
    const target = path.join(directory, "target.txt");
    const alternate = path.join(directory, "alternate.txt");
    const link = path.join(directory, "link.txt");
    fs.writeFileSync(target, "alpha=1\n");
    fs.writeFileSync(alternate, "replacement must survive\n");
    fs.symlinkSync(target, link);
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.unlinkSync(link);
        fs.symlinkSync(alternate, link);
      }),
    };
    const editor = new EditTools({ ...mockWorkspace, path: directory }, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "link.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/file path changed during edit/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
      expect(fs.readFileSync(alternate, "utf8")).toBe("replacement must survive\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a parent-directory rebind even when the replacement entry is a hard link to the same inode", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-parent-rebind-"));
    const parent = path.join(directory, "nested");
    const displacedParent = path.join(directory, "displaced-nested");
    const target = path.join(parent, "shared.txt");
    const displacedTarget = path.join(displacedParent, "shared.txt");
    fs.mkdirSync(parent);
    fs.writeFileSync(target, "alpha=1\n");
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.renameSync(parent, displacedParent);
        fs.mkdirSync(parent);
        fs.linkSync(displacedTarget, path.join(parent, "shared.txt"));
      }),
    };
    const editor = new EditTools({ ...mockWorkspace, path: directory }, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "nested/shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/parent directory changed/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
      expect(fs.readFileSync(displacedTarget, "utf8")).toBe("alpha=1\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors access-profile revocation while the edit is awaiting its baseline hook", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-revoked-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const workspace = {
      ...mockWorkspace,
      path: directory,
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        accessFilesystemRules: [] as Array<{ path: string; access: "allow" | "deny" }>,
      },
    } as Workspace;
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        workspace.permissions.accessFilesystemRules?.push({ path: target, access: "deny" });
      }),
    };
    const editor = new EditTools(workspace, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/denied by the active access profile/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates hard links in place and preserves inode and mode", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-hardlink-"));
    const target = path.join(directory, "shared.txt");
    const alias = path.join(directory, "alias.txt");
    fs.writeFileSync(target, "alpha=1\n", { mode: 0o640 });
    fs.linkSync(target, alias);
    const initial = fs.statSync(target);
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=2\n");
      expect(fs.readFileSync(alias, "utf8")).toBe("alpha=2\n");
      expect(fs.statSync(target).ino).toBe(initial.ino);
      expect(fs.statSync(alias).ino).toBe(initial.ino);
      expect(fs.statSync(target).mode & 0o777).toBe(initial.mode & 0o777);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("edit content-version integrity", () => {
  it("preserves independent edits from two same-inode writers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-interleave-"));
    try {
      const target = path.join(directory, "shared.txt");
      fs.writeFileSync(target, "alpha=1\nbeta=1\n");

      let markAReached!: () => void;
      let markBReached!: () => void;
      let allowA!: () => void;
      let allowB!: () => void;
      const reachedA = new Promise<void>((resolve) => (markAReached = resolve));
      const reachedB = new Promise<void>((resolve) => (markBReached = resolve));
      const gateA = new Promise<void>((resolve) => (allowA = resolve));
      const gateB = new Promise<void>((resolve) => (allowB = resolve));
      const makeDaemon = (markReached: () => void, gate: Promise<void>) => ({
        logEvent: vi.fn(),
        captureTaskMutationBaseline: vi.fn(async () => {
          markReached();
          await gate;
        }),
      });
      const workspace = { ...mockWorkspace, path: directory };
      const editorA = new EditTools(workspace, makeDaemon(markAReached, gateA) as Any, "task-a");
      const editorB = new EditTools(workspace, makeDaemon(markBReached, gateB) as Any, "task-b");

      const pendingA = editorA.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      const pendingB = editorB.editFile({
        file_path: "shared.txt",
        old_string: "beta=1",
        new_string: "beta=2",
      });
      await Promise.all([reachedA, reachedB]);
      allowA();
      const resultA = await pendingA;
      allowB();
      const resultB = await pendingB;

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=2\nbeta=2\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("edit review regressions", () => {
  it.each(["al", ""])(
    "preserves an external writer's ambiguous bytes %j during failure handling",
    async (externalContent) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-external-failure-"));
      const target = path.join(directory, "shared.txt");
      fs.writeFileSync(target, "alpha=1\n");
      const editor = new ExternalWriteBeforeFailureEditTools(
        { ...mockWorkspace, path: directory },
        () => fs.writeFileSync(target, externalContent),
      );
      try {
        const result = await editor.editFile({
          file_path: "shared.txt",
          old_string: "alpha=1",
          new_string: "alpha=2",
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/recovery is required/i);
        expect(fs.readFileSync(target, "utf8")).toBe(externalContent);
        expect(fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"))).toHaveLength(1);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects the independent recovery cap before allocating or mutating a disabled-guardrail file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-recovery-cap-"));
    const target = path.join(directory, "large.txt");
    fs.writeFileSync(target, "preserve me");
    fs.truncateSync(target, 128 * 1024 * 1024 + 1);
    vi.spyOn(GuardrailManager, "isFileSizeExceeded").mockImplementation((size) => ({
      exceeded: false,
      sizeMB: size / (1024 * 1024),
      limitMB: 1,
    }));
    try {
      const editor = new EditTools(
        { ...mockWorkspace, path: directory },
        mockDaemon as Any,
        "task",
      );
      const result = await editor.editFile({
        file_path: "large.txt",
        old_string: "preserve",
        new_string: "change",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery storage.*128 MiB/i);
      expect(fs.statSync(target).size).toBe(128 * 1024 * 1024 + 1);
      const fd = fs.openSync(target, "r");
      try {
        const prefix = Buffer.alloc(11);
        fs.readSync(fd, prefix, 0, prefix.length, 0);
        expect(prefix.toString()).toBe("preserve me");
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles exact completed bytes through a hardlink without restoring older content", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-reconcile-alias-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=2\n");
    fs.linkSync(target, path.join(directory, "alias.txt"));
    writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
    });
    try {
      const editor = new EditTools(
        { ...mockWorkspace, path: directory },
        mockDaemon as Any,
        "task",
      );
      const result = await editor.editFile({
        file_path: "alias.txt",
        old_string: "alpha=2",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=3\n");
      expect(fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"))).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["al", ""])(
    "preserves ambiguous recovery bytes %j instead of restoring a snapshot",
    async (current) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-ambiguous-"));
      const target = path.join(directory, "shared.txt");
      fs.writeFileSync(target, current);
      const recordPath = writePreparedRecoveryReceipt({
        target,
        before: Buffer.from("alpha=1\n"),
        after: Buffer.from("alpha=2\n"),
      });
      try {
        const editor = new EditTools(
          { ...mockWorkspace, path: directory },
          mockDaemon as Any,
          "task",
        );
        const result = await editor.editFile({
          file_path: "shared.txt",
          old_string: "alpha=1",
          new_string: "alpha=3",
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/recovery is required/i);
        expect(fs.readFileSync(target, "utf8")).toBe(current);
        expect(fs.existsSync(recordPath)).toBe(true);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([true, false])(
    "applies the file size guardrail to each version when enabled=%s",
    async (enabled) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-size-"));
      const target = path.join(directory, "shared.txt");
      const original = "alpha=1\n" + "x".repeat(22);
      fs.writeFileSync(target, original);
      // Scale the actual per-file rule to bytes; both versions fit under 50 bytes,
      // while their journal payload exceeds 50. Disabled mode ignores its 8-byte setting.
      const limit = enabled ? 50 : 8;
      vi.spyOn(GuardrailManager, "isFileSizeExceeded").mockImplementation((size) => ({
        exceeded: enabled && size > limit,
        sizeMB: size / (1024 * 1024),
        limitMB: limit / (1024 * 1024),
      }));
      try {
        const editor = new EditTools(
          { ...mockWorkspace, path: directory },
          mockDaemon as Any,
          "task",
        );
        const result = await editor.editFile({
          file_path: "shared.txt",
          old_string: "alpha=1",
          new_string: "alpha=2",
        });
        expect(result.success).toBe(true);
        expect(fs.readFileSync(target, "utf8")).toBe(original.replace("alpha=1", "alpha=2"));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("edit live-transaction worker for hardlink regression", async () => {
    if (process.env.COWORK_EDIT_LIVE_CHILD !== "1") return;
    const workspacePath = process.env.COWORK_EDIT_LIVE_WORKSPACE;
    if (!workspacePath) throw new Error("Missing live transaction workspace");
    const editor = new PausedTransactionEditTools(
      { ...mockWorkspace, path: workspacePath },
      mockDaemon as Any,
      "child",
    );
    const result = await editor.editFile({
      file_path: "shared.txt",
      old_string: "alpha=1",
      new_string: "alpha=2",
    });
    expect(result.success).toBe(true);
  });

  it("blocks another process editing a hardlink alias of an active transaction", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-process-alias-"));
    const target = path.join(directory, "shared.txt");
    const alias = path.join(directory, "alias.txt");
    const marker = path.join(directory, "owned.txt");
    const release = path.join(directory, "release.txt");
    fs.writeFileSync(target, "alpha=1\nbeta=1\n");
    fs.linkSync(target, alias);
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "src/electron/agent/tools/__tests__/edit-tools.test.ts",
        "--testNamePattern=edit live-transaction worker for hardlink regression",
        "--maxWorkers=1",
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COWORK_EDIT_TEST_USER_DATA_DIR: editRecoveryRoot,
          COWORK_EDIT_LIVE_CHILD: "1",
          COWORK_EDIT_LIVE_WORKSPACE: directory,
          COWORK_EDIT_LIVE_MARKER: marker,
          COWORK_EDIT_LIVE_RELEASE: release,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(marker)) {
        if (Date.now() >= deadline || child.exitCode !== null)
          throw new Error("Transaction child did not pause: " + output);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const editor = new EditTools(
        { ...mockWorkspace, path: directory },
        mockDaemon as Any,
        "parent",
      );
      const result = await editor.editFile({
        file_path: "alias.txt",
        old_string: "beta=1",
        new_string: "beta=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/another live CoWork process|edit conflict/i);
    } finally {
      fs.writeFileSync(release, "release");
      const code = await exited;
      try {
        expect(code, output).toBe(0);
        expect(fs.readFileSync(target, "utf8")).toBe("alpha=2\nbeta=1\n");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

describe("edit recovery and conflict handling", () => {
  it("returns an actionable conflict when an external edit removes the requested text", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-conflict-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\nbeta=1\n");
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.writeFileSync(target, "alpha=9\nbeta=1\n");
      }),
    };
    const editor = new EditTools({ ...mockWorkspace, path: directory }, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/changed while this edit was waiting/i);
      expect(result.error).toMatch(/re-read the file and retry/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=9\nbeta=1\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not broaden replace_all when the same-inode match count changes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-replace-all-conflict-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "item=old\n");
    const daemon = {
      logEvent: vi.fn(),
      captureTaskMutationBaseline: vi.fn(async () => {
        fs.writeFileSync(target, "item=old\nitem=old\n");
      }),
    };
    const editor = new EditTools({ ...mockWorkspace, path: directory }, daemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "item=old",
        new_string: "item=new",
        replace_all: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/replace_all would affect 2 matches instead of the original 1/i);
      expect(fs.readFileSync(target, "utf8")).toBe("item=old\nitem=old\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a private integrity record when it finds a malformed recovery receipt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-bad-receipt-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const recoveryDirectory = path.join(editRecoveryRoot, "edit-recovery");
    fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const recoveryId = recoveryRecordId(target);
    const recordPath = path.join(recoveryDirectory, `${recoveryId}.json`);
    fs.writeFileSync(recordPath, "{not-json", { mode: 0o600, flag: "wx" });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery is required/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
      expect(fs.readFileSync(recordPath, "utf8")).toBe("{not-json");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not write during recovery when the parent binding changes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-recovery-parent-rebind-"));
    const parent = path.join(directory, "nested");
    const displacedParent = path.join(directory, "displaced-nested");
    const target = path.join(parent, "shared.txt");
    const displacedTarget = path.join(displacedParent, "shared.txt");
    fs.mkdirSync(parent);
    fs.writeFileSync(target, "alp");
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
    });
    const editor = new SwapParentAfterRecoveryValidationEditTools(
      { ...mockWorkspace, path: directory },
      mockDaemon as Any,
      "task",
      () => {
        fs.renameSync(parent, displacedParent);
        fs.mkdirSync(parent);
        fs.linkSync(displacedTarget, target);
      },
    );

    try {
      const result = await editor.editFile({
        file_path: "nested/shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(editor.validationCount).toBe(1);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery is required/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alp");
      expect(fs.readFileSync(displacedTarget, "utf8")).toBe("alp");
      expect(fs.existsSync(recordPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not recover a partial target while its receipt owner process is still live", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-live-owner-"));
    const target = path.join(directory, "shared.txt");
    const original = Buffer.from("alpha=1\n");
    const intended = Buffer.from("alpha=2\n");
    fs.writeFileSync(target, "alp");
    const identity = fs.statSync(target);
    const realPath = fs.realpathSync(target);
    const recoveryDirectory = path.join(editRecoveryRoot, "edit-recovery");
    fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      path: realPath,
      fileDev: identity.dev,
      fileIno: identity.ino,
      ownerPid: process.ppid,
      state: "prepared",
      beforeBase64: original.toString("base64"),
      afterBase64: intended.toString("base64"),
      beforeSha256: createHash("sha256").update(original).digest("hex"),
      afterSha256: createHash("sha256").update(intended).digest("hex"),
    };
    const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const recoveryId = recoveryRecordId(realPath);
    const recordPath = path.join(recoveryDirectory, `${recoveryId}.json`);
    fs.writeFileSync(recordPath, JSON.stringify({ ...payload, checksum }), {
      mode: 0o600,
      flag: "wx",
    });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/another live CoWork process owns this edit transaction/i);
      expect(result.error).toMatch(
        /no changes were made by this request; retry after the other edit finishes/i,
      );
      expect(fs.readFileSync(target, "utf8")).toBe("alp");
      expect(fs.existsSync(recordPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not discard a live record that replaced the orphan it inspected", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-orphan-race-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
      transactionId: "00000000-0000-4000-8000-000000000001",
      ownerBootTimeMs: Date.now() - os.uptime() * 1000,
    });
    let replacement = "";
    class RacingEditTools extends EditTools {
      protected override beforeOrphanRecoveryRecordRemoval(orphanPath: string): void {
        // Simulate another process discarding the same orphan and starting its own edit.
        fs.unlinkSync(orphanPath);
        writePreparedRecoveryReceipt({
          target,
          before: Buffer.from("alpha=1\n"),
          after: Buffer.from("alpha=2\n"),
          ownerPid: process.ppid,
          transactionId: "00000000-0000-4000-8000-000000000002",
          ownerBootTimeMs: Date.now() - os.uptime() * 1000,
        });
        replacement = fs.readFileSync(orphanPath, "utf8");
      }
    }
    const editor = new RacingEditTools(
      { ...mockWorkspace, path: directory },
      mockDaemon as Any,
      "task",
    );

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/replaced the recovery record/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
      expect(fs.readFileSync(recordPath, "utf8")).toBe(replacement);
      expect(fs.readdirSync(path.dirname(recordPath))).toEqual([path.basename(recordPath)]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reclaims a finished live-owner record restored by a concurrent reconciler", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-restored-commit-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const bootTimeMs = Date.now() - os.uptime() * 1000;
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
      transactionId: "00000000-0000-4000-8000-000000000005",
      ownerBootTimeMs: bootTimeMs,
    });
    class RacingEditTools extends EditTools {
      protected override beforeOrphanRecoveryRecordRemoval(orphanPath: string): void {
        // Live owner B (a long-lived PID) replaced the orphan with its own record and finished
        // its write. This reconciler (C) then tombstones B's committed record; B's by-path
        // unlink in that window hits ENOENT and is ignored, and C restores the finished record.
        fs.unlinkSync(orphanPath);
        writePreparedRecoveryReceipt({
          target,
          before: Buffer.from("alpha=1\n"),
          after: Buffer.from("alpha=4\n"),
          ownerPid: process.ppid,
          transactionId: "00000000-0000-4000-8000-000000000006",
          ownerBootTimeMs: bootTimeMs,
          state: "committed",
        });
        fs.writeFileSync(target, "alpha=4\n");
      }
    }
    const workspace = { ...mockWorkspace, path: directory };

    try {
      const raced = await new RacingEditTools(workspace, mockDaemon as Any, "task").editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(raced.success).toBe(false);
      expect(raced.error).toMatch(/replaced the recovery record/i);
      // The stuck state: B's finished record is back at recordPath and B is still alive.
      expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).state).toBe("committed");
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=4\n");

      const retried = await new EditTools(workspace, mockDaemon as Any, "task").editFile({
        file_path: "shared.txt",
        old_string: "alpha=4",
        new_string: "alpha=5",
      });
      expect(retried.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=5\n");
      expect(fs.readdirSync(path.dirname(recordPath))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps blocking on a live owner's prepared record even when the target shows after-bytes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-live-prepared-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=2\n");
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
      ownerPid: process.ppid,
      transactionId: "00000000-0000-4000-8000-000000000007",
      ownerBootTimeMs: Date.now() - os.uptime() * 1000,
    });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=2",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/another live CoWork process owns this edit transaction/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=2\n");
      expect(fs.existsSync(recordPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats a record from a previous boot as orphaned even if its PID is alive", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-reboot-owner-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
      ownerPid: process.ppid,
      transactionId: "00000000-0000-4000-8000-000000000003",
      ownerBootTimeMs: Date.now() - os.uptime() * 1000 - 24 * 60 * 60 * 1000,
    });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=3\n");
      expect(fs.existsSync(recordPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an EPERM owner as alive only within the current boot", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-eperm-owner-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");
    const receipt = (ownerBootTimeMs: number) =>
      writePreparedRecoveryReceipt({
        target,
        before: Buffer.from("alpha=1\n"),
        after: Buffer.from("alpha=2\n"),
        ownerPid: 424242,
        transactionId: "00000000-0000-4000-8000-000000000004",
        ownerBootTimeMs,
      });

    try {
      const sameBoot = receipt(Date.now() - os.uptime() * 1000);
      const blocked = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/another live CoWork process owns this edit transaction/i);
      expect(fs.existsSync(sameBoot)).toBe(true);
      fs.unlinkSync(sameBoot);

      const previousBoot = receipt(Date.now() - os.uptime() * 1000 - 24 * 60 * 60 * 1000);
      const recovered = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(recovered.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=3\n");
      expect(fs.existsSync(previousBoot)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a forged private receipt without changing the target", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-forged-receipt-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const recordPath = writePreparedRecoveryReceipt({
      target,
      before: Buffer.from("alpha=1\n"),
      after: Buffer.from("alpha=2\n"),
    });
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.afterBase64 = Buffer.from("forged recovery payload\n").toString("base64");
    fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery record failed its integrity check/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=1\n");
      expect(fs.existsSync(recordPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores repository-controlled recovery sidecars", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-untrusted-sidecar-"));
    const target = path.join(directory, "shared.txt");
    fs.writeFileSync(target, "alpha=1\n");
    const recoveryId = createHash("sha256").update(target).digest("hex");
    const untrustedSidecar = path.join(directory, `.cowork-edit-recovery-${recoveryId}.json`);
    fs.writeFileSync(untrustedSidecar, '{"state":"prepared"}');
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("alpha=2\n");
      expect(fs.readFileSync(untrustedSidecar, "utf8")).toBe('{"state":"prepared"}');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains before and after bytes without overwriting a partial descriptor write failure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-partial-write-"));
    const target = path.join(directory, "shared.txt");
    const originalContent = "alpha=1\nbeta=1\n";
    fs.writeFileSync(target, originalContent);
    const editor = new PartialWriteEditTools(
      { ...mockWorkspace, path: directory },
      mockDaemon as Any,
      "task",
    );

    try {
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=2",
      });
      expect(editor.didInjectPartial).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery is required/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alp");
      const records = fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"));
      expect(records).toHaveLength(1);
      const receipt = JSON.parse(
        fs.readFileSync(path.join(editRecoveryRoot, "edit-recovery", records[0]), "utf8"),
      );
      expect(Buffer.from(receipt.beforeBase64, "base64").toString()).toBe(originalContent);
      expect(Buffer.from(receipt.afterBase64, "base64").toString()).toBe(
        originalContent.replace("alpha=1", "alpha=2"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("edit kill-point worker for recovery regression", async () => {
    if (process.env.COWORK_EDIT_KILL_CHILD !== "1") return;
    const workspacePath = process.env.COWORK_EDIT_KILL_WORKSPACE;
    const target = process.env.COWORK_EDIT_KILL_TARGET;
    const marker = process.env.COWORK_EDIT_KILL_MARKER;
    if (!workspacePath || !target || !marker) throw new Error("Missing kill-point test inputs");
    const editor = new KillDuringWriteEditTools(
      { ...mockWorkspace, path: workspacePath },
      { logEvent: vi.fn() } as Any,
      "kill-point-task",
    );
    await editor.editFile({
      file_path: path.basename(target),
      old_string: "alpha=1",
      new_string: "alpha=2",
    });
    throw new Error("Expected the kill-point worker to be terminated during its file write");
  });

  it("preserves a process-killed write until explicit reconciliation then permits the next edit", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-killed-write-"));
    const target = path.join(directory, "shared.txt");
    const marker = path.join(directory, "kill-marker.txt");
    const originalContent = "alpha=1\nbeta=1\n";
    fs.writeFileSync(target, originalContent);
    const child = runEditCrashWorker({
      target,
      workspacePath: directory,
      recoveryRoot: editRecoveryRoot,
      marker,
    });

    try {
      expect(child.error).toBeUndefined();
      expect(child.status === 0).toBe(false);
      expect(fs.readFileSync(marker, "utf8")).toBe("kill-point reached");
      expect(fs.readFileSync(target, "utf8")).toBe("alp");
      const editor = new EditTools(
        { ...mockWorkspace, path: directory },
        mockDaemon as Any,
        "task",
      );
      const result = await editor.editFile({
        file_path: "shared.txt",
        old_string: "not-present",
        new_string: "x",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recovery is required/i);
      expect(fs.readFileSync(target, "utf8")).toBe("alp");
      const records = fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"));
      expect(records).toHaveLength(1);
      const receipt = JSON.parse(
        fs.readFileSync(path.join(editRecoveryRoot, "edit-recovery", records[0]), "utf8"),
      );
      expect(Buffer.from(receipt.beforeBase64, "base64").toString()).toBe(originalContent);
      // Explicit operator reconciliation is distinct from automatic recovery.
      fs.writeFileSync(target, Buffer.from(receipt.beforeBase64, "base64"));
      const resumed = await editor.editFile({
        file_path: "shared.txt",
        old_string: "alpha=1",
        new_string: "alpha=3",
      });
      expect(resumed.success).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(originalContent.replace("alpha=1", "alpha=3"));
      expect(fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"))).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["user edit after interrupted write\n", "al", ""])(
    "preserves external post-kill bytes %j and retains the recovery record",
    async (externalContent) => {
      if (process.platform === "win32") return;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-post-kill-edit-"));
      const target = path.join(directory, "shared.txt");
      const marker = path.join(directory, "kill-marker.txt");
      fs.writeFileSync(target, "alpha=1\nbeta=1\n");
      const child = runEditCrashWorker({
        target,
        workspacePath: directory,
        recoveryRoot: editRecoveryRoot,
        marker,
      });

      try {
        expect(child.error).toBeUndefined();
        expect(child.status === 0).toBe(false);
        expect(fs.readFileSync(marker, "utf8")).toBe("kill-point reached");
        fs.writeFileSync(target, externalContent);
        const editor = new EditTools(
          { ...mockWorkspace, path: directory },
          mockDaemon as Any,
          "task",
        );
        const result = await editor.editFile({
          file_path: "shared.txt",
          old_string: "alpha=1",
          new_string: "alpha=2",
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/recovery is required/i);
        expect(result.error).toMatch(/current user content was preserved/i);
        expect(fs.readFileSync(target, "utf8")).toBe(externalContent);
        expect(fs.readdirSync(path.join(editRecoveryRoot, "edit-recovery"))).toHaveLength(1);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

async function editFixture(
  content: string | Buffer,
  input: { old_string: string; new_string: string; replace_all?: boolean },
): Promise<{ result: Awaited<ReturnType<EditTools["editFile"]>>; bytes: Buffer }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-edit-matching-"));
  const target = path.join(directory, "target.txt");
  fs.writeFileSync(target, content);
  try {
    const editor = new EditTools({ ...mockWorkspace, path: directory }, mockDaemon as Any, "task");
    const result = await editor.editFile({ file_path: "target.txt", ...input });
    return { result, bytes: fs.readFileSync(target) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("edit line-ending tolerance", () => {
  it("matches an LF old_string in a CRLF file and keeps CRLF endings", async () => {
    const { result, bytes } = await editFixture("alpha=1\r\nbeta=1\r\ngamma=1\r\n", {
      old_string: "alpha=1\nbeta=1",
      new_string: "alpha=2\nbeta=2\nbeta2=2",
    });
    expect(result.success, result.error).toBe(true);
    expect(result.replacements).toBe(1);
    expect(bytes.toString("utf8")).toBe("alpha=2\r\nbeta=2\r\nbeta2=2\r\ngamma=1\r\n");
  });

  it("writes new lines with the file's CRLF endings for a single-line match", async () => {
    const { result, bytes } = await editFixture("a\r\nb\r\n", {
      old_string: "b",
      new_string: "b\nc",
    });
    expect(result.success, result.error).toBe(true);
    expect(bytes.toString("utf8")).toBe("a\r\nb\r\nc\r\n");
  });

  it("matches a CRLF old_string in an LF file and keeps LF endings", async () => {
    const { result, bytes } = await editFixture("a\nb\nc\n", {
      old_string: "a\r\nb",
      new_string: "x\r\ny",
    });
    expect(result.success, result.error).toBe(true);
    expect(bytes.toString("utf8")).toBe("x\ny\nc\n");
  });

  it("keeps replace_all counts and uniqueness under line-ending tolerance", async () => {
    const all = await editFixture("k=1\r\nv\r\nk=1\r\nv\r\n", {
      old_string: "k=1\nv",
      new_string: "k=2\nv",
      replace_all: true,
    });
    expect(all.result.success, all.result.error).toBe(true);
    expect(all.result.replacements).toBe(2);
    expect(all.bytes.toString("utf8")).toBe("k=2\r\nv\r\nk=2\r\nv\r\n");

    const ambiguous = await editFixture("k=1\r\nv\r\nk=1\r\nv\r\n", {
      old_string: "k=1\nv",
      new_string: "k=2\nv",
    });
    expect(ambiguous.result.success).toBe(false);
    expect(ambiguous.result.error).toContain("found 2 times");
    expect(ambiguous.bytes.toString("utf8")).toBe("k=1\r\nv\r\nk=1\r\nv\r\n");
  });
});

describe("edit numbered-view prefixes", () => {
  it("strips cat -n style line-number prefixes that match the file's line numbers", async () => {
    const { result, bytes } = await editFixture("one\ntwo\nthree\nfour\n", {
      old_string: "     2\ttwo\n     3\tthree",
      new_string: "TWO\nTHREE",
    });
    expect(result.success, result.error).toBe(true);
    expect(bytes.toString("utf8")).toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("strips matching grep -n style prefixes from new_string too", async () => {
    const { result, bytes } = await editFixture("one\ntwo\nthree\nfour\n", {
      old_string: "2:two\n3:three",
      new_string: "2:TWO\n3:THREE",
    });
    expect(result.success, result.error).toBe(true);
    expect(bytes.toString("utf8")).toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("does not strip prefixes whose numbers disagree with the file", async () => {
    const { result, bytes } = await editFixture("one\ntwo\nthree\nfour\n", {
      old_string: "     7\ttwo\n     8\tthree",
      new_string: "TWO\nTHREE",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("old_string not found");
    expect(bytes.toString("utf8")).toBe("one\ntwo\nthree\nfour\n");
  });
});

describe("edit miss diagnostics", () => {
  const source = [
    "function main() {",
    "    if (ready) {",
    "        const total = computeTotal(items);",
    "        report(total);",
    "    }",
    "}",
    "",
  ].join("\n");

  it("reports where the text is when only whitespace or indentation differs", async () => {
    const { result, bytes } = await editFixture(source, {
      old_string: "if (ready) {\n  const total = computeTotal(items);\n  report(total);\n}",
      new_string: "if (ready) {}",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("old_string not found");
    expect(result.error).toContain("lines 2-5");
    expect(result.error).toMatch(/whitespace or indentation/i);
    expect(result.error).toContain(
      "    if (ready) {\n        const total = computeTotal(items);\n        report(total);\n    }",
    );
    expect(bytes.toString("utf8")).toBe(source);
  });

  it("points at the most similar line and its first difference for a near miss", async () => {
    const { result } = await editFixture(source, {
      old_string: "        const total = computeTotl(items);",
      new_string: "        const total = sum(items);",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("line 3");
    expect(result.error).toContain("const total = computeTotal(items);");
    expect(result.error).toContain("computeTotl");
  });

  it("says so when nothing in the file resembles old_string", async () => {
    const { result } = await editFixture(source, {
      old_string: "zebra quantum xylophone",
      new_string: "anything",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no similar text/i);
  });

  it("calls out stale line-number prefixes", async () => {
    const { result } = await editFixture(source, {
      old_string: "    12\t        report(total);",
      new_string: "        report(total, true);",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/line-number prefix/i);
    expect(result.error).toContain("line 4");
  });
});

describe("edit encoding safety", () => {
  // "café = 1\nname = René\n" in Windows-1252: é is the single byte 0xE9.
  const cp1252 = Buffer.concat([
    Buffer.from("caf"),
    Buffer.from([0xe9]),
    Buffer.from(" = 1\nname = Ren"),
    Buffer.from([0xe9]),
    Buffer.from("\n"),
  ]);

  it("refuses a non-ASCII edit of a Windows-1252 file instead of re-encoding it", async () => {
    const { result, bytes } = await editFixture(cp1252, {
      old_string: "name = René",
      new_string: "name = Renée",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not valid UTF-8/);
    expect(result.error).toContain("line 1");
    expect(bytes.equals(cp1252)).toBe(true);
  });

  it("applies an ASCII edit to a Windows-1252 file without touching other bytes", async () => {
    const { result, bytes } = await editFixture(cp1252, {
      old_string: " = 1\nname",
      new_string: " = 2\nname",
    });
    expect(result.success, result.error).toBe(true);
    const expected = Buffer.from(cp1252);
    expected[cp1252.indexOf(" = 1") + 3] = "2".charCodeAt(0);
    expect(bytes.equals(expected)).toBe(true);
  });

  it("refuses UTF-16 files", async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("hello\nworld\n", "utf16le"),
    ]);
    const { result, bytes } = await editFixture(utf16, { old_string: "h", new_string: "j" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UTF-16/);
    expect(bytes.equals(utf16)).toBe(true);
  });

  it("refuses an ASCII match that could be the second byte of a multi-byte character", async () => {
    // Shift_JIS "ソ" is 0x83 0x5C; 0x5C is also ASCII "\".
    const shiftJis = Buffer.from([0x83, 0x5c, 0x0a, 0x61, 0x0a]);
    const { result, bytes } = await editFixture(shiftJis, { old_string: "\\", new_string: "/" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multi-byte/);
    expect(bytes.equals(shiftJis)).toBe(true);
  });

  it("keeps a UTF-8 byte order mark and multi-byte text intact", async () => {
    const utf8 = Buffer.from("\ufeffnaïve = 1\n日本 = 2\n", "utf8");
    const { result, bytes } = await editFixture(utf8, {
      old_string: "日本 = 2",
      new_string: "日本 = 3",
    });
    expect(result.success, result.error).toBe(true);
    expect(bytes.equals(Buffer.from("\ufeffnaïve = 1\n日本 = 3\n", "utf8"))).toBe(true);
  });
});
