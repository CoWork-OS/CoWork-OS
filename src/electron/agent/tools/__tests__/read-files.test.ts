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

  it("enforces access-profile filesystem rules for reads, writes, and enumeration", async () => {
    const protectedDir = path.join(tmpDir, "private");
    const readableDir = path.join(tmpDir, "shared");
    writeFile(path.join(protectedDir, "secret.txt"), "secret");
    writeFile(path.join(readableDir, "public.txt"), "public");
    const scopedWorkspace: Workspace = {
      ...workspace,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        accessFilesystemRules: [
          { path: protectedDir, access: "deny" },
          { path: readableDir, access: "read" },
        ],
      },
    };
    const daemon = { logEvent: vi.fn(), requestApproval: vi.fn() } as Any;
    const scopedFileTools = new FileTools(scopedWorkspace, daemon, "task-profile");
    const scopedGlobTools = new GlobTools(scopedWorkspace, daemon, "task-profile");

    await expect(scopedFileTools.readFile("private/secret.txt")).rejects.toThrow(
      /denied by the active access profile/i,
    );
    await expect(scopedFileTools.writeFile("private/new.txt", "blocked")).rejects.toThrow(
      /denied by the active access profile/i,
    );
    const listing = await scopedFileTools.listDirectory(".");
    expect(listing.files.map((entry) => entry.name)).not.toContain("private");
    const glob = await scopedGlobTools.glob({ pattern: "**/*.txt" });
    expect(glob.matches.map((entry) => entry.path)).toEqual([path.join("shared", "public.txt")]);
  });

  it("does not treat rename as a write-only operation", async () => {
    const sourcePath = path.join(tmpDir, "source.txt");
    writeFile(sourcePath, "content");
    const writeOnlyWorkspace: Workspace = {
      ...workspace,
      permissions: {
        ...workspace.permissions,
        delete: false,
      },
    };
    const writeOnlyFileTools = new FileTools(
      writeOnlyWorkspace,
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-rename",
    );

    await expect(writeOnlyFileTools.renameFile("source.txt", "renamed.txt")).rejects.toThrow(
      /delete permission/i,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "renamed.txt"))).toBe(false);
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
    const out = await fileTools.writeFile(
      "/workspace/influencer-chat-app/src/data/influencers.ts",
      "ok",
    );
    expect(out.success).toBe(true);
    expect(out.path).toBe("influencer-chat-app/src/data/influencers.ts");
    expect(
      fs.readFileSync(
        path.join(tmpDir, "influencer-chat-app", "src", "data", "influencers.ts"),
        "utf-8",
      ),
    ).toBe("ok");
  });

  it("blocks /workspace alias paths when strict alias policy is enabled", async () => {
    fileTools.setWorkspacePathAliasPolicy("strict_fail");
    await expect(
      fileTools.writeFile("/workspace/influencer-chat-app/src/data/influencers.ts", "x"),
    ).rejects.toThrow(/alias policy/i);
  });

  it("blocks destructive root package.json marker-only overwrites", async () => {
    writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "cowork-os",
          version: "0.5.46",
          scripts: {
            dev: "node scripts/dev_with_logs.mjs",
            build: "vite build",
          },
          dependencies: {
            react: "^19.0.0",
          },
          devDependencies: {
            vite: "^7.0.0",
          },
        },
        null,
        2,
      ),
    );

    const markerOnlyManifest = JSON.stringify(
      {
        name: "cowork",
        private: true,
        version: "0.0.0",
        coworkBuildHealth: {
          routine: "CoWork OS Build Health Watcher",
          step: "package.json",
        },
      },
      null,
      2,
    );

    await expect(fileTools.writeFile("package.json", markerOnlyManifest)).rejects.toThrow(
      /Refusing to overwrite root package\.json/,
    );

    const packageJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(packageJson.scripts.dev).toBe("node scripts/dev_with_logs.mjs");
    expect(packageJson.scripts.build).toBe("vite build");
  });

  it("allows root package.json edits that preserve scripts and dependency sections", async () => {
    writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "cowork-os",
          version: "0.5.46",
          scripts: {
            dev: "node scripts/dev_with_logs.mjs",
            build: "vite build",
          },
          dependencies: {
            react: "^19.0.0",
          },
          devDependencies: {
            vite: "^7.0.0",
          },
        },
        null,
        2,
      ),
    );

    const updatedManifest = JSON.stringify(
      {
        name: "cowork-os",
        version: "0.5.47",
        scripts: {
          dev: "node scripts/dev_with_logs.mjs",
          build: "vite build",
        },
        dependencies: {
          react: "^19.0.0",
        },
        devDependencies: {
          vite: "^7.0.0",
        },
        coworkBuildHealth: {
          routine: "CoWork OS Build Health Watcher",
        },
      },
      null,
      2,
    );

    const out = await fileTools.writeFile("package.json", updatedManifest);

    expect(out.success).toBe(true);
    const packageJson = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
    expect(packageJson.version).toBe("0.5.47");
    expect(packageJson.scripts.dev).toBe("node scripts/dev_with_logs.mjs");
  });

  it("blocks destructive root package-lock.json marker-only overwrites", async () => {
    writeFile(
      path.join(tmpDir, "package-lock.json"),
      JSON.stringify(
        {
          name: "cowork-os",
          version: "0.5.46",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "cowork-os",
              version: "0.5.46",
            },
          },
        },
        null,
        2,
      ),
    );

    const markerOnlyLockfile = JSON.stringify(
      {
        artifact: "package-lock.json",
        routine: "CoWork OS Build Health Watcher",
      },
      null,
      2,
    );

    await expect(fileTools.writeFile("package-lock.json", markerOnlyLockfile)).rejects.toThrow(
      /Refusing to overwrite root package-lock\.json/,
    );

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "package-lock.json"), "utf-8"),
    );
    expect(packageLock.packages[""].name).toBe("cowork-os");
  });

  it("reports the stuck phase when write_file times out internally", async () => {
    (fileTools as Any).enforceSymlinkSafeAccess = vi.fn(() => new Promise(() => {}));

    await expect(
      fileTools.writeFile("stuck.md", "content", {
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/write_file timed out during enforce symlink safe access/i);
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
      fs.writeFileSync(
        path.join(repoDir, ".git", "info", "exclude"),
        "# existing excludes\n",
        "utf-8",
      );
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

  it("expands tilde paths before enforcing workspace boundaries for directory listings", async () => {
    const workspaceRoot = path.join(tmpDir, "tilde-boundary");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
        allowedPaths: [],
      } as Any,
    };
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    } as Any;
    const scopedFileTools = new FileTools(workspaceScoped, daemon, "task-tilde");

    await expect(scopedFileTools.listDirectory("~/Library/LaunchAgents")).rejects.toThrow(
      new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-tilde",
      "home_path_expanded",
      expect.objectContaining({
        tool: "list_directory",
        attemptedPath: "~/Library/LaunchAgents",
      }),
    );
  });

  it("expands tilde paths in the shared resolver for mutating file operations", () => {
    const workspaceRoot = path.join(tmpDir, "tilde-mutating");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspaceScoped: Workspace = {
      ...workspace,
      path: workspaceRoot,
      isTemp: false,
      permissions: {
        ...workspace.permissions,
        unrestrictedFileAccess: false,
        allowedPaths: [os.homedir()],
      } as Any,
    };
    const scopedFileTools = new FileTools(
      workspaceScoped,
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-tilde-write",
    );
    const requestedPath = "~/Library/LaunchAgents/example.plist";
    const expected = path.join(os.homedir(), "Library", "LaunchAgents", "example.plist");

    expect((scopedFileTools as Any).resolvePath(requestedPath, "write")).toBe(expected);
    expect((scopedFileTools as Any).resolvePath(requestedPath, "delete")).toBe(expected);
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
