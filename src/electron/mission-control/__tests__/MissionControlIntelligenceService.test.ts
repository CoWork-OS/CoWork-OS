import { describe, expect, it } from "vitest";

import type { HeartbeatEvent } from "../../../shared/types";
import { MissionControlIntelligenceService } from "../MissionControlIntelligenceService";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

function createFakeDb() {
  const items: Any[] = [];
  const evidence: Any[] = [];
  return {
    prepare(sql: string) {
      return {
        get(...params: Any[]) {
          if (sql.includes("SELECT id FROM mission_control_items WHERE fingerprint")) {
            return items.find((item) => item.fingerprint === params[0]);
          }
          if (sql.includes("WHERE i.fingerprint = ?")) {
            const item = items.find((entry) => entry.fingerprint === params[0]);
            return item
              ? { ...item, evidence_count: evidence.filter((entry) => entry.item_id === item.id).length }
              : undefined;
          }
          return undefined;
        },
        all(...params: Any[]) {
          if (sql.includes("FROM mission_control_items i")) {
            const categories = sql.includes("i.category IN") ? params.slice(0, -1) : [];
            return items
              .filter((item) => categories.length === 0 || categories.includes(item.category))
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
          if (sql.includes("DELETE FROM mission_control_item_evidence")) {
            const itemId = params[0];
            for (let index = evidence.length - 1; index >= 0; index -= 1) {
              if (evidence[index].item_id === itemId) evidence.splice(index, 1);
            }
          }
          if (sql.includes("INSERT INTO mission_control_item_evidence")) {
            const [id, item_id, source_type, source_id, title, summary, payload_json, timestamp] = params;
            evidence.push({ id, item_id, source_type, source_id, title, summary, payload_json, timestamp });
          }
        },
      };
    },
    transaction(fn: () => void) {
      return fn;
    },
  };
}

function makeService() {
  return new MissionControlIntelligenceService(createFakeDb() as Any);
}

describe("MissionControlIntelligenceService", () => {
  it("groups repeated heartbeat awareness signals into one awareness item", () => {
    const service = makeService();
    const event: HeartbeatEvent = {
      type: "signal_merged",
      agentRoleId: "agent-1",
      agentName: "Project Manager",
      timestamp: 1000,
      signal: {
        id: "signal-1",
        agentRoleId: "agent-1",
        agentScope: "agent",
        workspaceScope: "all",
        signalFamily: "awareness_signal",
        source: "hook",
        fingerprint: "app:codex",
        urgency: "low",
        confidence: 0.7,
        expiresAt: 9999,
        mergedCount: 14,
        firstSeenAt: 1,
        lastSeenAt: 1000,
        reason: "Awareness detected apps: Codex — Codex",
      },
    };

    service.recordHeartbeatEvent(event);
    service.recordHeartbeatEvent({ ...event, timestamp: 1200 });

    const items = service.listItems({ categories: ["awareness"] });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toContain("14 signals");
    expect(items[0].title).toBe("Awareness noticed background activity");
  });

  it("records review decisions from no-work heartbeat events", () => {
    const service = makeService();

    service.recordHeartbeatEvent({
      type: "no_work",
      agentRoleId: "agent-1",
      agentName: "Project Manager",
      runId: "run-1",
      timestamp: 1000,
      result: {
        pendingMentions: 7,
        assignedTasks: 0,
        triggerReason: "No follow-up scheduled.",
      } as Any,
    });

    const items = service.listItems({ categories: ["reviews"] });
    expect(items).toHaveLength(1);
    expect(items[0].summary).toContain("7 mentions");
    expect(items[0].decision).toBe("No action needed.");
    expect(service.getEvidence(items[0].id)[0].sourceType).toBe("heartbeat_event");
  });
});
