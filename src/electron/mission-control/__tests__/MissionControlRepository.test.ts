import { describe, expect, it } from "vitest";
import { MissionControlRepository } from "../MissionControlRepository";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

function createRepo(): MissionControlRepository {
  const items: Any[] = [];
  const evidence: Any[] = [];
  const db = {
    prepare(sql: string) {
      return {
        get(...params: Any[]) {
          if (sql.includes("SELECT id FROM mission_control_items WHERE fingerprint")) {
            return items.find((item) => item.fingerprint === params[0]);
          }
          if (sql.includes("WHERE i.fingerprint = ?")) {
            const item = items.find((entry) => entry.fingerprint === params[0]);
            return item
              ? {
                  ...item,
                  evidence_count: evidence.filter((entry) => entry.item_id === item.id).length,
                }
              : undefined;
          }
          return undefined;
        },
        all(...params: Any[]) {
          if (
            sql.includes("SELECT id FROM mission_control_items WHERE fingerprint LIKE 'task:%'")
          ) {
            const workspaceId = sql.includes("workspace_id = ?") ? params[0] : undefined;
            const activeTaskIds = sql.includes("task_id NOT IN")
              ? params.slice(workspaceId ? 1 : 0)
              : [];
            return items
              .filter((item) => item.fingerprint.startsWith("task:"))
              .filter((item) => !workspaceId || item.workspace_id === workspaceId)
              .filter((item) => activeTaskIds.length === 0 || !activeTaskIds.includes(item.task_id))
              .map((item) => ({ id: item.id }));
          }
          if (sql.includes("FROM mission_control_items i")) {
            return items
              .sort((a, b) => b.timestamp - a.timestamp)
              .map((item) => ({
                ...item,
                evidence_count: evidence.filter((entry) => entry.item_id === item.id).length,
              }));
          }
          if (sql.includes("FROM mission_control_item_evidence")) {
            return evidence.filter((entry) => entry.item_id === params[0]);
          }
          return [];
        },
        run(...params: Any[]) {
          if (sql.includes("INSERT INTO mission_control_items")) {
            const [
              id,
              fingerprint,
              category,
              severity,
              title,
              summary,
              decision,
              next_step,
              agent_role_id,
              agent_name,
              workspace_id,
              workspace_name,
              company_id,
              company_name,
              task_id,
              issue_id,
              run_id,
              timestamp,
              updated_at,
            ] = params;
            const existing = items.find((item) => item.fingerprint === fingerprint);
            const next = {
              id: existing?.id || id,
              fingerprint,
              category,
              severity,
              title,
              summary,
              decision,
              next_step,
              agent_role_id,
              agent_name,
              workspace_id,
              workspace_name,
              company_id,
              company_name,
              task_id,
              issue_id,
              run_id,
              timestamp,
              updated_at,
            };
            if (existing) Object.assign(existing, next);
            else items.push(next);
          }
          if (sql.includes("INSERT INTO mission_control_item_evidence")) {
            const [id, item_id, source_type, source_id, title, summary, payload_json, timestamp] =
              params;
            evidence.push({
              id,
              item_id,
              source_type,
              source_id,
              title,
              summary,
              payload_json,
              timestamp,
            });
          }
          if (sql.includes("DELETE FROM mission_control_item_evidence")) {
            const itemId = params[0];
            for (let index = evidence.length - 1; index >= 0; index -= 1) {
              if (evidence[index].item_id === itemId) evidence.splice(index, 1);
            }
          }
          if (sql.includes("DELETE FROM mission_control_items")) {
            const itemId = params[0];
            for (let index = items.length - 1; index >= 0; index -= 1) {
              if (items[index].id === itemId) items.splice(index, 1);
            }
          }
        },
      };
    },
    transaction(fn: () => void) {
      return fn;
    },
  };
  return new MissionControlRepository(db as Any);
}

describe("MissionControlRepository", () => {
  it("removes stale task items and their evidence outside the active task set", () => {
    const repo = createRepo();
    const active = repo.upsertItem({
      fingerprint: "task:active",
      category: "work",
      severity: "monitor_only",
      title: "Active",
      summary: "Active task",
      workspaceId: "workspace-1",
      taskId: "active",
      timestamp: 100,
    });
    const stale = repo.upsertItem({
      fingerprint: "task:done",
      category: "work",
      severity: "monitor_only",
      title: "Done",
      summary: "Done task",
      workspaceId: "workspace-1",
      taskId: "done",
      timestamp: 90,
    });
    repo.replaceEvidence(stale.id, [
      { sourceType: "task", sourceId: "done", title: "Done", timestamp: 90 },
    ]);

    repo.deleteTaskItemsNotIn({ taskIds: ["active"], workspaceId: "workspace-1" });

    expect(repo.listItems({ workspaceId: "workspace-1" }).map((item) => item.id)).toEqual([
      active.id,
    ]);
    expect(repo.listEvidence(stale.id)).toEqual([]);
  });
});
