import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSecurityRepository } from "../AgentSecurityRepository";
import { NumbatRecordIngestor } from "../NumbatRecordIngestor";

const temporaryRoots: string[] = [];

function repositoryDouble() {
  return {
    upsertFinding: vi.fn(),
    upsertDecision: vi.fn(),
    addDiagnostic: vi.fn((input: Record<string, unknown>) => ({
      ...input,
      id: `diagnostic-${Math.random()}`,
      createdAt: Date.now(),
    })),
  } as unknown as AgentSecurityRepository;
}

function temporaryFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "numbat-ingestor-test-"));
  temporaryRoots.push(root);
  return path.join(root, "records.ndjson");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("NumbatRecordIngestor", () => {
  it("ingests findings and enforcement records incrementally", () => {
    const repository = repositoryDouble();
    const ingestor = new NumbatRecordIngestor(repository);
    const filePath = temporaryFile();
    const finding = {
      record_type: "finding",
      finding_id: "finding-1",
      schema_version: "0.2.0",
      source_agent: "cowork-os",
      source_type: "hook",
      session_id: "session-1",
      rule_id: "destructive_recursive_delete",
      rule_version: "1",
      severity: "critical",
      title: "Destructive delete",
      detected_at: "2026-07-30T12:00:00.000Z",
      api_key: "sk-this-value-must-never-persist",
    };
    fs.writeFileSync(filePath, `${JSON.stringify(finding)}\n{"record_type":"enforcement",`);

    const first = ingestor.ingestFile(filePath, "task-1");
    expect(first.findings).toHaveLength(1);
    expect(first.decisions).toHaveLength(0);
    expect(first.findings[0].record.api_key).toBe("[REDACTED]");

    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        decision_id: "decision-1",
        schema_version: "0.2.0",
        session_id: "session-1",
        tool_call_id: "tool-1",
        decision: "deny",
        mode: "enforce",
        reason: "rule match",
        source_agent: "cowork-os",
        finding_ids: ["finding-1"],
        rule_ids: ["destructive_recursive_delete"],
        timestamp: "2026-07-30T12:00:01.000Z",
      }).slice(1)}\n`,
    );

    const second = ingestor.ingestFile(filePath, "task-1");
    expect(second.findings).toHaveLength(0);
    expect(second.decisions).toEqual([
      expect.objectContaining({
        decisionId: "decision-1",
        taskId: "task-1",
        toolCallId: "tool-1",
        decision: "deny",
        mode: "enforce",
      }),
    ]);
  });

  it("records a bounded diagnostic for invalid NDJSON", () => {
    const repository = repositoryDouble();
    const ingestor = new NumbatRecordIngestor(repository);
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, "{not-json}\n");

    const result = ingestor.ingestFile(filePath, "task-2");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        taskId: "task-2",
        code: "invalid_ndjson",
        level: "warn",
      }),
    ]);
  });

  it("persists committed offsets across ingestor restarts", () => {
    const repository = repositoryDouble();
    const filePath = temporaryFile();
    const cursorDir = path.join(path.dirname(filePath), "cursors");
    const record = {
      record_type: "enforcement",
      decision_id: "decision-1",
      schema_version: "0.2.0",
      decision: "no_override",
      mode: "monitor",
      source_agent: "cowork-os",
      timestamp: "2026-07-30T12:00:01.000Z",
    };
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);

    expect(
      new NumbatRecordIngestor(repository, cursorDir).ingestFile(filePath).decisions,
    ).toHaveLength(1);
    expect(
      new NumbatRecordIngestor(repository, cursorDir).ingestFile(filePath).decisions,
    ).toHaveLength(0);
  });
});
