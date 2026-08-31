import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const policyMocks = vi.hoisted(() => {
  const createPolicies = () => ({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    packs: { allowed: [], blocked: [], required: [] },
    connectors: { blocked: [] },
    agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
    everydayAgent: {
      blocked: false,
      blockedBundles: [],
      forceReviewOnly: false,
      maxHeartbeatCadenceMinutes: 60,
      maxConcurrentBackgroundWork: 1,
      activeHours: { enabled: false, windows: [] },
    },
    runtime: {
      allowedPermissionModes: [],
      allowedSandboxTypes: ["macos", "docker"],
      requireSandboxForShell: false,
      allowUnsandboxedShell: false,
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
      autoReview: { enabled: true },
      telemetry: { enabled: false },
    },
    general: {
      allowCustomPacks: true,
      allowGitInstall: true,
      allowUrlInstall: true,
    },
  });
  return {
    createPolicies,
    loadPolicies: vi.fn(() => createPolicies()),
    loadPoliciesStrict: vi.fn(() => createPolicies()),
  };
});

vi.mock("../../admin/policies", () => ({
  loadPolicies: policyMocks.loadPolicies,
  loadPoliciesStrict: policyMocks.loadPoliciesStrict,
}));

import { EverydayAgentService } from "../EverydayAgentService";

type Row = Record<string, unknown>;

class FakeStatement {
  constructor(
    private db: FakeDb,
    private sql: string,
  ) {}

  get(...args: unknown[]) {
    return this.db.get(this.sql, args);
  }

  all(...args: unknown[]) {
    return this.db.all(this.sql, args);
  }

  run(...args: unknown[]) {
    return this.db.run(this.sql, args);
  }
}

class FakeDb {
  workspaces: Row[] = [
    {
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/workspace",
      created_at: 1,
      last_used_at: 1,
      permissions: '{"shell":false,"network":false}',
    },
  ];
  profiles: Row[] = [];
  receipts: Row[] = [];
  pauses: Row[] = [];
  previews: Row[] = [];
  consent: Row[] = [];
  agents: Row[] = [];
  versions: Row[] = [];
  environments: Row[] = [];
  trustPatterns: Row[] = [];
  taskLinks: Row[] = [];
  connectorSummaries: Row[] = [];
  browserProfileMetadata: Row[] = [];
  routineProvenance: Row[] = [];
  coreMemoryCandidates: Row[] = [];
  coreMemoryDistillRuns: Row[] = [];
  routines: Row[] = [];
  routineRuns: Row[] = [];

