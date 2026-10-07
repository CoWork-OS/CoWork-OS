import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  botWorkResultRequestSchema,
  type BotWorkResultManifest,
} from "../../shared/bot-work-result";
import { botWorkOwnedScope } from "./bot-work-store";
import { z } from "zod";
const requirement = z.object({
  id: z.string().max(256),
  kind: z.enum(["objective", "output", "verification", "criterion"]),
  description: z.string().max(16000),
  required: z.boolean(),
  status: z.enum(["pending", "satisfied", "failed", "waived"]),
  verifier: z.string().max(256).optional(),
  targetPath: z.string().max(4096).optional(),
  evidenceIds: z.array(z.string().max(256)).max(1000).optional(),
});
function parse(raw: unknown): unknown {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
/** Read only, bounded and scope checked. No session ensure or evidence repair writes. */
export class BotWorkResultStore {
  constructor(private db: Database.Database) {}
  manifest(raw: unknown): BotWorkResultManifest {
    return this.db.transaction(() => this.readManifest(raw)).deferred();
  }
  private readManifest(raw: unknown): BotWorkResultManifest {
    const request = botWorkResultRequestSchema.parse(raw);
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id=?").get(request.workspaceId))
      throw new Error("Workspace not found");
    if (!this.db.prepare("SELECT id FROM agent_roles WHERE id=?").get(request.agentRoleId))
      throw new Error("Bot not found");
    const scope = botWorkOwnedScope(request);
    const row = this.db
      .prepare(`${scope.sql} SELECT t.id,SUBSTR(t.title,1,240) title,t.status,t.source,SUBSTR(t.agent_config,1,262145) config,t.verification_verdict,
   w.id workspace_id,w.name workspace_name,w.path workspace_path,SUBSTR(w.permissions,1,65537) permissions,
   COALESCE((SELECT b.session_id FROM work_session_task_bindings b WHERE b.task_id=t.id),(SELECT s.id FROM work_sessions s WHERE s.task_id=t.id AND s.workspace_id=t.workspace_id)) session_id
   FROM tasks t JOIN owned o ON o.id=t.id JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`)
      .get(...scope.args, request.taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Result is outside this bot's visible workspace lineage");
    const issues: string[] = [];
    const config = parse(row.config),
      permissions = parse(row.permissions);
    const object = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value);
    const policyValid =
      (row.config == null || (object(config) && String(row.config).length <= 262144)) &&
      object(permissions) &&
      ["read", "write", "delete", "network", "shell"].every(
        (key) => typeof permissions[key] === "boolean",
      ) &&
      String(row.permissions).length <= 65536;
    if (!policyValid) issues.push("Current file policy is unavailable or invalid.");
    const session =
      typeof row.session_id === "string"
        ? (this.db
            .prepare("SELECT id,task_id FROM work_sessions WHERE id=? AND workspace_id=?")
            .get(row.session_id, request.workspaceId) as
            | { id: string; task_id: string | null }
            | undefined)
        : undefined;
    let contract: BotWorkResultManifest["contract"] = null;
    let truncated = false;
    if (session) {
      // Legacy contracts without a task ID are usable only for the session's exact root.
      const c = this.db
        .prepare(
          "SELECT id,version,SUBSTR(objective,1,1024) objective,status,SUBSTR(requirements_json,1,1048577) requirements FROM work_session_outcome_contracts WHERE session_id=? AND (task_id=? OR (task_id IS NULL AND ?=1)) ORDER BY version DESC LIMIT 1",
        )
        .get(session.id, request.taskId, session.task_id === request.taskId ? 1 : 0) as
        | Record<string, unknown>
        | undefined;
      if (c) {
        const decoded = z.array(requirement).max(100).safeParse(parse(c.requirements));
        if (decoded.success && String(c.requirements).length <= 1048576) {
          contract = {
            id: String(c.id),
            version: Number(c.version),
            objective: String(c.objective),
            status: ["pending", "satisfied", "partial", "unmet", "waived"].includes(
              String(c.status),
            )
              ? (c.status as NonNullable<BotWorkResultManifest["contract"]>["status"])
              : "pending",
            requirements: decoded.data.map((item) => ({
              ...item,
              description: item.description.slice(0, 512),
            })),
          };
        } else issues.push("Stored requirements are unavailable or invalid.");
      }
    }
    const artifacts = session
      ? (this.db
          .prepare(
            `SELECT * FROM (SELECT id,artifact_id,path,revision,sha256,size,status,ROW_NUMBER() OVER(PARTITION BY path ORDER BY revision DESC,created_at DESC,id DESC) rank FROM work_session_artifact_revisions WHERE session_id=? AND task_id=?) WHERE rank=1 ORDER BY path LIMIT 25`,
          )
          .all(session.id, request.taskId) as Array<Record<string, unknown>>)
      : [];
    if (artifacts.length > 24) truncated = true;
    const selected = artifacts
      .slice(0, 24)
      .filter(
        (a) =>
          typeof a.path === "string" &&
          a.path.length <= 4096 &&
          typeof a.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(a.sha256) &&
          Number.isSafeInteger(a.revision) &&
          Number(a.revision) > 0 &&
          Number.isSafeInteger(a.size) &&
          Number(a.size) >= 0,
      );
    if (selected.length !== Math.min(artifacts.length, 24))
      issues.push("Some artifact revisions have invalid metadata.");
    const evidence =
      contract && session
        ? (this.db
            .prepare(
              `SELECT id,SUBSTR(claim,1,512) claim,source_type,captured_at,freshness_expires_at,status,artifact_revision_id FROM work_session_evidence WHERE session_id=? AND contract_id=? AND (artifact_revision_id IS NULL OR artifact_revision_id IN (SELECT id FROM work_session_artifact_revisions WHERE session_id=? AND task_id=?)) ORDER BY captured_at DESC,id DESC LIMIT 33`,
            )
            .all(session.id, contract.id, session.id, request.taskId) as Array<
            Record<string, unknown>
          >)
        : [];
    if (evidence.length > 32) truncated = true;
    const result: BotWorkResultManifest = {
      request,
      task: {
        id: request.taskId,
        title: String(row.title),
        status: row.status as BotWorkResultManifest["task"]["status"],
        source: row.source as BotWorkResultManifest["task"]["source"],
        agentConfig: object(config) ? config : undefined,
        policyValid,
        recordedVerification:
          row.verification_verdict === "PASS"
            ? "passed"
            : row.verification_verdict === "FAIL"
              ? "failed"
              : row.verification_verdict === "PARTIAL"
                ? "partial"
                : "unverified",
      },
      workspace: {
        id: request.workspaceId,
        name: String(row.workspace_name),
        path: String(row.workspace_path),
        permissions: (object(permissions)
          ? permissions
          : {
              read: false,
              write: false,
              delete: false,
              shell: false,
              network: false,
            }) as unknown as BotWorkResultManifest["workspace"]["permissions"],
        createdAt: 0,
        lastUsedAt: 0,
      },
      contract,
      artifacts: selected.map((a) => ({
        id: String(a.id),
        artifactId: typeof a.artifact_id === "string" ? a.artifact_id : undefined,
        path: String(a.path),
        revision: Number(a.revision),
        sha256: String(a.sha256),
        size: Number(a.size),
        status: ["draft", "committed", "superseded", "retracted"].includes(String(a.status))
          ? (a.status as BotWorkResultManifest["artifacts"][number]["status"])
          : "draft",
      })),
      evidence: evidence.slice(0, 32).map((e) => ({
        id: String(e.id),
        claim: String(e.claim),
        sourceType: String(e.source_type),
        capturedAt: Number(e.captured_at),
        expiresAt: typeof e.freshness_expires_at === "number" ? e.freshness_expires_at : undefined,
        status: String(e.status),
        artifactRevisionId:
          typeof e.artifact_revision_id === "string" ? e.artifact_revision_id : undefined,
      })),
      truncated,
      issues,
      checksum: "",
    };
    result.checksum = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    return result;
  }
}
