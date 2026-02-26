/**
 * Tests for GrepTools - regex content search
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Import after mocking
import { GrepTools } from "../grep-tools";
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

describe("GrepTools", () => {
  let grepTools: GrepTools;

  beforeEach(() => {
    vi.clearAllMocks();
    grepTools = new GrepTools(mockWorkspace, mockDaemon as Any, "test-task-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getToolDefinitions", () => {
    it("should return grep tool definition", () => {
      const tools = GrepTools.getToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("grep");
      expect(tools[0].description).toContain("regex");
      expect(tools[0].input_schema.required).toContain("pattern");
    });

    it("should have correct input schema properties", () => {
      const tools = GrepTools.getToolDefinitions();
      const schema = tools[0].input_schema;

      expect(schema.properties).toHaveProperty("pattern");
      expect(schema.properties).toHaveProperty("path");
      expect(schema.properties).toHaveProperty("glob");
      expect(schema.properties).toHaveProperty("ignoreCase");
      expect(schema.properties).toHaveProperty("contextLines");
      expect(schema.properties).toHaveProperty("maxResults");
      expect(schema.properties).toHaveProperty("outputMode");
    });
  });

  describe("regex validation", () => {
    it("should reject invalid regex patterns", async () => {
      const result = await grepTools.grep({
        pattern: "[invalid(regex",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid regex");
    });

    it("should accept valid regex patterns", async () => {
      await grepTools.grep({ pattern: "async\\s+function" });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("async\\s+function"),
      });
    });
  });

  describe("path validation", () => {
    it("should reject paths outside workspace", async () => {
      const result = await grepTools.grep({
        pattern: "test",
        path: "../../../etc",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("within workspace");
    });

    it("should return error for non-existent paths", async () => {
      const result = await grepTools.grep({
        pattern: "test",
        path: "nonexistent-path-that-does-not-exist",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("parameter handling", () => {
    it("should accept ignoreCase parameter", async () => {
      await grepTools.grep({
        pattern: "test",
        ignoreCase: true,
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it("should accept contextLines parameter", async () => {
      await grepTools.grep({
        pattern: "test",
        contextLines: 3,
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it("should accept outputMode parameter", async () => {
      await grepTools.grep({
        pattern: "test",
        outputMode: "files_only",
      });

      expect(mockDaemon.logEvent).toHaveBeenCalled();
    });

    it("should accept glob filter parameter", async () => {
      await grepTools.grep({
        pattern: "test",
        glob: "*.ts",
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("*.ts"),
      });
    });
  });

  describe("glob pattern conversion", () => {
    it("should handle double-star and extensions", () => {
      const regex = (grepTools as Any).globToRegex("**/*.md");

      expect(regex.test("README.md")).toBe(true);
      expect(regex.test("docs/guide.md")).toBe(true);
      expect(regex.test("docs/guide.mdx")).toBe(false);
    });

    it("should handle brace expansion", () => {
      const regex = (grepTools as Any).globToRegex("**/*.{md,txt}");

      expect(regex.test("docs/readme.md")).toBe(true);
      expect(regex.test("docs/readme.txt")).toBe(true);
      expect(regex.test("docs/readme.pdf")).toBe(false);
    });

    it("should handle nested directories with double-star", () => {
      const regex = (grepTools as Any).globToRegex("**/src/**/*.ts");

      expect(regex.test("src/index.ts")).toBe(true);
      expect(regex.test("packages/core/src/utils/helper.ts")).toBe(true);
      expect(regex.test("src/components/Button.tsx")).toBe(false);
    });

    it("should handle single-star wildcard", () => {
      const regex = (grepTools as Any).globToRegex("*.ts");

      expect(regex.test("index.ts")).toBe(true);
      expect(regex.test("src/index.ts")).toBe(false);
    });

    it("should handle question mark wildcard", () => {
      const regex = (grepTools as Any).globToRegex("file?.ts");

      expect(regex.test("file1.ts")).toBe(true);
      expect(regex.test("fileA.ts")).toBe(true);
      expect(regex.test("file12.ts")).toBe(false);
    });

    it("should escape special regex characters", () => {
      const regex = (grepTools as Any).globToRegex("test[1].ts");

      expect(regex.test("test[1].ts")).toBe(true);
      expect(regex.test("test1.ts")).toBe(false);
    });
  });

  describe("globPatternToRegex", () => {
    it("should convert double-star followed by slash correctly", () => {
      const result = (grepTools as Any).globPatternToRegex("**/foo");

      expect(result).toBe("(?:.*/)?foo");
    });

    it("should convert double-star at end correctly", () => {
      const result = (grepTools as Any).globPatternToRegex("src/**");

      expect(result).toBe("src/.*");
    });

    it("should convert single-star correctly", () => {
      const result = (grepTools as Any).globPatternToRegex("*.ts");

      expect(result).toBe("[^/]*\\.ts");
    });

    it("should handle double-star alone", () => {
      const result = (grepTools as Any).globPatternToRegex("**");

      expect(result).toBe(".*");
    });

    it("should handle empty pattern", () => {
      const result = (grepTools as Any).globPatternToRegex("");

      expect(result).toBe("");
    });

    it("should handle pattern with multiple double-stars", () => {
      const regex = (grepTools as Any).globToRegex("**/src/**/test/**/*.ts");

      expect(regex.test("src/test/file.ts")).toBe(true);
      expect(regex.test("pkg/src/utils/test/unit/spec.ts")).toBe(true);
    });
  });

  describe("document-heavy workspace detection", () => {
    // Note: isDocumentHeavyWorkspace reads the workspace.path directory
    // Since we can't mock fs.readdirSync in ESM, we test the logic indirectly
    // through the grep method which triggers the heuristic

    it("should return false for non-existent workspace paths", async () => {
      // The workspace path doesn't exist, so readdirSync will throw
      // and the method should return false
      const testGrepTools = new GrepTools(
        { ...mockWorkspace, path: "/non-existent-path-12345" },
        mockDaemon as Any,
        "test-task-id",
      );

      const result = await (testGrepTools as Any).isDocumentHeavyWorkspace();

      expect(result).toBe(false);
    });

    it("should check files in the workspace root directory", async () => {
      // This tests that the method runs without throwing
      // The actual test workspace likely has few or no PDF files
      const result = await (grepTools as Any).isDocumentHeavyWorkspace();

      // Since /test/workspace doesn't exist, it should return false
      expect(result).toBe(false);
    });
  });

  describe("logging", () => {
    it("should log grep search event", async () => {
      await grepTools.grep({ pattern: "test" });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("Grep search"),
      });
    });

    it("should log tool result", async () => {
      await grepTools.grep({ pattern: "test" });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-id",
        "tool_result",
        expect.objectContaining({
          tool: "grep",
        }),
      );
    });
  });
});
