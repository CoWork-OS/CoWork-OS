/**
 * Tests for EditTools - surgical file editing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Import after mocking
import { EditTools } from "../edit-tools";
import { Workspace } from "../../../../shared/types";

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

describe("EditTools", () => {
  let editTools: EditTools;

  beforeEach(() => {
    vi.clearAllMocks();
    editTools = new EditTools(mockWorkspace, mockDaemon as Any, "test-task-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      expect(() =>
        (editor as Any).writeFileThroughDescriptor(target, "edited", originalIdentity),
      ).toThrow(/target changed/);
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
