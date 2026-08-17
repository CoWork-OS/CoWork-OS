import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentSecurityDiagnostic,
  AgentSecurityEnforcement,
  AgentSecurityFinding,
} from "../../../shared/agent-security";
import { AgentSecurityRepository } from "./AgentSecurityRepository";
import { redactAgentSecurityRecord, redactAgentSecurityString } from "./NumbatRedaction";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;

interface FileCursor {
  offset: number;
  dev: number;
  ino: number;
}

export interface NumbatIngestResult {
  findings: AgentSecurityFinding[];
  decisions: AgentSecurityEnforcement[];
  diagnostics: AgentSecurityDiagnostic[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function safeTimestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export class NumbatRecordIngestor {
  private readonly cursors = new Map<string, FileCursor>();

  constructor(
    private readonly repository: AgentSecurityRepository,
    private readonly cursorDir?: string,
  ) {
    if (cursorDir) fs.mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
  }

  private cursorPath(filePath: string): string | undefined {
    if (!this.cursorDir) return undefined;
    const key = createHash("sha256").update(path.resolve(filePath)).digest("hex");
    return path.join(this.cursorDir, `${key}.json`);
  }

  private loadCursor(filePath: string): FileCursor | undefined {
    const inMemory = this.cursors.get(filePath);
    if (inMemory) return inMemory;
    const cursorPath = this.cursorPath(filePath);
    if (!cursorPath || !fs.existsSync(cursorPath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as Partial<FileCursor>;
      if (
        Number.isSafeInteger(parsed.offset) &&
        Number.isSafeInteger(parsed.dev) &&
        Number.isSafeInteger(parsed.ino)
      ) {
        const cursor = parsed as FileCursor;
        this.cursors.set(filePath, cursor);
        return cursor;
      }
    } catch {
      // A corrupt cursor is safe to ignore; repository upserts remain idempotent.
    }
    return undefined;
  }

  private saveCursor(filePath: string, cursor: FileCursor): void {
    this.cursors.set(filePath, cursor);
    const cursorPath = this.cursorPath(filePath);
    if (!cursorPath) return;
    const temporaryPath = `${cursorPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(cursor), { mode: 0o600 });
    fs.renameSync(temporaryPath, cursorPath);
  }

  forgetFile(filePath: string): void {
    this.cursors.delete(filePath);
    const cursorPath = this.cursorPath(filePath);
    if (cursorPath) fs.rmSync(cursorPath, { force: true });
  }

  ingestFile(filePath: string, taskId?: string): NumbatIngestResult {
    const result: NumbatIngestResult = { findings: [], decisions: [], diagnostics: [] };
    if (!fs.existsSync(filePath)) return result;
    const stat = fs.statSync(filePath);
    const previous = this.loadCursor(filePath);
    const sameFile = previous && previous.dev === stat.dev && previous.ino === stat.ino;
    const offset = sameFile && stat.size >= previous.offset ? previous.offset : 0;
    const bytesToRead = Math.min(MAX_READ_BYTES, Math.max(0, stat.size - offset));
    if (bytesToRead === 0) return result;

    const fd = fs.openSync(filePath, "r");
    let bytesRead = 0;
    let buffer: Buffer;
    try {
      buffer = Buffer.allocUnsafe(bytesToRead);
      bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
    } finally {
      fs.closeSync(fd);
    }

    const readBuffer = buffer.subarray(0, bytesRead);
    const lastNewline = readBuffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return result;
    const committed = readBuffer.subarray(0, lastNewline + 1);
    const lines = committed.toString("utf8").split("\n");
    lines.pop();
    this.saveCursor(filePath, {
      offset: offset + committed.length,
      dev: stat.dev,
      ino: stat.ino,
    });

    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        result.diagnostics.push(
          this.repository.addDiagnostic({
            taskId,
            level: "error",
            code: "record_too_large",
            message: "Numbat record exceeded the CoWork ingestion limit",
          }),
        );
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = asRecord(JSON.parse(line));
      } catch {
        result.diagnostics.push(
          this.repository.addDiagnostic({
            taskId,
            level: "warn",
            code: "invalid_ndjson",
            message: "Numbat emitted an invalid NDJSON record",
          }),
        );
        continue;
      }
      const redacted = asRecord(redactAgentSecurityRecord(parsed));
      const recordType = stringValue(redacted, "record_type");
      if (recordType === "finding") {
        const finding = this.toFinding(redacted, taskId);
        if (finding) {
          this.repository.upsertFinding(finding);
          result.findings.push(finding);
        }
      } else if (recordType === "enforcement") {
        const decision = this.toDecision(redacted, taskId);
        if (decision) {
          this.repository.upsertDecision(decision);
          result.decisions.push(decision);
        }
      } else if (recordType === "diagnostic") {
        const diagnostic = this.repository.addDiagnostic({
          taskId,
          level: redacted.level === "error" ? "error" : redacted.level === "warn" ? "warn" : "info",
          code: stringValue(redacted, "code") || "numbat_diagnostic",
          message: redactAgentSecurityString(
            stringValue(redacted, "message") || "Numbat diagnostic",
            1_024,
          ),
        });
        result.diagnostics.push(diagnostic);
      }
    }
    return result;
  }

  private toFinding(record: Record<string, unknown>, taskId?: string): AgentSecurityFinding | null {
    const findingId = stringValue(record, "finding_id");
    const ruleId = stringValue(record, "rule_id");
    if (!findingId || !ruleId) return null;
    const severity =
      record.severity === "critical" ||
      record.severity === "high" ||
      record.severity === "medium" ||
      record.severity === "low"
        ? record.severity
        : "info";
    const detectedAt = stringValue(record, "detected_at") || new Date().toISOString();
    const now = Date.now();
    return {
      findingId,
      schemaVersion: stringValue(record, "schema_version") || "unknown",
      taskId,
      sessionId: stringValue(record, "session_id") || undefined,
      sourceAgent: stringValue(record, "source_agent") || "unknown",
      sourceType: stringValue(record, "source_type") || "hook",
      ruleId,
      ruleVersion: stringValue(record, "rule_version") || "unknown",
      severity,
      title: stringValue(record, "title") || ruleId,
      status: "open",
      detectedAt,
      observedAt: stringValue(record, "timestamp") || undefined,
      projectPathHash: stringValue(record, "project_path_hash") || undefined,
      record,
      createdAt: safeTimestamp(detectedAt),
      updatedAt: now,
    };
  }

  private toDecision(
    record: Record<string, unknown>,
    taskId?: string,
  ): AgentSecurityEnforcement | null {
    const decisionId = stringValue(record, "decision_id");
    if (!decisionId) return null;
    const timestamp = stringValue(record, "timestamp");
    return {
      decisionId,
      schemaVersion: stringValue(record, "schema_version") || "unknown",
      taskId,
      sessionId: stringValue(record, "session_id") || undefined,
      toolCallId: stringValue(record, "tool_call_id") || undefined,
      decision: record.decision === "deny" ? "deny" : "no_override",
      mode: record.mode === "enforce" ? "enforce" : "monitor",
      reason: stringValue(record, "reason") || "unknown",
      sourceAgent: stringValue(record, "source_agent") || "unknown",
      findingIds: stringArray(record, "finding_ids"),
      ruleIds: stringArray(record, "rule_ids"),
      hostOutcome: "unknown",
      record,
      createdAt: safeTimestamp(timestamp),
    };
  }
}
