import Database from "better-sqlite3";
import {
  AgentMailApiKeySummary,
  AgentMailConnectionTestResult,
  AgentMailDomain,
  AgentMailInbox,
  AgentMailListEntry,
  AgentMailPod,
  AgentMailSettingsData,
  AgentMailStatus,
  AgentMailWorkspaceBinding,
} from "../../shared/types";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { AgentMailClient } from "./AgentMailClient";

type AgentMailRealtimeStatusProvider = () => Pick<
  AgentMailStatus,
  "realtimeConnected" | "connectionState" | "lastEventAt" | "error"
>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function listEntryId(
  workspaceId: string,
  inboxId: string | undefined,
  direction: string,
  listType: string,
  entry: string,
): string {
  return [workspaceId, inboxId || "org", direction, listType, entry.toLowerCase()].join(":");
}

function mapPod(payload: unknown): AgentMailPod {
  const record = asObject(payload) || {};
  return {
    podId: asString(record.pod_id) || "",
    name: asString(record.name),
    clientId: asString(record.client_id),
    createdAt: parseTimestamp(record.created_at),
    updatedAt: parseTimestamp(record.updated_at),
  };
}

function mapInbox(payload: unknown, workspaceId?: string): AgentMailInbox {
  const record = asObject(payload) || {};
  return {
    podId: asString(record.pod_id) || "",
    inboxId: asString(record.inbox_id) || "",
    email: asString(record.email) || asString(record.inbox_id),
    displayName: asString(record.display_name),
    clientId: asString(record.client_id),
    workspaceId,
    createdAt: parseTimestamp(record.created_at),
    updatedAt: parseTimestamp(record.updated_at),
  };
}

