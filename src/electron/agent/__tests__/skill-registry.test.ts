/**
 * Tests for SkillRegistry
 */
/* eslint-disable no-undef -- variables from top-level dynamic import */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import JSZip from "jszip";
import type { CustomSkill, SkillRegistryEntry, SkillSearchResult } from "../../../shared/types";

// Track file system operations
let mockFiles: Map<string, string> = new Map();
let mockDirs: Set<string> = new Set();
let mockRmSyncThrowOnceFor: string | null = null;

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/$/, "");
}

function parentDir(value: string): string {
  const normalized = normalizePath(value);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function ensureDir(value: string): void {
  let current = normalizePath(value);
  const toCreate: string[] = [];
  while (current && current !== "/" && !mockDirs.has(current)) {
    toCreate.push(current);
    current = parentDir(current);
  }
  mockDirs.add("/");
  for (const dir of toCreate.reverse()) {
    mockDirs.add(dir);
  }
}

function movePath(source: string, destination: string): void {
  const normalizedSource = normalizePath(source);
  const normalizedDestination = normalizePath(destination);

  if (mockFiles.has(normalizedSource)) {
    const value = mockFiles.get(normalizedSource);
    if (value !== undefined) {
      ensureDir(parentDir(normalizedDestination));
      mockFiles.set(normalizedDestination, value);
      mockFiles.delete(normalizedSource);
    }
    return;
  }

  if (mockDirs.has(normalizedSource)) {
    ensureDir(parentDir(normalizedDestination));
    ensureDir(normalizedDestination);
    for (const filePath of Array.from(mockFiles.keys())) {
      if (filePath.startsWith(`${normalizedSource}/`)) {
        const suffix = filePath.slice(normalizedSource.length);
        mockFiles.set(`${normalizedDestination}${suffix}`, mockFiles.get(filePath)!);
        mockFiles.delete(filePath);
      }
    }
    for (const dirPath of Array.from(mockDirs)) {
      if (dirPath === normalizedSource || dirPath.startsWith(`${normalizedSource}/`)) {
        const suffix = dirPath.slice(normalizedSource.length);
        mockDirs.add(`${normalizedDestination}${suffix}`);
        mockDirs.delete(dirPath);
      }
    }
  }
}

function pathExists(value: string): boolean {
  const normalized = normalizePath(value);
  return mockDirs.has(normalized) || mockFiles.has(normalized);
}

function removeMockPath(target: string): void {
  const normalized = normalizePath(target);
  if (mockRmSyncThrowOnceFor && normalized.includes(mockRmSyncThrowOnceFor)) {
    mockRmSyncThrowOnceFor = null;
    const error = new Error(`EPERM, Permission denied: ${target}`) as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  }

  mockFiles.delete(normalized);
  for (const filePath of Array.from(mockFiles.keys())) {
    if (filePath.startsWith(`${normalized}/`)) {
      mockFiles.delete(filePath);
    }
  }
  for (const dirPath of Array.from(mockDirs)) {
    if (dirPath === normalized || dirPath.startsWith(`${normalized}/`)) {
      mockDirs.delete(dirPath);
    }
  }
}

function listDirEntries(dir: string): Array<{ name: string; isDirectory: boolean }> {
  const normalizedDir = normalizePath(dir);
  const entries = new Map<string, { name: string; isDirectory: boolean }>();

  for (const candidate of mockDirs) {
    if (candidate === normalizedDir) continue;
    if (parentDir(candidate) === normalizedDir) {
      const name = candidate.split("/").pop() || candidate;
      entries.set(name, { name, isDirectory: true });
    }
  }

  for (const candidate of mockFiles.keys()) {
    if (parentDir(candidate) === normalizedDir) {
      const name = candidate.split("/").pop() || candidate;
      entries.set(name, { name, isDirectory: false });
    }
  }

  return Array.from(entries.values());
}

function managedPath(fileName: string): string {
  return `/mock/skills/${fileName}`;
}

// Mock electron app
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock child_process for git flows
vi.mock("child_process", () => ({
  execFile: vi.fn(
    (
      command: string,
      args: string[],
      optionsOrCallback: Any,
      maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : maybeCallback;

      if (!callback) {
        return;
      }

      if (command !== "git") {
        callback(new Error(`Unsupported command: ${command}`));
        return;
      }

      if (args[0] === "--version") {
        callback(null, "git version 2.39.0", "");
        return;
      }

      if (args[0] === "clone") {
        const targetDir = normalizePath(args[args.length - 1] || "/tmp/clone");
        ensureDir(targetDir);
        const sourceUrl = args[args.length - 2] || "";
        if (sourceUrl.includes("nested-skill-repo")) {
          ensureDir(`${targetDir}/skills/karpathy-guidelines`);
          mockFiles.set(
            `${targetDir}/skills/karpathy-guidelines/SKILL.md`,
            "---\nname: Nested Imported Skill\ndescription: Imported from a nested git skill repo\n---\n# Nested Imported Skill\n",
          );
        } else {
          mockFiles.set(
            `${targetDir}/SKILL.md`,
            "---\nname: Git Imported Skill\ndescription: Imported from a git repo\n---\n# Git Imported Skill\n",
          );
        }
        callback(null, "", "");
        return;
      }

      callback(new Error(`Unsupported git args: ${args.join(" ")}`));
    },
  ),
}));

// Mock fs module
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockImplementation((p: string) => pathExists(p)),
    readFileSync: vi.fn().mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      const value = mockFiles.get(normalized);
      if (value === undefined) {
        throw new Error(`File not found: ${p}`);
      }
      return value;
    }),
    writeFileSync: vi.fn().mockImplementation((p: string, content: string) => {
      const normalized = normalizePath(p);
      ensureDir(parentDir(normalized));
      mockFiles.set(normalized, content);
    }),
    copyFileSync: vi.fn().mockImplementation((src: string, dest: string) => {
      const normalizedSrc = normalizePath(src);
      const normalizedDest = normalizePath(dest);
      const value = mockFiles.get(normalizedSrc);
      if (value === undefined) {
        throw new Error(`File not found: ${src}`);
      }
      ensureDir(parentDir(normalizedDest));
      mockFiles.set(normalizedDest, value);
    }),
    readdirSync: vi.fn().mockImplementation((dir: string, options?: { withFileTypes?: boolean }) => {
      const entries = listDirEntries(dir);
      if (options?.withFileTypes) {
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: () => entry.isDirectory,
          isFile: () => !entry.isDirectory,
        }));
      }
      return entries.map((entry) => entry.name);
    }),
    mkdirSync: vi.fn().mockImplementation((dir: string) => {
      ensureDir(dir);
    }),
    renameSync: vi.fn().mockImplementation((src: string, dest: string) => {
      movePath(src, dest);
    }),
    statSync: vi.fn().mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (mockFiles.has(normalized)) {
        return {
          size: Buffer.byteLength(mockFiles.get(normalized) || "", "utf8"),
          isDirectory: () => false,
          isFile: () => true,
        };
      }
      if (mockDirs.has(normalized)) {
        return { size: 0, isDirectory: () => true, isFile: () => false };
      }
      throw new Error(`Path not found: ${p}`);
    }),
    lstatSync: vi.fn().mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (mockFiles.has(normalized)) {
        return {
          size: Buffer.byteLength(mockFiles.get(normalized) || "", "utf8"),
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      if (mockDirs.has(normalized)) {
        return {
          size: 0,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      }
      throw new Error(`Path not found: ${p}`);
    }),
    readlinkSync: vi.fn().mockImplementation(() => {
      throw new Error("No symlinks in mock fs");
    }),
    unlinkSync: vi.fn().mockImplementation((p: string) => {
      mockFiles.delete(normalizePath(p));
    }),
    chmodSync: vi.fn(),
    rmSync: vi.fn().mockImplementation((target: string) => {
      removeMockPath(target);
    }),
  },
  existsSync: vi.fn().mockImplementation((p: string) => pathExists(p)),
  readFileSync: vi.fn().mockImplementation((p: string) => {
    const normalized = normalizePath(p);
    const value = mockFiles.get(normalized);
    if (value === undefined) {
      throw new Error(`File not found: ${p}`);
    }
    return value;
  }),
  writeFileSync: vi.fn().mockImplementation((p: string, content: string) => {
    const normalized = normalizePath(p);
    ensureDir(parentDir(normalized));
    mockFiles.set(normalized, content);
  }),
  copyFileSync: vi.fn().mockImplementation((src: string, dest: string) => {
    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);
    const value = mockFiles.get(normalizedSrc);
    if (value === undefined) {
      throw new Error(`File not found: ${src}`);
    }
    ensureDir(parentDir(normalizedDest));
    mockFiles.set(normalizedDest, value);
  }),
  readdirSync: vi.fn().mockImplementation((dir: string, options?: { withFileTypes?: boolean }) => {
    const entries = listDirEntries(dir);
    if (options?.withFileTypes) {
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory,
        isFile: () => !entry.isDirectory,
      }));
    }
    return entries.map((entry) => entry.name);
  }),
  mkdirSync: vi.fn().mockImplementation((dir: string) => {
    ensureDir(dir);
  }),
  renameSync: vi.fn().mockImplementation((src: string, dest: string) => {
    movePath(src, dest);
  }),
  statSync: vi.fn().mockImplementation((p: string) => {
    const normalized = normalizePath(p);
    if (mockFiles.has(normalized)) {
      return {
        size: Buffer.byteLength(mockFiles.get(normalized) || "", "utf8"),
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    if (mockDirs.has(normalized)) {
      return { size: 0, isDirectory: () => true, isFile: () => false };
    }
    throw new Error(`Path not found: ${p}`);
  }),
  lstatSync: vi.fn().mockImplementation((p: string) => {
    const normalized = normalizePath(p);
    if (mockFiles.has(normalized)) {
      return {
        size: Buffer.byteLength(mockFiles.get(normalized) || "", "utf8"),
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    }
    if (mockDirs.has(normalized)) {
      return {
        size: 0,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    throw new Error(`Path not found: ${p}`);
  }),
  readlinkSync: vi.fn().mockImplementation(() => {
    throw new Error("No symlinks in mock fs");
  }),
  unlinkSync: vi.fn().mockImplementation((p: string) => {
    mockFiles.delete(normalizePath(p));
  }),
  chmodSync: vi.fn(),
  rmSync: vi.fn().mockImplementation((target: string) => {
    removeMockPath(target);
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Dynamic import after mocking
const { SkillRegistry, resetSkillRegistry } = await import("../skill-registry");

// Helper to create a mock skill
function createMockSkill(overrides: Partial<CustomSkill> = {}): CustomSkill {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    icon: "🧪",
    prompt: "Test prompt content",
    enabled: true,
    ...overrides,
  };
}

// Helper to create a mock registry entry
function createMockRegistryEntry(overrides: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    author: "Test Author",
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockRmSyncThrowOnceFor = null;
    mockDirs = new Set(["/", "/mock", "/mock/skills", "/mock/user", "/mock/user/data"]);
    mockFetch.mockReset();
    resetSkillRegistry();
    registry = new SkillRegistry({
      registryUrl: "https://test-registry.com/api",
      managedSkillsDir: "/mock/skills",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSkillRegistry();
  });

  describe("constructor", () => {
    it("should use default registry URL when not provided", () => {
      const defaultRegistry = new SkillRegistry({
        managedSkillsDir: "/mock/skills",
      });
      expect(defaultRegistry.getRegistryUrl()).toBe(
        "https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/registry",
      );
    });

    it("should use custom registry URL when provided", () => {
      expect(registry.getRegistryUrl()).toBe("https://test-registry.com/api");
    });
  });

  describe("search", () => {
    it("should search for skills and return results", async () => {
      const mockResults: SkillSearchResult = {
        query: "test",
        total: 2,
        page: 1,
        pageSize: 20,
        results: [
          createMockRegistryEntry({ id: "skill-1", name: "Skill 1" }),
          createMockRegistryEntry({ id: "skill-2", name: "Skill 2" }),
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResults),
      });

      const result = await registry.search("test");

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/skills/search?q=test"));
      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
    });

    it("should include pagination parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ query: "test", total: 0, page: 2, pageSize: 10, results: [] }),
      });

      await registry.search("test", { page: 2, pageSize: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/page=2.*pageSize=10|pageSize=10.*page=2/),
      );
    });

    it("should return empty results on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await registry.search("test");

      expect(result.total).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it("should return empty results on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await registry.search("test");

      expect(result.total).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });

  describe("getSkillDetails", () => {
    it("should fetch skill details by id", async () => {
      const mockEntry = createMockRegistryEntry();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEntry),
      });

      const result = await registry.getSkillDetails("test-skill");

      expect(mockFetch).toHaveBeenCalledWith("https://test-registry.com/api/skills/test-skill");
      expect(result).toEqual(mockEntry);
    });

    it("should return null for 404 response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await registry.getSkillDetails("non-existent");

      expect(result).toBeNull();
    });

    it("should return null on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await registry.getSkillDetails("test-skill");

      expect(result).toBeNull();
    });
  });

  describe("install", () => {
    it("should download and install a skill", async () => {
      const mockSkillData = createMockSkill();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSkillData),
      });

      const progressUpdates: string[] = [];
      const result = await registry.install("test-skill", undefined, (progress) => {
        progressUpdates.push(progress.status);
      });

      expect(result.success).toBe(true);
      expect(result.skill).toBeDefined();
      expect(result.skill?.id).toBe("test-skill");
      expect(result.skill?.source).toBe("managed");
      expect(progressUpdates).toContain("downloading");
      expect(progressUpdates).toContain("completed");
    });

    it("should include version in download URL when provided", async () => {
      const mockSkillData = createMockSkill();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSkillData),
      });

      await registry.install("test-skill", "1.2.3");

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("version=1.2.3"));
    });

    it("should return error on failed download", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await registry.install("non-existent");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to download");
    });

    it("should return error on invalid skill data", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ invalid: "data" }),
      });

      const result = await registry.install("test-skill");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill data");
    });

    it("should call progress callback with failure on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const progressUpdates: string[] = [];
      await registry.install("test-skill", undefined, (progress) => {
        progressUpdates.push(progress.status);
      });

      expect(progressUpdates).toContain("failed");
    });
  });

  describe("external imports", () => {
    it("installs a skill from a raw JSON URL", async () => {
      const mockSkillData = createMockSkill({ id: "remote-json" });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => "application/json",
        },
        arrayBuffer: () => {
          const bytes = Buffer.from(JSON.stringify(mockSkillData), "utf8");
          return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        },
      });

      const result = await registry.installFromUrl("https://example.com/remote-json.json");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("remote-json");
      expect(mockFiles.has(managedPath("remote-json.json"))).toBe(true);
    });

    it("installs a skill bundle from a raw SKILL.md URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => "text/markdown",
        },
        arrayBuffer: () => {
          const bytes = Buffer.from(
            "---\nname: Imported Bundle\ndescription: Imported bundle description\n---\n# Imported Bundle\n",
            "utf8",
          );
          return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        },
      });

      const result = await registry.installFromUrl("https://example.com/skills/SKILL.md");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("imported-bundle");
      expect(result.skill?.invocation?.disableModelInvocation).toBe(true);
      expect(mockFiles.has(managedPath("imported-bundle.json"))).toBe(true);
      expect(mockFiles.has(managedPath("imported-bundle/SKILL.md"))).toBe(true);
    });

    it("installs a skill bundle from a git repository", async () => {
      const result = await registry.installFromGit("https://github.com/example/skill-repo");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("git-imported-skill");
      expect(mockFiles.has(managedPath("git-imported-skill.json"))).toBe(true);
      expect(mockFiles.has(managedPath("git-imported-skill/SKILL.md"))).toBe(true);
    });

    it("does not fail a git install when temporary clone cleanup hits EPERM once", async () => {
      mockRmSyncThrowOnceFor = ".tmp-skill-repo-";

      const result = await registry.installFromGit("https://github.com/example/skill-repo");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("git-imported-skill");
      expect(mockFiles.has(managedPath("git-imported-skill.json"))).toBe(true);
      expect(mockFiles.has(managedPath("git-imported-skill/SKILL.md"))).toBe(true);
    });

    it("installs a single nested skills/*/SKILL.md bundle from a git repository", async () => {
      const result = await registry.installFromGit("https://github.com/example/nested-skill-repo");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("nested-imported-skill");
      expect(mockFiles.has(managedPath("nested-imported-skill.json"))).toBe(true);
      expect(mockFiles.has(managedPath("nested-imported-skill/SKILL.md"))).toBe(true);
    });

    it("rejects oversized remote skill instructions before import", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => (name === "content-type" ? "text/markdown" : "600000"),
        },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

      const result = await registry.installFromUrl("https://example.com/skills/SKILL.md");

      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds");
    });
  });

  describe("clawhub imports", () => {
    it("returns the top downloaded ClawHub skills when the query is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            value: {
              page: [
                {
                  ownerHandle: "pskoett",
                  latestVersion: { version: "3.0.10" },
                  skill: {
                    slug: "self-improving-agent",
                    displayName: "self-improving-agent",
                    summary: "Captures learnings and corrections.",
                    stats: {
                      downloads: 323357,
                      stars: 2819,
                      installsCurrent: 5090,
                      installsAllTime: 5348,
                    },
                    tags: { latest: "3.0.10" },
                  },
                },
              ],
            },
          }),
      });

      const result = await registry.searchClawHub("", { pageSize: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://wry-manatee-359.convex.cloud/api/query",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.id).toBe("self-improving-agent");
      expect(result.results[0]?.downloads).toBe(323357);
      expect(result.results[0]?.stars).toBe(2819);
      expect(result.results[0]?.installsCurrent).toBe(5090);
      expect(result.results[0]?.installsAllTime).toBe(5348);
    });

    it("searches ClawHub and falls back to exact slug lookup", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "success",
              value: [],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              skill: {
                slug: "self-improving-agent",
                displayName: "self-improving-agent",
                summary: "Captures learnings and corrections.",
                tags: { latest: "3.0.10" },
                stats: { downloads: 12 },
              },
              owner: { handle: "pskoett" },
              latestVersion: { version: "3.0.10" },
            }),
        });

      const result = await registry.searchClawHub("self improving");

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.id).toBe("self-improving-agent");
      expect(result.results[0]?.source).toBe("clawhub");
      expect(result.results[0]?.downloads).toBe(12);
    });

    it("searches ClawHub and returns stats-rich action results", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            value: [
              {
                ownerHandle: "pskoett",
                version: { version: "3.0.10" },
                skill: {
                  slug: "self-improving-agent",
                  displayName: "self-improving-agent",
                  summary: "Captures learnings and corrections.",
                  stats: {
                    downloads: 323357,
                    stars: 2819,
                    installsCurrent: 5090,
                    installsAllTime: 5348,
                  },
                  tags: { latest: "3.0.10" },
                },
              },
            ],
          }),
      });

      const result = await registry.searchClawHub("self improving agent");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://wry-manatee-359.convex.cloud/api/action",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.id).toBe("self-improving-agent");
      expect(result.results[0]?.stars).toBe(2819);
      expect(result.results[0]?.downloads).toBe(323357);
      expect(result.results[0]?.installsCurrent).toBe(5090);
      expect(result.results[0]?.installsAllTime).toBe(5348);
    });

    it("downloads and installs a ClawHub zip bundle", async () => {
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: Self Improving Agent\ndescription: Learns from failures.\n---\n# Self Improving Agent\n",
      );
      zip.file("references/guide.md", "# Guide");
      const zipBytes = await zip.generateAsync({ type: "uint8array" });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              skill: {
                slug: "self-improving-agent",
                displayName: "self-improving-agent",
                summary: "Captures learnings and corrections.",
                tags: { latest: "3.0.10" },
              },
              owner: { handle: "pskoett" },
              latestVersion: { version: "3.0.10" },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () =>
            Promise.resolve(
              zipBytes.buffer.slice(
                zipBytes.byteOffset,
                zipBytes.byteOffset + zipBytes.byteLength,
              ),
            ),
        });

      const result = await registry.installFromClawHub("https://clawhub.ai/pskoett/self-improving-agent");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("self-improving-agent");
      expect(result.skill?.metadata?.homepage).toBe(
        "https://clawhub.ai/pskoett/self-improving-agent",
      );
      expect(mockFiles.has(managedPath("self-improving-agent.json"))).toBe(true);
      expect(mockFiles.has(managedPath("self-improving-agent/SKILL.md"))).toBe(true);
      expect(mockFiles.has(managedPath("self-improving-agent/references/guide.md"))).toBe(true);
    });

    it("preserves the ClawHub slug even when the bundle frontmatter uses a different id", async () => {
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: self-improvement\ndescription: Learns from failures.\n---\n# Self Improvement\n",
      );
      const zipBytes = await zip.generateAsync({ type: "uint8array" });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              skill: {
                slug: "self-improving-agent",
                displayName: "self-improving-agent",
                summary: "Captures learnings and corrections.",
                tags: { latest: "3.0.10" },
              },
              owner: { handle: "pskoett" },
              latestVersion: { version: "3.0.10" },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () =>
            Promise.resolve(
              zipBytes.buffer.slice(
                zipBytes.byteOffset,
                zipBytes.byteOffset + zipBytes.byteLength,
              ),
            ),
        });

      const result = await registry.installFromClawHub("https://clawhub.ai/pskoett/self-improving-agent");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("self-improving-agent");
      expect(mockFiles.has(managedPath("self-improving-agent.json"))).toBe(true);
    });
  });

  describe("update", () => {
    it("should return error if skill is not installed", async () => {
      const result = await registry.update("non-installed");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });

    it("should re-install skill when updating", async () => {
      // First install a skill
      const skillData = createMockSkill({ id: "update-skill" });
      mockFiles.set(managedPath("update-skill.json"), JSON.stringify(skillData));

      // Mock the fetch for update
      const updatedSkill = { ...skillData, metadata: { version: "2.0.0" } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(updatedSkill),
      });

      const result = await registry.update("update-skill");

      expect(result.success).toBe(true);
      expect(result.skill?.id).toBe("update-skill");
    });

    it("restores the installed skill if the update download fails", async () => {
      const skillData = createMockSkill({ id: "restore-skill", metadata: { version: "1.0.0" } });
      mockFiles.set(managedPath("restore-skill.json"), JSON.stringify(skillData));

      mockFetch.mockRejectedValueOnce(new Error("network down"));

      const result = await registry.update("restore-skill");

      expect(result.success).toBe(false);
      expect(result.error).toContain("network down");
      expect(mockFiles.get(managedPath("restore-skill.json"))).toBe(
        JSON.stringify(skillData),
      );
    });
  });

  describe("uninstall", () => {
    it("should remove skill file", () => {
      const skillData = createMockSkill({ id: "to-uninstall" });
      mockFiles.set(managedPath("to-uninstall.json"), JSON.stringify(skillData));

      const result = registry.uninstall("to-uninstall");

      expect(result.success).toBe(true);
    });

    it("should return error if skill not installed", () => {
      const result = registry.uninstall("non-existent");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });

  describe("listManagedSkills", () => {
    it("should return empty array when no skills", () => {
      const skills = registry.listManagedSkills();
      expect(skills).toEqual([]);
    });

    it("should return all managed skills", () => {
      const skill1 = createMockSkill({ id: "skill-1" });
      const skill2 = createMockSkill({ id: "skill-2" });

      mockFiles.set(managedPath("skill-1.json"), JSON.stringify(skill1));
      mockFiles.set(managedPath("skill-2.json"), JSON.stringify(skill2));

      const skills = registry.listManagedSkills();

      expect(skills).toHaveLength(2);
      expect(skills.every((s) => s.source === "managed")).toBe(true);
    });

    it("should skip non-json files", () => {
      mockFiles.set(managedPath("skill-1.json"), JSON.stringify(createMockSkill({ id: "skill-1" })));
      mockFiles.set(managedPath("readme.txt"), "Some text");

      const skills = registry.listManagedSkills();

      expect(skills).toHaveLength(1);
    });

    it("should handle malformed JSON gracefully", () => {
      mockFiles.set(managedPath("good.json"), JSON.stringify(createMockSkill({ id: "good" })));
      mockFiles.set(managedPath("bad.json"), "not valid json");

      // The mock returns both, but parsing will fail for bad.json
      // Since our mock doesn't throw on invalid JSON, we need to adjust
      const skills = registry.listManagedSkills();

      // Should still return at least the valid one
      expect(skills.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("isInstalled", () => {
    it("should return true when skill is installed", () => {
      mockFiles.set(
        managedPath("installed-skill.json"),
        JSON.stringify(createMockSkill({ id: "installed-skill" })),
      );

      expect(registry.isInstalled("installed-skill")).toBe(true);
    });

    it("should return false when skill is not installed", () => {
      expect(registry.isInstalled("not-installed")).toBe(false);
    });
  });

  describe("getInstalledVersion", () => {
    it("should return version when skill has metadata", () => {
      const skill = createMockSkill({
        id: "versioned",
        metadata: { version: "1.2.3", author: "Test" },
      });
      mockFiles.set(managedPath("versioned.json"), JSON.stringify(skill));

      expect(registry.getInstalledVersion("versioned")).toBe("1.2.3");
    });

    it("should return null when skill has no version", () => {
      const skill = createMockSkill({ id: "no-version" });
      mockFiles.set(managedPath("no-version.json"), JSON.stringify(skill));

      expect(registry.getInstalledVersion("no-version")).toBeNull();
    });

    it("should return null when skill is not installed", () => {
      expect(registry.getInstalledVersion("not-installed")).toBeNull();
    });
  });

  describe("checkForUpdates", () => {
    it("should return hasUpdate true when versions differ", async () => {
      const skill = createMockSkill({
        id: "outdated",
        metadata: { version: "1.0.0", author: "Test" },
      });
      mockFiles.set(managedPath("outdated.json"), JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockRegistryEntry({ id: "outdated", version: "2.0.0" })),
      });

      const result = await registry.checkForUpdates("outdated");

      expect(result.hasUpdate).toBe(true);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("2.0.0");
    });

    it("should return hasUpdate false when versions match", async () => {
      const skill = createMockSkill({
        id: "current",
        metadata: { version: "1.0.0", author: "Test" },
      });
      mockFiles.set(managedPath("current.json"), JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockRegistryEntry({ id: "current", version: "1.0.0" })),
      });

      const result = await registry.checkForUpdates("current");

      expect(result.hasUpdate).toBe(false);
    });

    it("should handle skill not found in registry", async () => {
      const skill = createMockSkill({ id: "local-only" });
      mockFiles.set(managedPath("local-only.json"), JSON.stringify(skill));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await registry.checkForUpdates("local-only");

      expect(result.hasUpdate).toBe(false);
      expect(result.latestVersion).toBeNull();
    });
  });

  describe("setRegistryUrl", () => {
    it("should update the registry URL", () => {
      registry.setRegistryUrl("https://new-registry.com/api");
      expect(registry.getRegistryUrl()).toBe("https://new-registry.com/api");
    });
  });

  describe("getManagedSkillsDir", () => {
    it("should return the managed skills directory", () => {
      const dir = registry.getManagedSkillsDir();
      expect(dir).toBe("/mock/skills");
    });
  });

  describe("updateAll", () => {
    it("should update all installed skills", async () => {
      const skill1 = createMockSkill({ id: "skill-1" });
      const skill2 = createMockSkill({ id: "skill-2" });
      mockFiles.set(managedPath("skill-1.json"), JSON.stringify(skill1));
      mockFiles.set(managedPath("skill-2.json"), JSON.stringify(skill2));

      // Mock successful updates
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(skill1),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(skill2),
        });

      const result = await registry.updateAll();

      expect(result.updated).toContain("skill-1");
      expect(result.updated).toContain("skill-2");
      expect(result.failed).toHaveLength(0);
    });

    it("should track failed updates", async () => {
      const skill1 = createMockSkill({ id: "skill-1" });
      mockFiles.set(managedPath("skill-1.json"), JSON.stringify(skill1));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
      });

      const result = await registry.updateAll();

      expect(result.failed).toContain("skill-1");
      expect(result.updated).toHaveLength(0);
    });
  });
});

