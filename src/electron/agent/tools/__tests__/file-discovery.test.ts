import { workerPath } from "./file-discovery-test-worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Workspace } from "../../../../shared/types";
import { discoverGlob } from "../glob-discovery";
import { FileDiscoveryService } from "../file-discovery-client";
import { GrepTools } from "../grep-tools";
import { GlobTools } from "../glob-tools";
import { readFilesByPatterns } from "../read-files";
import { runWithMemoryRepoAccess, setMemoryRepoRoot } from "../../../security/memory-repo-access";
import {
  registerSkillPackRoot,
  resolveSkillPackReadGrant,
  runWithSkillPackReadAccess,
  unregisterSkillPackRoot,
} from "../../../security/skill-pack-read-access";

describe("file discovery", () => {
  let root: string;
  let workspace: Workspace;
  const write = (file: string, content = "needle") => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-discovery-"));
    workspace = {
      id: "discovery",
      name: "test",
      path: root,
      createdAt: 0,
      permissions: { read: true, write: false, delete: false, network: false, shell: false },
    };
    write("src/a.ts");
    write("src/b.ts");
    write("src/deep/c.ts");
    write("docs/a.md");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setMemoryRepoRoot(null);
    unregisterSkillPackRoot("discovery-test");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("walks overlapping include/exclude patterns once, preserving per-pattern results", () => {
    const batch = discoverGlob(workspace, {
      patterns: ["**/*.ts", "src/**/*.ts", "src/b.ts", "**/*.md"],
    });
    const single = discoverGlob(workspace, { patterns: ["**/*"] });
    expect(batch.stats.directoriesRead).toBe(single.stats.directoriesRead);
    expect(batch.stats.filesVisited).toBe(single.stats.filesVisited);
    expect(batch.results.map((result) => result.matches.length)).toEqual([3, 3, 1, 1]);
  });

  it("scopes fixed directory prefixes and reuses directory listings across literal paths", () => {
    for (let i = 0; i < 30; i++) {
      write(`unrelated/branch-${i}/file.ts`);
      write(`src/unrelated-${i}/file.ts`);
    }
    const result = discoverGlob(workspace, { patterns: ["SRC/a.ts", "src/b.ts", "src/deep/c.ts"] });
    expect(result.results.map((result) => result.matches.length)).toEqual([1, 1, 1]);
    // root, src, src/deep; unrelated directories were never enumerated.
    expect(result.stats.directoriesRead).toBe(3);
  });

  it("retains all case-insensitive prefix matches on case-sensitive filesystems", () => {
    write("SRC/upper.ts");
    const actualDirectory = fs.readdirSync(root).includes("SRC") ? "SRC" : "src";
    const result = discoverGlob(workspace, { patterns: ["src/*.ts"] }).results[0];
    expect(result.matches.map((file) => file.path).sort()).toEqual(
      ["src/a.ts", "src/b.ts", `${actualDirectory}/upper.ts`].sort(),
    );
  });

  it("normalizes leading ./ without widening root-qualified matches", () => {
    write("config.json");
    write("src/config.json");
    const results = discoverGlob(workspace, { patterns: ["./config.json", "config.json"] }).results;
    expect(results[0].matches.map((file) => file.path)).toEqual(["config.json"]);
    expect(results[1].matches).toHaveLength(2);
    expect(discoverGlob(workspace, { patterns: ["./config.json"] }).stats.directoriesRead).toBe(1);
  });

  it("retains newest-first ordering and each pattern's truncation warning", () => {
    fs.utimesSync(path.join(root, "src/a.ts"), 100, 100);
    fs.utimesSync(path.join(root, "src/b.ts"), 200, 200);
    const results = discoverGlob(workspace, {
      patterns: ["src/*.ts", "docs/*.md"],
      maxResults: 1,
    }).results;
    expect(results[0]).toMatchObject({
      totalMatches: 2,
      truncated: true,
      matches: [{ path: "src/b.ts" }],
    });
    expect(results[1]).toMatchObject({ totalMatches: 1, truncated: false });
  });

  it("reports bounded scans as partial rather than claiming absent files", () => {
    for (let i = 0; i < 510; i++) write(`many/${i}.txt`);
    const result = discoverGlob(workspace, { patterns: ["many/*.txt"], maxResults: 1 }).results[0];
    expect(result).toMatchObject({ scanTruncated: true, truncated: true, totalMatches: 500 });
    expect(result.truncationReason).toContain("lower bound");
  });

  it("contains invalid/expanding patterns without losing valid patterns", () => {
    const results = discoverGlob(workspace, { patterns: ["{a,b}".repeat(20), "src/a.ts"] }).results;
    expect(results[0]).toMatchObject({
      success: false,
      error: expect.stringContaining("expansion limit"),
    });
    expect(results[1].matches).toHaveLength(1);
  });

  it("keeps deny rules and symlink escapes out of worker results", async () => {
    write("private/secret.ts");
    workspace.permissions.accessFilesystemRules = [
      { path: path.join(root, "private"), access: "deny" },
    ];
    if (process.platform !== "win32")
      fs.symlinkSync(path.join(root, "private"), path.join(root, "linked"));
    const service = new FileDiscoveryService({ workerPath });
    const results = await service.discoverGlob(workspace, {
      patterns: ["**/*.ts", "linked/secret.ts"],
    });
    expect(results[0].matches.map((file) => file.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/deep/c.ts",
    ]);
    expect(results[1].matches).toEqual([]);
  });

  it("keeps host timers and synchronous directory APIs free during real worker traversal", async () => {
    for (let i = 0; i < 1000; i++) write(`large/dir-${i}/file.ts`);
    const service = new FileDiscoveryService({ workerPath });
    const directoryRead = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("host traversal");
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const results = await service.discoverGlob(workspace, { patterns: ["**/*.ts"] });
      expect(results[0].matches).toHaveLength(100);
      expect(directoryRead).not.toHaveBeenCalled();
      expect(ticks).toBeGreaterThan(1);
    } finally {
      clearInterval(timer);
    }
  });

  it("performs grep candidate discovery without synchronous host directory walking", async () => {
    const directoryRead = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("host traversal");
    });
    const result = await new GrepTools(workspace, { logEvent() {} } as Any, "test").grep({
      pattern: "needle",
      glob: "**/*.ts",
    });
    expect(result.success, result.error).toBe(true);
    expect(result.matches).toHaveLength(3);
    expect(directoryRead).not.toHaveBeenCalled();
  });

  it("batches read_files includes and excludes in a single discovery request", async () => {
    const globTools = new GlobTools(workspace, { logEvent() {} } as Any, "test");
    const batched = vi.spyOn(globTools, "globMany");
    const unbatched = vi.spyOn(globTools, "glob");
    const fileTools = {
      async readFile(file: string) {
        return { content: await fs.promises.readFile(path.join(root, file), "utf8"), size: 6 };
      },
    } as Any;
    const result = await readFilesByPatterns(
      { patterns: ["src/**/*.ts", "docs/*.md", "!src/b.ts"] },
      { globTools, fileTools },
    );
    expect(result.files.map((file) => file.path)).toEqual([
      "docs/a.md",
      "src/a.ts",
      "src/deep/c.ts",
    ]);
    expect(batched).toHaveBeenCalledTimes(1);
    expect(unbatched).not.toHaveBeenCalled();
  });

  it("does not reuse stale files or share task-local memory authority", async () => {
    const service = new FileDiscoveryService({ workerPath });
    setMemoryRepoRoot(path.join(root, "memory"));
    write("memory/MEMORY.md");
    const [allowed, denied] = await Promise.all([
      runWithMemoryRepoAccess({ readAllowed: true }, () =>
        service.discoverGlob(workspace, { patterns: ["**/*.md"] }),
      ),
      runWithMemoryRepoAccess({ readAllowed: false }, () =>
        service.discoverGlob(workspace, { patterns: ["**/*.md"] }),
      ),
    ]);
    expect(allowed[0].matches.map((file) => file.path)).toContain("memory/MEMORY.md");
    expect(denied[0].matches.map((file) => file.path)).not.toContain("memory/MEMORY.md");
    write("docs/new.md");
    fs.unlinkSync(path.join(root, "docs/a.md"));
    const fresh = await service.discoverGlob(workspace, { patterns: ["docs/*.md"] });
    expect(fresh[0].matches.map((file) => file.path)).toEqual(["docs/new.md"]);
  });

  it("rejects results if an applied pack grant is revoked while a scan runs", async () => {
    const pack = path.join(root, "pack");
    write("pack/SKILL.md");
    expect(registerSkillPackRoot("discovery-test", pack, [path.join(pack, "SKILL.md")])).toBe(true);
    const grant = resolveSkillPackReadGrant({
      source: "managed",
      filePath: path.join(pack, "SKILL.md"),
      metadata: { pluginSource: "discovery-test" },
    } as Any)!;
    const service = new FileDiscoveryService({
      createWorker: () =>
        new Worker(
          `setTimeout(() => require('node:worker_threads').parentPort.postMessage({result: []}), 50)`,
          { eval: true },
        ),
    });
    await runWithSkillPackReadAccess([grant], async () => {
      const pending = service.discoverGlob(workspace, { patterns: ["**/*"] });
      unregisterSkillPackRoot("discovery-test");
      await expect(pending).rejects.toThrow("policy changed");
    });
  });

  it("coalesces identical in-flight scans and bounds concurrent/queued work", async () => {
    let created = 0;
    let active = 0;
    let maximumActive = 0;
    const service = new FileDiscoveryService({
      concurrency: 1,
      maxQueue: 1,
      createWorker: () => {
        created++;
        maximumActive = Math.max(maximumActive, ++active);
        const worker = new Worker(
          `setTimeout(() => require('node:worker_threads').parentPort.postMessage({result: []}), 30)`,
          { eval: true },
        );
        worker.once("exit", () => active--);
        return worker;
      },
    });
    const first = service.discoverGlob(workspace, { patterns: ["first"] });
    const duplicate = service.discoverGlob(workspace, { patterns: ["first"] });
    const queued = service.discoverGlob(workspace, { patterns: ["second"] });
    await expect(service.discoverGlob(workspace, { patterns: ["third"] })).rejects.toThrow("busy");
    await Promise.all([first, duplicate, queued]);
    expect(created).toBe(2);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
  });

  it.each([
    "throw new Error('worker failed')",
    "process.exit(0)",
    "require('node:worker_threads').parentPort.postMessage({wrong: true})",
    "require('node:worker_threads').parentPort.postMessage({result: 1})",
    "while (true) {}",
  ])("fails closed and releases worker slots after %s", async (source) => {
    let created = 0;
    const service = new FileDiscoveryService({
      timeoutMs: process.env.CI ? 2000 : 500,
      concurrency: 1,
      createWorker: (request) =>
        ++created === 1
          ? new Worker(source, { eval: true })
          : new Worker(workerPath, { workerData: request, execArgv: [] }),
    });
    await expect(service.discoverGlob(workspace, { patterns: ["src/a.ts"] })).rejects.toThrow();
    const control = await service.discoverGlob(workspace, { patterns: ["src/a.ts"] });
    expect(control[0].matches.map((file) => file.path)).toEqual(["src/a.ts"]);
  });
});