function mapDomain(payload: unknown, workspaceId?: string): AgentMailDomain {
  const record = asObject(payload) || {};
  const records = Array.isArray(record.records)
    ? record.records
        .map((item) => {
          const entry = asObject(item);
          if (!entry) return null;
          const type = asString(entry.type);
          const name = asString(entry.name);
          const value = asString(entry.value);
          if (!type || !name || !value) return null;
          return {
            type,
            name,
            value,
            status: asString(entry.status),
            priority: asNumber(entry.priority),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  return {
    domainId: asString(record.domain_id) || "",
    domain: asString(record.domain),
    status: asString(record.status),
    feedbackEnabled: Boolean(record.feedback_enabled),
    records,
    podId: asString(record.pod_id) || "",
    clientId: asString(record.client_id),
    workspaceId,
    createdAt: parseTimestamp(record.created_at),
    updatedAt: parseTimestamp(record.updated_at),
  };
}

function mapListEntry(
  payload: unknown,
  fallback: Partial<AgentMailListEntry> = {},
): AgentMailListEntry | null {
  const record = asObject(payload) || {};
  const direction = (asString(record.direction) || fallback.direction) as
    | AgentMailListEntry["direction"]
    | undefined;
  const listType = (asString(record.type) || fallback.listType) as
    | AgentMailListEntry["listType"]
    | undefined;
  const entry = asString(record.entry);
  if (!direction || !listType || !entry) return null;
  return {
    direction,
    listType,
    entry,
    entryType:
      (asString(record.entry_type) as AgentMailListEntry["entryType"] | undefined) ||
      fallback.entryType,
    reason: asString(record.reason),
    organizationId: asString(record.organization_id),
    podId: asString(record.pod_id) || fallback.podId,
    inboxId: asString(record.inbox_id) || fallback.inboxId,
    createdAt: parseTimestamp(record.created_at),
  };
}

function mapApiKey(payload: unknown): AgentMailApiKeySummary {
  const record = asObject(payload) || {};
  return {
    apiKeyId: asString(record.api_key_id) || "",
    prefix: asString(record.prefix) || "",
    name: asString(record.name),
    podId: asString(record.pod_id),
    inboxId: asString(record.inbox_id),
    createdAt: parseTimestamp(record.created_at),
    permissions: asObject(record.permissions) as Record<string, boolean> | undefined,
  };
}

export class AgentMailAdminService {
  constructor(
    private readonly db: Database.Database,
    private readonly getRealtimeStatus?: AgentMailRealtimeStatusProvider,
  ) {}

  getSettings(): AgentMailSettingsData {
    return AgentMailSettingsManager.loadSettings();
  }

  saveSettings(settings: AgentMailSettingsData): void {
    AgentMailSettingsManager.saveSettings(settings);
    AgentMailSettingsManager.clearCache();
  }

  private getClient(): AgentMailClient {
    return new AgentMailClient(AgentMailSettingsManager.loadSettings());
  }

  private getWorkspaceBindingRow(workspaceId: string) {
    return this.db
      .prepare(
        `SELECT workspace_id, pod_id, pod_name, created_at, updated_at
         FROM agentmail_workspace_pods
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as
      | {
          workspace_id: string;
          pod_id: string;
          pod_name: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
  }

  private ensureWorkspaceBinding(workspaceId: string): AgentMailWorkspaceBinding {
    const row = this.getWorkspaceBindingRow(workspaceId);
    if (!row) {
      throw new Error("This workspace is not bound to an AgentMail pod yet.");
    }
    return {
      workspaceId: row.workspace_id,
      podId: row.pod_id,
      podName: row.pod_name || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private persistWorkspaceBinding(binding: AgentMailWorkspaceBinding): void {
    this.db
      .prepare(
        `INSERT INTO agentmail_workspace_pods
          (workspace_id, pod_id, pod_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           pod_id = excluded.pod_id,
           pod_name = excluded.pod_name,
           updated_at = excluded.updated_at`,
      )
      .run(
        binding.workspaceId,
        binding.podId,
        binding.podName || null,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  private persistInboxes(workspaceId: string, podId: string, inboxes: AgentMailInbox[]): void {
    const now = Date.now();
    const existingIds = new Set(inboxes.map((inbox) => inbox.inboxId));
    const deleteStatement = this.db.prepare(
      `DELETE FROM agentmail_inboxes WHERE workspace_id = ? AND pod_id = ? AND inbox_id = ?`,
    );
    const upsertStatement = this.db.prepare(
      `INSERT INTO agentmail_inboxes
        (workspace_id, pod_id, inbox_id, email, display_name, client_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pod_id, inbox_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         email = excluded.email,
         display_name = excluded.display_name,
         client_id = excluded.client_id,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    );
    const currentRows = this.db
      .prepare("SELECT inbox_id FROM agentmail_inboxes WHERE workspace_id = ? AND pod_id = ?")
      .all(workspaceId, podId) as Array<{ inbox_id: string }>;

    for (const row of currentRows) {
      if (!existingIds.has(row.inbox_id)) {
        deleteStatement.run(workspaceId, podId, row.inbox_id);
      }
    }

    for (const inbox of inboxes) {
      upsertStatement.run(
        workspaceId,
        podId,
        inbox.inboxId,
        inbox.email || null,
        inbox.displayName || null,
        inbox.clientId || null,
        JSON.stringify(inbox),
        inbox.createdAt || now,
        inbox.updatedAt || now,
      );
    }
  }

  private persistDomains(workspaceId: string, podId: string, domains: AgentMailDomain[]): void {
    const now = Date.now();
    const existingIds = new Set(domains.map((domain) => domain.domainId));
    const currentRows = this.db
      .prepare("SELECT domain_id FROM agentmail_domains WHERE workspace_id = ? AND pod_id = ?")
      .all(workspaceId, podId) as Array<{ domain_id: string }>;

    for (const row of currentRows) {
      if (!existingIds.has(row.domain_id)) {
        this.db.prepare("DELETE FROM agentmail_domains WHERE domain_id = ?").run(row.domain_id);
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO agentmail_domains
        (domain_id, workspace_id, pod_id, domain, status, feedback_enabled, records_json, client_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         pod_id = excluded.pod_id,
         domain = excluded.domain,
         status = excluded.status,
         feedback_enabled = excluded.feedback_enabled,
         records_json = excluded.records_json,
         client_id = excluded.client_id,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    );

    for (const domain of domains) {
      upsert.run(
        domain.domainId,
        workspaceId,
        podId,
        domain.domain || null,
        domain.status || null,
        domain.feedbackEnabled ? 1 : 0,
        JSON.stringify(domain.records),
        domain.clientId || null,
        JSON.stringify(domain),
        domain.createdAt || now,
        domain.updatedAt || now,
      );
    }
  }

  private persistListEntries(workspaceId: string, entries: AgentMailListEntry[]): void {
    for (const entry of entries) {
      const id = listEntryId(
        workspaceId,
        entry.inboxId,
        entry.direction,
        entry.listType,
        entry.entry,
      );
      this.db
        .prepare(
          `INSERT INTO agentmail_lists
            (id, workspace_id, pod_id, inbox_id, direction, list_type, entry_value, entry_type, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pod_id = excluded.pod_id,
             inbox_id = excluded.inbox_id,
             entry_type = excluded.entry_type,
             reason = excluded.reason,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          workspaceId,
          entry.podId || null,
          entry.inboxId || null,
          entry.direction,
          entry.listType,
          entry.entry,
          entry.entryType || null,
          entry.reason || null,
          entry.createdAt || Date.now(),
          Date.now(),
        );
    }
  }

  private deleteListEntryRecord(
    workspaceId: string,
    inboxId: string | undefined,
    direction: AgentMailListEntry["direction"],
    listType: AgentMailListEntry["listType"],
    entry: string,
  ): void {
    this.db
      .prepare("DELETE FROM agentmail_lists WHERE id = ?")
      .run(listEntryId(workspaceId, inboxId, direction, listType, entry));
  }

  private persistApiKeys(
    workspaceId: string,
    inboxId: string,
    apiKeys: AgentMailApiKeySummary[],
  ): void {
    const seen = new Set(apiKeys.map((item) => item.apiKeyId));
    const currentRows = this.db
      .prepare("SELECT api_key_id FROM agentmail_api_keys WHERE workspace_id = ? AND inbox_id = ?")
      .all(workspaceId, inboxId) as Array<{ api_key_id: string }>;

    for (const row of currentRows) {
      if (!seen.has(row.api_key_id)) {
        this.db.prepare("DELETE FROM agentmail_api_keys WHERE api_key_id = ?").run(row.api_key_id);
      }
    }

    for (const apiKey of apiKeys) {
      this.db
        .prepare(
          `INSERT INTO agentmail_api_keys
            (api_key_id, workspace_id, pod_id, inbox_id, name, prefix, permissions_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(api_key_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             pod_id = excluded.pod_id,
             inbox_id = excluded.inbox_id,
             name = excluded.name,
             prefix = excluded.prefix,
             permissions_json = excluded.permissions_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          apiKey.apiKeyId,
          workspaceId,
          apiKey.podId || null,
          apiKey.inboxId || inboxId,
          apiKey.name || null,
          apiKey.prefix,
          JSON.stringify(apiKey.permissions || {}),
          apiKey.createdAt || Date.now(),
          Date.now(),
        );
    }
  }

  async testConnection(): Promise<AgentMailConnectionTestResult> {
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.apiKey) {
      return {
        success: false,
        error: "AgentMail API key is missing.",
        baseUrl: settings.baseUrl,
      };
    }

    try {
      const client = new AgentMailClient(settings);
      const podsResponse = await client.listPods(25);
      const pods = Array.isArray(podsResponse.pods) ? podsResponse.pods : [];
      let inboxCount = 0;

      for (const pod of pods.slice(0, 5)) {
        const podId = asString(asObject(pod)?.pod_id);
        if (!podId) continue;
        const inboxResponse = await client.listPodInboxes(podId, 100);
        inboxCount += Array.isArray(inboxResponse.inboxes) ? inboxResponse.inboxes.length : 0;
      }

      return {
        success: true,
        podCount: pods.length,
        inboxCount,
        baseUrl: client.baseUrl,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        baseUrl: settings.baseUrl,
      };
    }
  }

  async getStatus(): Promise<AgentMailStatus> {
    const settings = AgentMailSettingsManager.loadSettings();
    const realtime = this.getRealtimeStatus?.() || {
      realtimeConnected: false,
      connectionState: "disconnected" as const,
      lastEventAt: undefined,
      error: undefined,
    };

    if (!settings.apiKey) {
      return {
        configured: false,
        connected: false,
        realtimeConnected: realtime.realtimeConnected,
        connectionState: realtime.connectionState,
        baseUrl: settings.baseUrl,
        websocketUrl: settings.websocketUrl,
        lastEventAt: realtime.lastEventAt,
        error: realtime.error,
      };
    }

    const domainCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM agentmail_domains")
      .get() as { count: number };
    const inboxCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM agentmail_inboxes")
      .get() as { count: number };
    const podCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM agentmail_workspace_pods")
      .get() as { count: number };

    try {
      const result = await this.testConnection();
      return {
        configured: true,
        connected: result.success,
        realtimeConnected: realtime.realtimeConnected,
        connectionState: realtime.connectionState,
        baseUrl: settings.baseUrl,
        websocketUrl: settings.websocketUrl,
        podCount: result.podCount ?? podCountRow.count,
        inboxCount: result.inboxCount ?? inboxCountRow.count,
        domainCount: domainCountRow.count,
        lastEventAt: realtime.lastEventAt,
        error: result.success ? realtime.error : result.error || realtime.error,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        realtimeConnected: realtime.realtimeConnected,
        connectionState: realtime.connectionState,
        baseUrl: settings.baseUrl,
        websocketUrl: settings.websocketUrl,
        podCount: podCountRow.count,
        inboxCount: inboxCountRow.count,
        domainCount: domainCountRow.count,
        lastEventAt: realtime.lastEventAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listPods(): Promise<AgentMailPod[]> {
    const response = await this.getClient().listPods(100);
    return (Array.isArray(response.pods) ? response.pods : [])
      .map((pod) => mapPod(pod))
      .filter((pod) => pod.podId);
  }

  getWorkspaceBinding(workspaceId: string): AgentMailWorkspaceBinding | null {
    const row = this.getWorkspaceBindingRow(workspaceId);
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      podId: row.pod_id,
      podName: row.pod_name || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async bindWorkspacePod(workspaceId: string, podId: string): Promise<AgentMailWorkspaceBinding> {
    const pod = mapPod(await this.getClient().getPod(podId));
    const now = Date.now();
    const binding: AgentMailWorkspaceBinding = {
      workspaceId,
      podId: pod.podId,
      podName: pod.name,
      createdAt: this.getWorkspaceBindingRow(workspaceId)?.created_at || now,
      updatedAt: now,
    };
    this.persistWorkspaceBinding(binding);
    await this.refreshWorkspace(workspaceId);
    return binding;
  }

  async createWorkspacePod(
    workspaceId: string,
    podName?: string,
  ): Promise<AgentMailWorkspaceBinding> {
    const pod = mapPod(
      await this.getClient().createPod({
        name: podName,
        clientId: workspaceId,
      }),
    );
    const binding: AgentMailWorkspaceBinding = {
      workspaceId,
      podId: pod.podId,
      podName: pod.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.persistWorkspaceBinding(binding);
    await this.refreshWorkspace(workspaceId);
    return binding;
  }

  async refreshWorkspace(workspaceId: string): Promise<{
    binding: AgentMailWorkspaceBinding;
    inboxes: AgentMailInbox[];
    domains: AgentMailDomain[];
  }> {
    const binding = this.ensureWorkspaceBinding(workspaceId);
    const client = this.getClient();
    const [inboxResponse, domainResponse, podResponse] = await Promise.all([
      client.listPodInboxes(binding.podId, 100),
      client.listPodDomains(binding.podId, 100),
      client.getPod(binding.podId),
    ]);
    const pod = mapPod(podResponse);
    const nextBinding: AgentMailWorkspaceBinding = {
      ...binding,
      podName: pod.name || binding.podName,
      updatedAt: Date.now(),
    };
    this.persistWorkspaceBinding(nextBinding);

    const inboxes = (Array.isArray(inboxResponse.inboxes) ? inboxResponse.inboxes : [])
      .map((inbox) => mapInbox(inbox, workspaceId))
      .filter((inbox) => inbox.inboxId);
    const domains = (Array.isArray(domainResponse.domains) ? domainResponse.domains : [])
      .map((domain) => mapDomain(domain, workspaceId))
      .filter((domain) => domain.domainId);

    this.persistInboxes(workspaceId, binding.podId, inboxes);
    this.persistDomains(workspaceId, binding.podId, domains);

    return {
      binding: nextBinding,
      inboxes,
      domains,
    };
  }

  listInboxes(workspaceId: string): AgentMailInbox[] {
    const rows = this.db
      .prepare(
        `SELECT pod_id, inbox_id, email, display_name, client_id, created_at, updated_at
         FROM agentmail_inboxes
         WHERE workspace_id = ?
         ORDER BY email COLLATE NOCASE ASC`,
      )
      .all(workspaceId) as Array<{
      pod_id: string;
      inbox_id: string;
      email: string | null;
      display_name: string | null;
      client_id: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      podId: row.pod_id,
      inboxId: row.inbox_id,
      email: row.email || undefined,
      displayName: row.display_name || undefined,
      clientId: row.client_id || undefined,
      workspaceId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createInbox(
    workspaceId: string,
    input: { username?: string; domain?: string; displayName?: string; clientId?: string },
  ): Promise<AgentMailInbox> {
    const binding = this.ensureWorkspaceBinding(workspaceId);
    const inbox = mapInbox(
      await this.getClient().createPodInbox(binding.podId, input),
      workspaceId,
    );
    this.persistInboxes(workspaceId, binding.podId, [...this.listInboxes(workspaceId), inbox]);
    return inbox;
  }

  async updateInbox(
    workspaceId: string,
    inboxId: string,
    input: { displayName: string },
  ): Promise<AgentMailInbox> {
    this.ensureWorkspaceBinding(workspaceId);
    const inbox = mapInbox(await this.getClient().updateInbox(inboxId, input), workspaceId);
    await this.refreshWorkspace(workspaceId);
    return inbox;
  }

  async deleteInbox(workspaceId: string, inboxId: string): Promise<{ success: boolean }> {
    await this.getClient().deleteInbox(inboxId);
    this.db
      .prepare("DELETE FROM agentmail_inboxes WHERE workspace_id = ? AND inbox_id = ?")
      .run(workspaceId, inboxId);
    return { success: true };
  }

  listDomains(workspaceId: string): AgentMailDomain[] {
    const rows = this.db
      .prepare(
        `SELECT domain_id, workspace_id, pod_id, domain, status, feedback_enabled, records_json, client_id, created_at, updated_at
         FROM agentmail_domains
         WHERE workspace_id = ?
         ORDER BY domain COLLATE NOCASE ASC`,
      )
      .all(workspaceId) as Array<{
      domain_id: string;
      workspace_id: string;
      pod_id: string;
      domain: string | null;
      status: string | null;
      feedback_enabled: number;
      records_json: string | null;
      client_id: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      domainId: row.domain_id,
      domain: row.domain || undefined,
      status: row.status || undefined,
      feedbackEnabled: Boolean(row.feedback_enabled),
      records: parseJson(row.records_json, []),
      podId: row.pod_id,
      clientId: row.client_id || undefined,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createDomain(
    workspaceId: string,
    input: { domain: string; feedbackEnabled?: boolean },
  ): Promise<AgentMailDomain> {
    const binding = this.ensureWorkspaceBinding(workspaceId);
    const domain = mapDomain(
      await this.getClient().createPodDomain(binding.podId, {
        domain: input.domain,
        feedbackEnabled: input.feedbackEnabled ?? true,
      }),
      workspaceId,
    );
    await this.refreshWorkspace(workspaceId);
    return domain;
  }

  async verifyDomain(workspaceId: string, domainId: string): Promise<AgentMailDomain | null> {
    const binding = this.ensureWorkspaceBinding(workspaceId);
    await this.getClient().verifyPodDomain(binding.podId, domainId);
    const refreshed = await this.refreshWorkspace(workspaceId);
    return refreshed.domains.find((domain) => domain.domainId === domainId) || null;
  }

  async deleteDomain(workspaceId: string, domainId: string): Promise<{ success: boolean }> {
    const binding = this.ensureWorkspaceBinding(workspaceId);
    await this.getClient().deletePodDomain(binding.podId, domainId);
    this.db.prepare("DELETE FROM agentmail_domains WHERE domain_id = ?").run(domainId);
    return { success: true };
  }

  async listListEntries(
    workspaceId: string,
    options: {
      inboxId?: string;
      direction?: AgentMailListEntry["direction"];
      listType?: AgentMailListEntry["listType"];
    } = {},
  ): Promise<AgentMailListEntry[]> {
    const directions = options.direction
      ? [options.direction]
      : (["receive", "reply"] as AgentMailListEntry["direction"][]);
    const listTypes = options.listType
      ? [options.listType]
      : (["allow", "block"] as AgentMailListEntry["listType"][]);
    const client = this.getClient();
    const entries: AgentMailListEntry[] = [];

    for (const direction of directions) {
      for (const listType of listTypes) {
        const response = options.inboxId
          ? await client.listInboxLists(options.inboxId, direction, listType, 100)
          : await client.listLists(direction, listType, 100);
        const mapped = (Array.isArray(response.entries) ? response.entries : [])
          .map((entry) =>
            mapListEntry(entry, {
              direction,
              listType,
              inboxId: options.inboxId,
            }),
          )
          .filter((entry): entry is AgentMailListEntry => Boolean(entry));
        entries.push(...mapped);
      }
    }

    if (entries.length > 0) {
      this.persistListEntries(workspaceId, entries);
    }

    return entries.sort((a, b) => a.entry.localeCompare(b.entry));
  }

  async createListEntry(
    workspaceId: string,
    input: {
      inboxId?: string;
      direction: AgentMailListEntry["direction"];
      listType: AgentMailListEntry["listType"];
      entry: string;
      reason?: string;
    },
  ): Promise<AgentMailListEntry> {
    const payload = input.inboxId
      ? await this.getClient().createInboxListEntry(
          input.inboxId,
          input.direction,
          input.listType,
          {
            entry: input.entry,
            reason: input.reason,
          },
        )
      : await this.getClient().createListEntry(input.direction, input.listType, {
          entry: input.entry,
          reason: input.reason,
        });

    const entry = mapListEntry(payload, input);
    if (!entry) {
      throw new Error("AgentMail returned an invalid list entry payload.");
    }
    this.persistListEntries(workspaceId, [entry]);
    return entry;
  }

  async deleteListEntry(
    workspaceId: string,
    input: {
      inboxId?: string;
      direction: AgentMailListEntry["direction"];
      listType: AgentMailListEntry["listType"];
      entry: string;
    },
  ): Promise<{ success: boolean }> {
    if (input.inboxId) {
      await this.getClient().deleteInboxListEntry(
        input.inboxId,
        input.direction,
        input.listType,
        input.entry,
      );
    } else {
      await this.getClient().deleteListEntry(input.direction, input.listType, input.entry);
    }
    this.deleteListEntryRecord(
      workspaceId,
      input.inboxId,
      input.direction,
      input.listType,
      input.entry,
    );
    return { success: true };
  }

  async listInboxApiKeys(workspaceId: string, inboxId: string): Promise<AgentMailApiKeySummary[]> {
    const response = await this.getClient().listInboxApiKeys(inboxId);
    const keys = (Array.isArray(response.api_keys) ? response.api_keys : [])
      .map((item) => mapApiKey(item))
      .filter((item) => item.apiKeyId);
    this.persistApiKeys(workspaceId, inboxId, keys);
    return keys;
  }

  async createInboxApiKey(
    workspaceId: string,
    inboxId: string,
    input: { name?: string; permissions?: Record<string, boolean> },
  ): Promise<AgentMailApiKeySummary & { apiKey?: string }> {
    const response = await this.getClient().createInboxApiKey(inboxId, input);
    const summary = mapApiKey(response);
    this.persistApiKeys(workspaceId, inboxId, [summary]);
    return {
      ...summary,
      apiKey: asString(asObject(response)?.api_key),
    };
  }

  async deleteInboxApiKey(
    _workspaceId: string,
    inboxId: string,
    apiKeyId: string,
  ): Promise<{ success: boolean }> {
    await this.getClient().deleteInboxApiKey(inboxId, apiKeyId);
    this.db.prepare("DELETE FROM agentmail_api_keys WHERE api_key_id = ?").run(apiKeyId);
    return { success: true };
  }
}