describe("getSkillRegistry", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it("should return singleton instance", async () => {
    const { getSkillRegistry, resetSkillRegistry: reset } = await import("../skill-registry");
    reset();

    const instance1 = getSkillRegistry({ managedSkillsDir: "/mock/skills" });
    const instance2 = getSkillRegistry();

    expect(instance1).toBe(instance2);

    reset();
  });
});

describe("Security: Skill ID Validation", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirs = new Set(["/", "/mock", "/mock/skills", "/mock/user", "/mock/user/data"]);
    mockFetch.mockReset();
    resetSkillRegistry();
    registry = new SkillRegistry({
      registryUrl: "https://test-registry.com/api",
      managedSkillsDir: "/mock/skills",
    });
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  describe("path traversal prevention", () => {
    it("should reject skill ID with path traversal (..)", async () => {
      const result = await registry.install("../../../etc/passwd");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });

    it("should reject skill ID with forward slashes", async () => {
      const result = await registry.install("foo/bar");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });

    it("should reject skill ID with backslashes", async () => {
      const result = await registry.install("foo\\bar");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });

    it("should reject skill ID with special characters", async () => {
      const result = await registry.install("skill;rm -rf /");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });

    it("should reject empty skill ID", async () => {
      const result = await registry.install("");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });

    it("should reject skill ID with only whitespace", async () => {
      const result = await registry.install("   ");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });
  });

  describe("valid skill IDs", () => {
    it("should accept lowercase alphanumeric skill ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: "valid123" })),
      });

      const result = await registry.install("valid123");
      expect(result.success).toBe(true);
    });

    it("should accept skill ID with hyphens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: "my-skill-name" })),
      });

      const result = await registry.install("my-skill-name");
      expect(result.success).toBe(true);
    });

    it("should accept skill ID with underscores", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: "my_skill_name" })),
      });

      const result = await registry.install("my_skill_name");
      expect(result.success).toBe(true);
    });

    it("should normalize uppercase to lowercase", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createMockSkill({ id: "myskill" })),
      });

      const result = await registry.install("MySkill");
      expect(result.success).toBe(true);
    });
  });

  describe("uninstall validation", () => {
    it("should reject path traversal in uninstall", () => {
      const result = registry.uninstall("../../../etc/passwd");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid skill ID");
    });
  });

  describe("getSkillDetails validation", () => {
    it("should return null for invalid skill ID", async () => {
      const result = await registry.getSkillDetails("../malicious");
      expect(result).toBeNull();
    });
  });

  describe("isInstalled validation", () => {
    it("should return false for invalid skill ID", () => {
      const result = registry.isInstalled("../malicious");
      expect(result).toBe(false);
    });
  });

  describe("checkForUpdates validation", () => {
    it("should return safe defaults for invalid skill ID", async () => {
      const result = await registry.checkForUpdates("../malicious");
      expect(result.hasUpdate).toBe(false);
      expect(result.currentVersion).toBeNull();
      expect(result.latestVersion).toBeNull();
    });
  });
});
