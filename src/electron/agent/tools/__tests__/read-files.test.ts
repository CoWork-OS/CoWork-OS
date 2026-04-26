import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "../../../../shared/types";

const { extractPdfTextMock } = vi.hoisted(() => ({
  extractPdfTextMock: vi.fn(),
}));

vi.mock("../../../utils/pdf-text", () => ({
  extractPdfText: extractPdfTextMock,
}));

import { FileTools } from "../file-tools";
import { GlobTools } from "../glob-tools";
import { readFilesByPatterns } from "../read-files";

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

describe("readFilesByPatterns", () => {
  let tmpDir: string;
  let workspace: Workspace;
  let fileTools: FileTools;
  let globTools: GlobTools;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-read-files-"));
    workspace = {
      id: "w1",
      name: "Test",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
      },
      isTemp: true,
    };

    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;

    fileTools = new FileTools(workspace, daemon, "task-1");
    globTools = new GlobTools(workspace, daemon, "task-1");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("reads matched files and returns their content", async () => {
    writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;\n");

    const res = await readFilesByPatterns({ patterns: ["src/**/*.ts"] }, { globTools, fileTools });

    expect(res.success).toBe(true);
    expect(res.totalMatched).toBe(2);
    expect(res.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(res.files[0].content).toContain("export const a");
    expect(res.files[1].content).toContain("export const b");
  });

  it("reads PDFs through the dedicated text extractor", async () => {
    writeFile(path.join(tmpDir, "docs", "book.pdf"), "%PDF-1.7");
    extractPdfTextMock.mockResolvedValue({
      text: "Bonjour le monde.\nDeuxieme ligne.",
      pageCount: 3,
      extractionMode: "pdf-parse",
      usedFallback: false,
      previewLimited: false,
      extractionStatus: "complete",
      extractionNote: "complete via embedded text layer; OCR not needed",
    });

    const out = await fileTools.readFile("docs/book.pdf");

    expect(out.format).toBe("pdf");
    expect(out.content).toContain("[PDF Metadata: Pages: 3 | Extraction:");
    expect(out.content).toContain("Extraction: complete via embedded text layer; OCR not needed");
    expect(out.content).toContain("Bonjour le monde.");
    expect(out.content).not.toContain("[Page 1]");
    expect(out.pdf_extraction).toEqual({
      status: "complete",
      mode: "pdf-parse",
      used_fallback: false,
      preview_limited: false,
      note: "complete via embedded text layer; OCR not needed",
      page_count: 3,
    });
    expect(extractPdfTextMock).toHaveBeenCalledOnce();
  });

  it("supports exclusion patterns with leading !", async () => {
    writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;\n");

    const res = await readFilesByPatterns(
      { patterns: ["src/**/*.ts", "!src/b.ts"] },
      { globTools, fileTools },
    );

    expect(res.success).toBe(true);
    expect(res.totalMatched).toBe(1);
    expect(res.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("truncates by maxFiles", async () => {
    writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
    writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;\n");

    const res = await readFilesByPatterns(
      { patterns: ["src/**/*.ts"], maxFiles: 1 },
      { globTools, fileTools },
    );

    expect(res.success).toBe(true);
    expect(res.files.length).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it("truncates by maxTotalChars", async () => {
    const big = "x".repeat(1500);
    writeFile(path.join(tmpDir, "src", "big.txt"), big);
    writeFile(path.join(tmpDir, "src", "small.txt"), "small\n");

    const res = await readFilesByPatterns(
      { patterns: ["src/*.txt"], maxTotalChars: 1000, maxFiles: 10 },
      { globTools, fileTools },
    );

    expect(res.success).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.files[0].content.length).toBeLessThanOrEqual(1000);
  });

  it("remaps stale absolute paths that include the workspace folder name", async () => {
    const workspaceRoot = path.join(tmpDir, "new-bitcoin2");
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-2");

    const filename = "research_step1_crypto_imperfections.md";
    const expectedContent = "evidence in current workspace";
    writeFile(path.join(workspaceRoot, filename), expectedContent);

    const staleAbsolutePath = path.join(
      path.sep,
      "Users",
      "almarion",
      "Desktop",
      "new",
      "new-bitcoin2",
      filename,
    );

    const out = await scopedFileTools.readFile(staleAbsolutePath);
    expect(out.content).toContain(expectedContent);
  });

  it("recovers stale absolute read paths by matching a nested suffix inside the workspace", async () => {
    const workspaceRoot = path.join(tmpDir, "current-workspace");
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-3");

    const relativePath = path.join(
      "subconscious",
      "targets",
      "role-a",
      "runs",
      "run-1",
      "winning-recommendation.md",
    );
    const expectedContent = "fresh workspace recommendation";
    writeFile(path.join(workspaceRoot, relativePath), expectedContent);

    const staleAbsolutePath = path.join(
      path.sep,
      "Users",
      "almarion",
      "Desktop",
      "new",
      "new2",
      ...relativePath.split(path.sep),
    );

    const out = await scopedFileTools.readFile(staleAbsolutePath);
    expect(out.content).toContain(expectedContent);
    expect(out.path).toBe(relativePath.replace(/\\/g, "/"));
  });

  it("recovers stale absolute read paths by falling back to a workspace-root filename", async () => {
    const workspaceRoot = path.join(tmpDir, "current-workspace-root");
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-4");

    const filename = "project-manager-subconscious.md";
    const expectedContent = "workspace root recovery";
    writeFile(path.join(workspaceRoot, filename), expectedContent);

    const staleAbsolutePath = path.join(
      path.sep,
      "Users",
      "almarion",
      "Desktop",
      "old-root",
      filename,
    );

    const out = await scopedFileTools.readFile(staleAbsolutePath);
    expect(out.content).toContain(expectedContent);
    expect(out.path).toBe(filename);
  });

  it("remaps /workspace alias paths into the active workspace for writes", async () => {
    const out = await fileTools.writeFile("/workspace/influencer-chat-app/src/data/influencers.ts", "ok");
    expect(out.success).toBe(true);
    expect(out.path).toBe("influencer-chat-app/src/data/influencers.ts");
    expect(
      fs.readFileSync(path.join(tmpDir, "influencer-chat-app", "src", "data", "influencers.ts"), "utf-8"),
    ).toBe("ok");
  });

  it("blocks /workspace alias paths when strict alias policy is enabled", async () => {
    fileTools.setWorkspacePathAliasPolicy("strict_fail");
    await expect(fileTools.writeFile("/workspace/influencer-chat-app/src/data/influencers.ts", "x")).rejects.toThrow(
      /alias policy/i,
    );
  });

  it("redirects new automated task outputs into the managed .cowork zone", async () => {
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
      getTask: vi.fn(() => ({
        id: "task-auto",
        source: "hook",
        title: "Chief of Staff briefing",
      })),
    } as Any;
    const automatedFileTools = new FileTools(workspace, daemon, "task-auto");

    const out = await automatedFileTools.writeFile("editor-startup-checklist.md", "checklist");

    expect(out.success).toBe(true);
    expect(out.path).toBe(".cowork/automated-outputs/task-auto/editor-startup-checklist.md");
    expect(
      fs.readFileSync(
        path.join(
          tmpDir,
          ".cowork",
          "automated-outputs",
          "task-auto",
          "editor-startup-checklist.md",
        ),
        "utf-8",
      ),
    ).toBe("checklist");
    expect(fs.existsSync(path.join(tmpDir, "editor-startup-checklist.md"))).toBe(false);
  });

  it("adds CoWork scratch paths to the local git exclude file instead of .gitignore", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-read-files-git-"));
    try {
      fs.mkdirSync(path.join(repoDir, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".git", "info", "exclude"), "# existing excludes\n", "utf-8");
      const gitWorkspace: Workspace = {
        ...workspace,
        path: repoDir,
        isTemp: false,
      };
      const daemon = {
        logEvent: vi.fn(),
        requestApproval: vi.fn(),
      } as Any;

      new FileTools(gitWorkspace, daemon, "task-git");

      const exclude = fs.readFileSync(path.join(repoDir, ".git", "info", "exclude"), "utf-8");
      expect(exclude).toContain(".cowork/tmp/");
      expect(exclude).toContain(".cowork/automated-outputs/");
      expect(fs.existsSync(path.join(repoDir, ".gitignore"))).toBe(false);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps manual task writes at the requested workspace path", async () => {
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
      getTask: vi.fn(() => ({
        id: "task-manual",
        source: "manual",
        title: "User requested file",
      })),
    } as Any;
    const manualFileTools = new FileTools(workspace, daemon, "task-manual");

    const out = await manualFileTools.writeFile("editor-startup-checklist.md", "manual");

    expect(out.success).toBe(true);
    expect(out.path).toBe("editor-startup-checklist.md");
    expect(fs.readFileSync(path.join(tmpDir, "editor-startup-checklist.md"), "utf-8")).toBe(
      "manual",
    );
  });

  it("returns canonical resolved path after case-insensitive fallback", async () => {
    writeFile(path.join(tmpDir, "docs", "spec.md"), "# Spec\n");

    const out = await fileTools.readFile("Docs/SPEC.md");
    expect(out.content).toContain("# Spec");
    expect(out.path).toBe("docs/spec.md");
  });

  it("blocks read_file symlink escapes outside workspace when unrestricted access is off", async () => {
    if (process.platform === "win32") return;

    const workspaceRoot = path.join(tmpDir, "secure-read");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-3");

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-outside-read-"));
    try {
      const outsideFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(outsideFile, "top-secret", "utf-8");
      const linkPath = path.join(workspaceRoot, "link-secret.txt");
      fs.symlinkSync(outsideFile, linkPath);

      await expect(scopedFileTools.readFile("link-secret.txt")).rejects.toThrow(
        /outside workspace boundary via symbolic link/i,
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("blocks write_file symlink escapes outside workspace when unrestricted access is off", async () => {
    if (process.platform === "win32") return;

    const workspaceRoot = path.join(tmpDir, "secure-write");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-4");

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-outside-write-"));
    try {
      const outsideFile = path.join(outsideDir, "target.txt");
      fs.writeFileSync(outsideFile, "old", "utf-8");
      const linkPath = path.join(workspaceRoot, "link-target.txt");
      fs.symlinkSync(outsideFile, linkPath);

      await expect(scopedFileTools.writeFile("link-target.txt", "new")).rejects.toThrow(
        /outside workspace boundary via symbolic link/i,
      );
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("old");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
