import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CuratedMemoryService } from "../CuratedMemoryService";

const createdDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-curated-memory-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  (CuratedMemoryService as Any).initialized = false;
});

describe("CuratedMemoryService", () => {
  it("adds curated user memory and syncs USER.md", async () => {
    const workspacePath = await createWorkspace();
    const entries: Any[] = [];

    const curatedRepo = {
      findByNormalizedKey: () => undefined,
      create(input: Any) {
        const entry = {
          ...input,
          id: "curated-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        entries.push(entry);
        return entry;
      },
      update: () => undefined,
      findFirstMatching: () => undefined,
      archive: () => undefined,
      list(params: Any) {
        return entries.filter(
          (entry) =>
            entry.workspaceId === params.workspaceId &&
            (!params.target || entry.target === params.target) &&
            (!params.status || entry.status === params.status),
        );
      },
    };

    (CuratedMemoryService as Any).curatedRepo = curatedRepo;
    (CuratedMemoryService as Any).workspaceRepo = {
      findById: () => ({ id: "ws1", path: workspacePath }),
    };
    (CuratedMemoryService as Any).initialized = true;

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      taskId: "task-1",
      action: "add",
      target: "user",
      kind: "preference",
      content: "Prefers concise answers",
    });

    expect(result.success).toBe(true);
    const userMd = await fs.readFile(path.join(workspacePath, ".cowork", "USER.md"), "utf8");
    expect(userMd).toContain("Auto Curated Memory");
    expect(userMd).toContain("Prefers concise answers");
  });

  it("uses id-based replace and truncates oversized content", async () => {
    const workspacePath = await createWorkspace();
    const entries: Any[] = [
      {
        id: "curated-1",
        workspaceId: "ws1",
        taskId: "task-1",
        target: "workspace",
        kind: "project_fact",
        content: "Original fact",
        normalizedKey: "original fact",
        source: "agent_tool",
        confidence: 0.85,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const curatedRepo = {
      findByNormalizedKey: () => undefined,
      create(input: Any) {
        const entry = {
          ...input,
          id: "curated-2",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        entries.push(entry);
        return entry;
      },
      update(id: string, patch: Any) {
        const entry = entries.find((item) => item.id === id);
        if (!entry) return undefined;
        Object.assign(entry, patch, { updatedAt: Date.now() });
        return entry;
      },
      findById(id: string) {
        return entries.find((item) => item.id === id);
      },
      findFirstMatching: () => undefined,
      archive: () => undefined,
      list(params: Any) {
        return entries.filter(
          (entry) =>
            entry.workspaceId === params.workspaceId &&
            (!params.target || entry.target === params.target) &&
            (!params.status || entry.status === params.status),
        );
      },
    };

    (CuratedMemoryService as Any).curatedRepo = curatedRepo;
    (CuratedMemoryService as Any).workspaceRepo = {
      findById: () => ({ id: "ws1", path: workspacePath }),
    };
    (CuratedMemoryService as Any).initialized = true;

    const oversized = "x".repeat(500);
    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      taskId: "task-1",
      action: "replace",
      id: "curated-1",
      target: "workspace",
      kind: "project_fact",
      content: oversized,
    });

    expect(result.success).toBe(true);
    expect(entries[0].content.length).toBeLessThanOrEqual(320);
  });

  it("treats match strings literally and avoids wildcard-style matches", async () => {
    const workspacePath = await createWorkspace();
    const entries: Any[] = [
      {
        id: "curated-1",
        workspaceId: "ws1",
        target: "workspace",
        kind: "project_fact",
        content: "Alpha_1 rollout plan",
        normalizedKey: "alpha_1 rollout plan",
        source: "agent_tool",
        confidence: 0.85,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "curated-2",
        workspaceId: "ws1",
        target: "workspace",
        kind: "project_fact",
        content: "AlphaX1 rollout plan",
        normalizedKey: "alphax1 rollout plan",
        source: "agent_tool",
        confidence: 0.85,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now() - 1,
      },
    ];

    (CuratedMemoryService as Any).curatedRepo = {
      findByNormalizedKey: () => undefined,
      create: () => undefined,
      update: () => undefined,
      findById: () => undefined,
      archive(id: string) {
        const entry = entries.find((item) => item.id === id);
        if (!entry) return undefined;
        entry.status = "archived";
        entry.updatedAt = Date.now();
        return entry;
      },
      list(params: Any) {
        return entries.filter(
          (entry) =>
            entry.workspaceId === params.workspaceId &&
            (!params.target || entry.target === params.target) &&
            (!params.kind || entry.kind === params.kind) &&
            (!params.status || entry.status === params.status),
        );
      },
    };
    (CuratedMemoryService as Any).workspaceRepo = {
      findById: () => ({ id: "ws1", path: workspacePath }),
    };
    (CuratedMemoryService as Any).initialized = true;

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "remove",
      target: "workspace",
      match: "Alpha_1",
    });

    expect(result.success).toBe(true);
    expect(entries[0].status).toBe("archived");
    expect(entries[1].status).toBe("active");
  });

  it("fails when a non-id substring match is ambiguous", async () => {
    const workspacePath = await createWorkspace();
    const entries: Any[] = [
      {
        id: "curated-1",
        workspaceId: "ws1",
        target: "workspace",
        kind: "project_fact",
        content: "Deploy billing service first",
        normalizedKey: "deploy billing service first",
        source: "agent_tool",
        confidence: 0.85,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "curated-2",
        workspaceId: "ws1",
        target: "workspace",
        kind: "workflow_rule",
        content: "Deploy worker after migration",
        normalizedKey: "deploy worker after migration",
        source: "agent_tool",
        confidence: 0.85,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now() - 1,
      },
    ];

    (CuratedMemoryService as Any).curatedRepo = {
      findByNormalizedKey: () => undefined,
      create: () => undefined,
      update: () => undefined,
      findById: () => undefined,
      archive: () => undefined,
      list(params: Any) {
        return entries.filter(
          (entry) =>
            entry.workspaceId === params.workspaceId &&
            (!params.target || entry.target === params.target) &&
            (!params.kind || entry.kind === params.kind) &&
            (!params.status || entry.status === params.status),
        );
      },
    };
    (CuratedMemoryService as Any).workspaceRepo = {
      findById: () => ({ id: "ws1", path: workspacePath }),
    };
    (CuratedMemoryService as Any).initialized = true;

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "remove",
      target: "workspace",
      match: "deploy",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple curated memories matched/i);
  });
});
