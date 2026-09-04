import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import { WorkSessionProtocolRepository } from "../database/WorkSessionProtocolRepository";
import {
  evaluateIsolatedReplay,
  type WorkSessionReplayAssertions,
} from "../sessions/WorkSessionReplayEvaluationService";
import { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";

type Scope = "admin" | "read" | "write" | "operator";
type RequireScope = (client: unknown, scope: Scope) => void;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function id(value: unknown, label: string, max = 256): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) {
    throw { code: ErrorCodes.INVALID_PARAMS, message: `${label} is invalid` };
  }
  return normalized;
}

function optionalId(value: unknown, label: string, max = 256): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return id(value, label, max);
}

function boundedLimit(value: unknown, fallback = 1_000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw { code: ErrorCodes.INVALID_PARAMS, message: "limit must be a finite number" };
  }
  return Math.min(10_000, Math.max(1, Math.floor(value)));
}

function replayAssertions(value: unknown): WorkSessionReplayAssertions | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const expected = input.expectedTerminalStatus;
  if (expected !== undefined && typeof expected !== "string") {
    throw { code: ErrorCodes.INVALID_PARAMS, message: "expectedTerminalStatus must be a string" };
  }
  const list = (key: string): string[] | undefined => {
    if (input[key] === undefined) return undefined;
    if (!Array.isArray(input[key])) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `${key} must be an array` };
    }
    const values = input[key] as unknown[];
    if (values.length > 4_096 || values.some((entry) => typeof entry !== "string")) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `${key} contains invalid values` };
    }
    return (values as string[]).map((entry) => entry.trim().slice(0, 512)).filter(Boolean);
  };
  return {
    ...(typeof expected === "string" ? { expectedTerminalStatus: expected.slice(0, 64) } : {}),
    ...(list("mustContainAll") ? { mustContainAll: list("mustContainAll") } : {}),
    ...(list("mustCreatePaths") ? { mustCreatePaths: list("mustCreatePaths") } : {}),
  };
}

/** Register operator-visible reliability controls on both desktop and daemon servers. */
export function registerWorkSessionMethods(input: {
  server: ControlPlaneServer;
  db: Database.Database;
  agentDaemon: AgentDaemon;
  requireScope: RequireScope;
}): void {
  const { server, db, agentDaemon, requireScope } = input;
  const reliability = agentDaemon.getWorkSessionReliabilityService();
  const protocol = new WorkSessionProtocolRepository(db);

  server.registerMethod(Methods.WORK_SESSION_ROLLOUT_GET, async (client) => {
    requireScope(client, "read");
    return { config: reliability.rollout.getConfig() };
  });

  server.registerMethod(Methods.WORK_SESSION_ROLLOUT_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const value = record(params);
    const update: {
      enabled?: boolean;
      cohortPercent?: number;
      salt?: string;
      legacyReadRollback?: boolean;
    } = {};
    for (const key of ["enabled", "legacyReadRollback"] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== "boolean") {
          throw { code: ErrorCodes.INVALID_PARAMS, message: `${key} must be boolean` };
        }
        update[key] = value[key];
      }
    }
    if (value.cohortPercent !== undefined) {
      if (typeof value.cohortPercent !== "number" || !Number.isFinite(value.cohortPercent)) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: "cohortPercent must be finite" };
      }
      update.cohortPercent = Math.min(100, Math.max(0, Math.round(value.cohortPercent)));
    }
    if (value.salt !== undefined) update.salt = id(value.salt, "salt", 128);
    return { config: reliability.rollout.updateConfig(update) };
  });

  server.registerMethod(Methods.WORK_SESSION_METRICS_LIST, async (client, params) => {
    requireScope(client, "read");
    const value = record(params);
    const since =
      value.since === undefined
        ? undefined
        : typeof value.since === "number" && Number.isFinite(value.since)
          ? Math.floor(value.since)
          : (() => {
              throw { code: ErrorCodes.INVALID_PARAMS, message: "since must be finite" };
            })();
    return {
      metrics: reliability.metrics.list({
        sessionId: optionalId(value.sessionId, "sessionId"),
        workspaceId: optionalId(value.workspaceId, "workspaceId"),
        name: optionalId(value.name, "name", 128),
        limit: boundedLimit(value.limit),
        since,
      }),
    };
  });

  server.registerMethod(Methods.WORK_SESSION_LEASES_LIST, async (client, params) => {
    requireScope(client, "read");
    const sessionId = optionalId(record(params).sessionId, "sessionId");
    return { leases: reliability.leases.listActive(sessionId) };
  });

  server.registerMethod(Methods.WORK_SESSION_PROJECTION_GET, async (client, params) => {
    requireScope(client, "read");
    const value = record(params);
    const sessionId = id(value.sessionId, "sessionId");
    const projection = optionalId(value.projection, "projection", 128) || "work-session-vnext";
    return { cursor: reliability.projections.getCursor(sessionId, projection) || null };
  });

  server.registerMethod(Methods.WORK_SESSION_REPLAY_EVALUATE, async (client, params) => {
    requireScope(client, "read");
    const value = record(params);
    const taskId = id(value.taskId, "taskId");
    const sessionId =
      protocol.findSessionIdForTask(taskId) ||
      (
        db.prepare("SELECT id FROM work_sessions WHERE task_id = ? LIMIT 1").get(taskId) as
          | { id?: string }
          | undefined
      )?.id;
    const items = sessionId ? protocol.listAllItems(sessionId) : [];
    return {
      taskId,
      sessionId: sessionId || null,
      result: evaluateIsolatedReplay(items, {
        fixtureId: `operator:${taskId}`,
        assertions: replayAssertions(value.assertions),
      }),
    };
  });
}
