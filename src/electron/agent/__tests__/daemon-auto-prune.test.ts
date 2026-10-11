import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SessionRetentionService } from "../../sessions/SessionRetentionService";

// Exercise actual auto-prune wiring without a live daemon, data profile or checkout.
function autoPrune(bindings: Record<string, unknown>) {
  const file = path.resolve("src/electron/agent/daemon.ts");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const daemon = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "AgentDaemon",
  ) as ts.ClassDeclaration;
  const method = daemon.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "runSessionAutoPrune",
  ) as ts.MethodDeclaration;
  const js = ts.transpileModule(
    `async function runSessionAutoPrune(taskEventRepo) ${method.body!.getText(ast)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return vm.runInNewContext(`${js}\nrunSessionAutoPrune`, bindings);
}

describe("daemon auto-prune cleanup ordering", () => {
  it.each([false, true])(
    "cleans only a committed deletion (resumed during preparation: %s)",
    async (resume) => {
      const task = {
        id: "task",
        sessionId: "task",
        title: "Task",
        workspaceId: "workspace",
        status: "failed",
        createdAt: 1,
        updatedAt: 1,
        worktreePath: "/synthetic/worktree",
      };
      const tasks = [task];
      const repo = {
        findAll: () => tasks,
        findBySessionId: (id: string) => tasks.filter((row) => row.sessionId === id),
        findById: (id: string) => tasks.find((row) => row.id === id),
        deleteIfSessionPrunable: () => {
          if (task.status === "executing") return "active";
          tasks.splice(0);
          return "deleted";
        },
      };
      const metadata = { findBySessionIds: () => new Map(), delete: vi.fn() };
      class Retention extends SessionRetentionService {
        cleanupOrphanedQueuedAttachments() {
          return 0;
        }
      }
      const snapshot = {
        taskId: task.id,
        repoPath: "/synthetic/repo",
        worktreePath: task.worktreePath,
      };
      const cleanupDeletedWorktree = vi.fn(async () => {
        expect(repo.findById(task.id)).toBeUndefined();
      });
      const purgeTaskFiles = vi.fn(async () => undefined);
      const run = autoPrune({
        loadSessionRetentionSettings: () => ({ autoPrune: { enabled: true, olderThan: "90d" } }),
        saveSessionRetentionSettings: vi.fn(),
        parseSessionRetentionDurationMs: () => 90 * 24 * 60 * 60 * 1000,
        TaskStore: function () {
          return repo;
        },
        TaskSessionMetadataStore: function () {
          return metadata;
        },
        WorkspaceStore: function () {
          return { findAll: () => [] };
        },
        SessionRetentionService: Retention,
        MemoryWorkspacePurgeService: { purgeTaskFiles },
        log: { warn: vi.fn(), info: vi.fn() },
      });
      await run.call(
        {
          dbManager: { getDatabase: () => ({}) },
          workspaceRepo: { findById: () => ({ path: "/synthetic/repo" }) },
          worktreeManager: {
            getWorktreeInfo: async () => {
              // A continuation can run while metadata is being captured.
              await Promise.resolve();
              if (resume) task.status = "executing";
              return snapshot;
            },
            cleanupDeletedWorktree,
            cleanup: () => {
              throw new Error("cleanup must not precede deletion");
            },
          },
        },
        { findByTaskIds: () => [], findByTaskId: () => [] },
      );
      expect(cleanupDeletedWorktree).toHaveBeenCalledTimes(resume ? 0 : 1);
      expect(purgeTaskFiles).toHaveBeenCalledTimes(resume ? 0 : 1);
      expect(tasks.length).toBe(resume ? 1 : 0);
    },
  );
});