  exec() {}

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return ((...args: unknown[]) => fn(...args)) as T;
  }

  get(sql: string, args: unknown[]): Row | undefined {
    const normalized = normalizeSql(sql);
    if (normalized.includes("select name from sqlite_master")) {
      const tableName = String(args[0] || "");
      const tables = new Set([
        "everyday_agent_task_links",
        "everyday_agent_browser_profile_metadata",
        "everyday_agent_connector_summaries",
        "everyday_agent_routine_provenance",
        "core_memory_candidates",
        "core_memory_distill_runs",
        "automation_routines",
        "routine_runs",
      ]);
      return tables.has(tableName) ? { name: tableName } : undefined;
    }
    if (normalized.includes("select * from everyday_agent_profiles where id = ?")) {
      return this.profiles.find((row) => row.id === args[0]);
    }
    if (normalized.includes("select * from managed_agents where id = ?")) {
      return this.agents.find((row) => row.id === args[0]);
    }
    if (normalized.includes("select name from managed_agents where id = ?")) {
      const row = this.agents.find((agent) => agent.id === args[0]);
      return row ? { name: row.name } : undefined;
    }
    if (
      normalized.includes("select * from managed_agent_versions where agent_id = ? and version = ?")
    ) {
      return this.versions.find((row) => row.agent_id === args[0] && row.version === args[1]);
    }
    if (normalized.includes("select * from managed_environments where id = ?")) {
      return this.environments.find((row) => row.id === args[0]);
    }
    if (normalized.includes("select * from workspaces where id = ?")) {
      return this.workspaces.find((row) => row.id === args[0]);
    }
    if (
      normalized.includes("select preview_json from everyday_agent_action_previews") &&
      normalized.includes("profile_id = ? and idempotency_key = ?")
    ) {
      const row = this.previews.find(
        (preview) => preview.profile_id === args[0] && preview.idempotency_key === args[1],
      );
      return row ? { preview_json: row.preview_json } : undefined;
    }
    if (normalized.includes("select * from everyday_agent_action_previews where id = ?")) {
      return this.previews.find((row) => row.id === args[0]);
    }
    if (normalized.includes("select count(*) as count from everyday_agent_action_previews")) {
      return { count: this.previews.length };
    }
    if (
      normalized.includes("select * from everyday_agent_receipts") &&
      normalized.includes("profile_id = ? and idempotency_key = ?")
    ) {
      return this.receipts.find(
        (row) => row.profile_id === args[0] && row.idempotency_key === args[1],
      );
    }
    if (normalized.includes("select * from everyday_agent_trust_patterns")) {
      return this.trustPatterns.find((row) => {
        return (
          row.profile_id === args[0] &&
          row.capability === args[1] &&
          row.action_class === args[2] &&
          (row.workspace_id || "") === args[3] &&
          (row.connector_id || "") === args[4] &&
          (row.connector_account_id || "") === args[5] &&
          (row.destination || "") === args[6] &&
          (!normalized.includes("status = 'trusted'") || row.status === "trusted")
        );
      });
    }
    return undefined;
  }

  all(sql: string, args: unknown[]): Row[] {
    const normalized = normalizeSql(sql);
    if (normalized.includes("select * from workspaces")) {
      return [...this.workspaces];
    }
    if (normalized.includes("select * from everyday_agent_pause_scopes")) {
      const profileId = args[0];
      const now = Number(args[1] || 0);
      return this.pauses.filter(
        (row) => row.profile_id === profileId && (!row.expires_at || row.expires_at > now),
      );
    }
    if (normalized.includes("select * from everyday_agent_receipts")) {
      return this.receipts
        .filter((row) => row.profile_id === args[0])
        .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    }
    if (normalized.includes("select routine_id from everyday_agent_routine_provenance")) {
      return this.routineProvenance
        .filter((row) => row.profile_id === args[0])
        .map((row) => ({ routine_id: row.routine_id }));
    }
    if (normalized.includes("select id, definition_json from automation_routines")) {
      return [...this.routines];
    }
    return [];
  }

  run(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.includes("insert into everyday_agent_profiles")) {
      const row = {
        id: args[0],
        profile_json: args[1],
        created_at: args[2],
        updated_at: args[3],
      };
      const index = this.profiles.findIndex((profile) => profile.id === row.id);
      if (index >= 0) this.profiles[index] = row;
      else this.profiles.push(row);
      return { changes: 1 };
    }
    if (normalized.includes("insert into everyday_agent_consent_history")) {
      this.consent.push({
        id: args[0],
        profile_id: args[1],
        consent_version: args[2],
        accepted: args[3],
        metadata_json: args[4],
        created_at: args[5],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into everyday_agent_pause_scopes")) {
      this.pauses.push({
        id: args[0],
        profile_id: args[1],
        scope_json: args[2],
        reason: args[3],
        expires_at: args[4],
        created_at: args[5],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into everyday_agent_action_previews")) {
      this.previews.push({
        id: args[0],
        profile_id: args[1],
        workspace_id: args[2],
        capability: args[3],
        risk_class: args[4],
        status: args[5],
        preview_json: args[6],
        idempotency_key: args[7],
        created_at: args[8],
        updated_at: args[9],
      });
      return { changes: 1 };
    }
    if (normalized.includes("update everyday_agent_action_previews")) {
      const row = this.previews.find((preview) => preview.id === args[3]);
      if (row) {
        row.status = args[0];
        row.preview_json = args[1];
        row.updated_at = args[2];
      }
      return { changes: row ? 1 : 0 };
    }
    if (normalized.includes("insert into everyday_agent_receipts")) {
      const duplicate = this.receipts.find(
        (row) => row.profile_id === args[1] && row.idempotency_key === args[14],
      );
      if (duplicate)
        throw new Error(
          "UNIQUE constraint failed: everyday_agent_receipts.profile_id, everyday_agent_receipts.idempotency_key",
        );
      this.receipts.push({
        id: args[0],
        profile_id: args[1],
        workspace_id: args[2],
        capability: args[3],
        risk_class: args[4],
        status: args[5],
        title: args[6],
        summary: args[7],
        source_signals_json: args[8],
        approval_id: args[9],
        preview_id: args[10],
        tool_calls_json: args[11],
        external_ids_json: args[12],
        retry_state_json: args[13],
        idempotency_key: args[14],
        result_json: args[15],
        created_at: args[16],
        updated_at: args[17],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into managed_agents")) {
      this.agents.push({
        id: args[0],
        name: args[1],
        description: args[2],
        status: args[3],
        current_version: args[4],
        created_at: args[5],
        updated_at: args[6],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into managed_agent_versions")) {
      this.versions.push({
        agent_id: args[0],
        version: args[1],
        model_json: args[2],
        system_prompt: args[3],
        execution_mode: args[4],
        runtime_defaults_json: args[5],
        skills_json: args[6],
        mcp_servers_json: args[7],
        team_template_json: args[8],
        metadata_json: args[9],
        created_at: args[10],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into managed_environments")) {
      this.environments.push({
        id: args[0],
        name: args[1],
        kind: args[2],
        revision: args[3],
        status: args[4],
        config_json: args[5],
        created_at: args[6],
        updated_at: args[7],
      });
      return { changes: 1 };
    }
    if (normalized.includes("insert into everyday_agent_trust_patterns")) {
      this.trustPatterns.push({
        id: args[0],
        profile_id: args[1],
        capability: args[2],
        workspace_id: args[3],
        connector_id: args[4],
        connector_account_id: args[5],
        action_class: args[6],
        destination: args[7],
        status: args[8],
        source_suggestion_ids_json: args[9],
        provenance: args[10],
        accepted_count: args[11],
        rejected_count: args[12],
        last_used_at: args[13],
        created_at: args[14],
        updated_at: args[15],
      });
      return { changes: 1 };
    }
    if (normalized.includes("delete from everyday_agent_receipts where profile_id = ?")) {
      return this.deleteRows(this.receipts, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_action_previews where profile_id = ?")) {
      return this.deleteRows(this.previews, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_trust_patterns where profile_id = ?")) {
      return this.deleteRows(this.trustPatterns, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_consent_history where profile_id = ?")) {
      return this.deleteRows(this.consent, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_pause_scopes where profile_id = ?")) {
      return this.deleteRows(this.pauses, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_task_links where profile_id = ?")) {
      return this.deleteRows(this.taskLinks, (row) => row.profile_id === args[0]);
    }
    if (
      normalized.includes(
        "delete from everyday_agent_browser_profile_metadata where profile_id = ?",
      )
    ) {
      return this.deleteRows(this.browserProfileMetadata, (row) => row.profile_id === args[0]);
    }
    if (
      normalized.includes("delete from everyday_agent_connector_summaries where profile_id = ?")
    ) {
      return this.deleteRows(this.connectorSummaries, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from everyday_agent_routine_provenance where profile_id = ?")) {
      return this.deleteRows(this.routineProvenance, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from core_memory_candidates where profile_id = ?")) {
      return this.deleteRows(this.coreMemoryCandidates, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from core_memory_distill_runs where profile_id = ?")) {
      return this.deleteRows(this.coreMemoryDistillRuns, (row) => row.profile_id === args[0]);
    }
    if (normalized.includes("delete from routine_runs where routine_id = ?")) {
      return this.deleteRows(this.routineRuns, (row) => row.routine_id === args[0]);
    }
    if (normalized.includes("delete from automation_routines where id = ?")) {
      return this.deleteRows(this.routines, (row) => row.id === args[0]);
    }
    return { changes: 0 };
  }

  private deleteRows(rows: Row[], predicate: (row: Row) => boolean): { changes: number } {
    const before = rows.length;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row && predicate(row)) rows.splice(index, 1);
    }
    return { changes: before - rows.length };
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, " ").trim();
}

describe("EverydayAgentService", () => {
  let db: FakeDb;
  let service: EverydayAgentService;

  beforeEach(() => {
    policyMocks.loadPolicies.mockImplementation(() => policyMocks.createPolicies());
    policyMocks.loadPoliciesStrict.mockImplementation(() => policyMocks.createPolicies());
    db = new FakeDb();
    service = new EverydayAgentService(db as unknown as Database.Database);
  });

  it("starts disabled with review-first defaults", () => {
    const result = service.getProfile();

    expect(result.profile.enabled).toBe(false);
    expect(result.profile.approvalPosture).toBe("review_first");
    expect(result.profile.memoryPolicy.reviewRequired).toBe(true);
    expect(result.compiledPolicy.enabled).toBe(false);
  });

  it("accepts consent and creates the default managed agent preset", () => {
    const result = service.acceptConsent({ enabled: true, workspaceId: "ws-1" });

    expect(result.profile.enabled).toBe(true);
    expect(result.compiledPolicy.allowedCapabilities).toContain("inbox");
    expect(result.compiledPolicy.allowedCapabilities).toContain("browser");
    expect(
      db.prepare("SELECT name FROM managed_agents WHERE id = ?").get("cowork-everyday-agent"),
    ).toEqual({ name: "Everyday Agent" });
  });

  it("fails closed when admin policies cannot be loaded", () => {
    policyMocks.loadPoliciesStrict.mockReturnValue(null);

    expect(service.getProfile().compiledPolicy.adminPolicy.blocked).toBe(true);
    expect(() => service.acceptConsent({ enabled: true, workspaceId: "ws-1" })).toThrow(
      /admin policies failed to load/i,
    );
  });

  it("records declined consent without marking consent accepted", () => {
    const result = service.acceptConsent({
      enabled: false,
      accepted: false,
      workspaceId: "ws-1",
    });

    expect(result.profile.enabled).toBe(false);
    expect(result.profile.acceptedConsentVersion).toBe(0);
    expect(result.profile.declinedConsentVersion).toBe(1);
    expect(result.profile.consentDeclinedAt).toEqual(expect.any(Number));
    expect(result.profile.consentAcceptedAt).toBeUndefined();
    expect(db.consent[0]).toMatchObject({ accepted: 0, consent_version: 1 });
  });

  it("classifies sensitive operations conservatively", () => {
    expect(service.classifyActionRisk("send email reply")).toBe("execute_sensitive");
    expect(service.classifyActionRisk("bulk export customer docs")).toBe("data_export");
    expect(service.classifyActionRisk("delete shared folder")).toBe("destructive");
    expect(service.classifyActionRisk("buy subscription")).toBe("spend");
    expect(service.classifyActionRisk("read meeting notes")).toBe("read");
  });

  it("requires approval for exports even when trusted patterns are enabled", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    service.updateProfile({ approvalPosture: "trusted_patterns" });

    const preview = service.previewAction({
      title: "Export inbox summary",
      action: "Export thread data to an external spreadsheet",
      capability: "inbox",
      workspaceId: "ws-1",
    });

    expect(preview.riskClass).toBe("data_export");
    expect(preview.approvalRequired).toBe(true);
  });

  it("honors pause and revoke semantics", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const paused = service.pause({ kind: "global", reason: "test" });
    expect(paused.compiledPolicy.enabled).toBe(false);

    const revoked = service.revokeCapability("browser");
    expect(revoked.profile.capabilitySettings.browser.enabled).toBe(false);
    expect(revoked.profile.revokedCapabilities).toContain("browser");
  });

  it("returns the same preview for duplicate side-effect proposals", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const input = {
      title: "Schedule meeting",
      action: "Create event on calendar",
      capability: "calendar" as const,
      workspaceId: "ws-1",
      destination: "primary",
    };

    const first = service.previewAction(input);
    const second = service.previewAction(input);
    const count = db
      .prepare("SELECT COUNT(*) as count FROM everyday_agent_action_previews")
      .get() as { count: number };

    expect(second.id).toBe(first.id);
    expect(count.count).toBe(1);
  });

  it("revalidates current policy before approving a preview", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const preview = service.previewAction({
      title: "Schedule meeting",
      action: "Create event on calendar",
      capability: "calendar",
      workspaceId: "ws-1",
      destination: "primary",
    });
    policyMocks.loadPoliciesStrict.mockImplementation(() => ({
      ...policyMocks.createPolicies(),
      everydayAgent: {
        ...policyMocks.createPolicies().everydayAgent,
        blockedBundles: ["calendar"],
      },
    }));

    expect(() => service.approveAction({ previewId: preview.id })).toThrow(/calendar is disabled/i);
    expect(db.previews.find((row) => row.id === preview.id)).toMatchObject({
      status: "blocked",
    });
    expect(db.trustPatterns).toHaveLength(0);
  });

  it("rejects expired previews before approval", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const preview = service.previewAction({
      title: "Stage reply",
      action: "Draft email reply",
      capability: "inbox",
      workspaceId: "ws-1",
    });
    const row = db.previews.find((item) => item.id === preview.id);
    const expiredPreview = { ...preview, expiresAt: Date.now() - 1 };
    if (row) row.preview_json = JSON.stringify(expiredPreview);

    expect(() => service.approveAction({ previewId: preview.id })).toThrow(/preview expired/i);
    expect(db.previews.find((item) => item.id === preview.id)).toMatchObject({
      status: "expired",
    });
    expect(db.trustPatterns).toHaveLength(0);
  });

  it("clears owned retention stores without leaving a new receipt during full deletion", () => {
    service.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const profileId = service.getProfile().profile.id;
    db.taskLinks.push({ profile_id: profileId, task_id: "task-1" });
    db.connectorSummaries.push({ profile_id: profileId, connector_id: "gmail" });
    db.browserProfileMetadata.push({ profile_id: profileId, browser_profile_id: "visible" });
    db.coreMemoryCandidates.push({ profile_id: profileId, id: "candidate-1" });
    db.coreMemoryDistillRuns.push({ profile_id: profileId, id: "distill-1" });
    db.routineProvenance.push({ profile_id: profileId, routine_id: "routine-1" });
    db.routines.push({
      id: "routine-1",
      definition_json: JSON.stringify({
        contextBindings: { metadata: { everydayAgentProfileId: profileId } },
      }),
    });
    db.routineRuns.push({ routine_id: "routine-1" });

    service.clearData();

    expect(db.receipts).toHaveLength(0);
    expect(db.taskLinks).toHaveLength(0);
    expect(db.connectorSummaries).toHaveLength(0);
    expect(db.browserProfileMetadata).toHaveLength(0);
    expect(db.coreMemoryCandidates).toHaveLength(0);
    expect(db.coreMemoryDistillRuns).toHaveLength(0);
    expect(db.routineProvenance).toHaveLength(0);
    expect(db.routines).toHaveLength(0);
    expect(db.routineRuns).toHaveLength(0);
  });
});
