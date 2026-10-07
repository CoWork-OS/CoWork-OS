import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACPAgentRegistry } from "../agent-registry";
import { registerACPMethods, shutdownACP, type ACPHandlerDeps } from "../handler";
import { RemoteAgentInvoker } from "../remote-invoker";
import {
  ACP_REMOTE_AGENT_SECRETS_CATEGORY,
  REMOTE_AGENT_SECRET_REF_KEY,
  SecureSettingsRemoteAgentSecretStore,
  createRemoteAgentSecretResolver,
  redactAcpControlPlanePayload,
  toPublicAgentCard,
  type RemoteAgentSecretStore,
  type RemoteAgentSecrets,
} from "../remote-agent-secrets";
import { ACPEvents, ACPMethods, type ACPAgentCard } from "../types";
import { DELETE_SECURE_SETTINGS } from "../../database/SecureSettingsRepository";
import { AcpStore } from "../acp-sql";

const nativeSqlite = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const TOKEN = "sk-live-acp-test-token-0123456789";
const HEADER = "Token header-secret-9876543210";

class MemorySecretStore implements RemoteAgentSecretStore {
  readonly entries = new Map<string, RemoteAgentSecrets>();
  failWrites = false;

  get(agentId: string) {
    return this.entries.get(agentId);
  }
  set(agentId: string, secrets: RemoteAgentSecrets) {
    if (this.failWrites) throw new Error("secure storage refused the write");
    this.entries.set(agentId, { ...secrets });
  }
  delete(agentId: string) {
    this.entries.delete(agentId);
  }
}

/** acp_agents only, plus the pragma the scrub write sets. */
class FakeAgentsDatabase {
  rows: Array<Record<string, unknown>> = [];
  pragmas: string[] = [];
  private secureDelete = 0;

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return fn;
  }

  pragma(statement: string, options?: { simple?: boolean }) {
    this.pragmas.push(statement);
    const match = /^secure_delete\s*=\s*(\w+)$/i.exec(statement.trim());
    if (match) {
      this.secureDelete = match[1].toUpperCase() === "ON" ? 1 : 0;
      return [];
    }
    if (statement.trim() === "secure_delete" && options?.simple) return this.secureDelete;
    throw new Error(`Unsupported pragma in test: ${statement}`);
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      all: () => {
        if (!normalized.includes("from acp_agents")) throw new Error(`Unsupported SQL: ${sql}`);
        return this.rows.map((row) => ({ id: row.id, card_json: row.card_json }));
      },
      run: (...args: unknown[]) => {
        if (normalized.startsWith("insert into acp_agents")) {
          const [id, origin, endpoint, name, provider, status, registeredAt, updatedAt, cardJson] =
            args;
          const next = {
            id,
            origin,
            endpoint,
            name,
            provider,
            status,
            registered_at: registeredAt,
            updated_at: updatedAt,
            card_json: cardJson,
            secure_delete: this.secureDelete,
          };
          const index = this.rows.findIndex((row) => row.id === id);
          if (index >= 0) this.rows[index] = next;
          else this.rows.push(next);
          return { changes: 1 };
        }
        if (normalized.startsWith("delete from acp_agents")) {
          this.rows = this.rows.filter((row) => row.id !== args[0]);
          return { changes: 1 };
        }
        throw new Error(`Unsupported SQL: ${sql}`);
      },
    };
  }
}

class MockServer {
  handlers = new Map<string, (client: Any, params?: unknown) => Promise<unknown>>();
  broadcast = vi.fn().mockReturnValue(1);

  registerMethod(method: string, handler: (client: Any, params?: unknown) => Promise<unknown>) {
    this.handlers.set(method, handler);
  }

  invoke(method: string, params?: unknown, client: Any = adminClient) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    return handler(client, params);
  }
}

const adminClient = { id: "admin", isAuthenticated: true, hasScope: () => true, isNode: false };
const readClient = {
  id: "reader",
  isAuthenticated: true,
  hasScope: (scope: string) => scope === "read",
  isNode: false,
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function plaintextCard(overrides: Partial<ACPAgentCard> = {}): ACPAgentCard {
  return {
    id: "remote:legacy-agent",
    name: "Legacy",
    description: "Registered before credential migration",
    version: "1.0.0",
    capabilities: [],
    endpoint: "https://agent.example.com/a2a",
    origin: "remote",
    registeredAt: 1,
    lastActiveAt: 1,
    status: "available",
    metadata: { bearerToken: TOKEN, team: "research" },
    ...overrides,
  };
}

function seedRow(db: FakeAgentsDatabase, card: ACPAgentCard): void {
  db.rows.push({
    id: card.id,
    origin: card.origin,
    endpoint: card.endpoint,
    name: card.name,
    status: card.status,
    registered_at: card.registeredAt,
    updated_at: card.registeredAt,
    card_json: JSON.stringify(card),
  });
}

describe("ACP remote agent credentials", () => {
  let store: MemorySecretStore;
  let db: FakeAgentsDatabase;

  beforeEach(() => {
    store = new MemorySecretStore();
    db = new FakeAgentsDatabase();
  });

  describe("registration", () => {
    it("stores the token in the secret store and only a reference on the card", async () => {
      const registry = new ACPAgentRegistry(db as Any, { secretStore: store });
      await registry.ready;

      const card = registry.registerRemoteAgent({
        name: "Secure Bot",
        description: "Needs auth",
        endpoint: "https://agent.example.com/a2a",
        metadata: { bearerToken: TOKEN, team: "research" },
      });
      await flush();

      expect(store.get(card.id)).toEqual({ bearerToken: TOKEN });
      expect(card.metadata).toEqual({
        team: "research",
        [REMOTE_AGENT_SECRET_REF_KEY]: {
          store: "secure-settings",
          category: ACP_REMOTE_AGENT_SECRETS_CATEGORY,
          agentId: card.id,
          fields: ["bearerToken"],
        },
      });
      expect(JSON.stringify(card)).not.toContain(TOKEN);
      expect(db.rows).toHaveLength(1);
      expect(String(db.rows[0].card_json)).not.toContain(TOKEN);
      expect(JSON.parse(String(db.rows[0].card_json)).metadata.bearerToken).toBeUndefined();
    });

    it("drops a caller-supplied credential reference", () => {
      const registry = new ACPAgentRegistry(undefined, { secretStore: store });
      const card = registry.registerRemoteAgent({
        name: "Spoof",
        description: "Points at another agent's secret",
        metadata: {
          [REMOTE_AGENT_SECRET_REF_KEY]: {
            store: "secure-settings",
            category: ACP_REMOTE_AGENT_SECRETS_CATEGORY,
            agentId: "remote:victim",
            fields: ["bearerToken"],
          },
        },
      });
      expect(card.metadata).toEqual({});
      expect(store.entries.size).toBe(0);
    });

    it("rejects the registration instead of persisting plaintext when secure storage fails", async () => {
      store.failWrites = true;
      const registry = new ACPAgentRegistry(db as Any, { secretStore: store });
      await registry.ready;

      expect(() =>
        registry.registerRemoteAgent({
          name: "Secure Bot",
          description: "Needs auth",
          metadata: { bearerToken: TOKEN },
        }),
      ).toThrow(/secure storage/);
      await flush();
      expect(registry.remoteAgentCount).toBe(0);
      expect(db.rows).toHaveLength(0);
    });

    it("deletes the stored credentials when the agent is unregistered", () => {
      const registry = new ACPAgentRegistry(undefined, { secretStore: store });
      const card = registry.registerRemoteAgent({
        name: "Secure Bot",
        description: "Needs auth",
        metadata: { authorizationHeader: HEADER },
      });
      expect(store.get(card.id)).toEqual({ authorizationHeader: HEADER });
      expect(registry.unregisterRemoteAgent(card.id)).toBe(true);
      expect(store.get(card.id)).toBeUndefined();
    });
  });

  describe("Control Plane payloads", () => {
    let server: MockServer;

    beforeEach(() => {
      shutdownACP();
      server = new MockServer();
      const deps: ACPHandlerDeps = {
        db: db as Any,
        requireScope: (client, scope) => {
          if (!client?.hasScope?.(scope)) {
            throw { code: "UNAUTHORIZED", message: `Missing required scope: ${scope}` };
          }
        },
        getActiveRoles: () => [],
        remoteAgentSecretStore: store,
      };
      registerACPMethods(server as Any, deps);
    });

    afterEach(() => {
      shutdownACP();
    });

    it("never returns or broadcasts the token from register, discover or agent.get", async () => {
      const registered = (await server.invoke(ACPMethods.AGENT_REGISTER, {
        name: "Secure Bot",
        description: "Needs auth",
        endpoint: "https://agent.example.com/a2a",
        metadata: { bearerToken: TOKEN, authorizationHeader: HEADER, team: "research" },
      })) as { agent: ACPAgentCard };
      const agentId = registered.agent.id;

      const discovered = await server.invoke(ACPMethods.DISCOVER, {}, readClient);
      const fetched = await server.invoke(ACPMethods.AGENT_GET, { agentId }, readClient);

      expect(server.broadcast).toHaveBeenCalledWith(ACPEvents.AGENT_REGISTERED, {
        agent: expect.objectContaining({ id: agentId }),
      });
      const broadcastPayload = server.broadcast.mock.calls.find(
        ([event]) => event === ACPEvents.AGENT_REGISTERED,
      )?.[1];

      for (const payload of [registered, discovered, fetched, broadcastPayload]) {
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain(TOKEN);
        expect(serialized).not.toContain(HEADER);
        expect(serialized).not.toContain('"bearerToken":');
        expect(serialized).not.toContain('"authorizationHeader":');
      }
      expect((fetched as { agent: ACPAgentCard }).agent.metadata).toMatchObject({
        team: "research",
        [REMOTE_AGENT_SECRET_REF_KEY]: { agentId, fields: ["authorizationHeader", "bearerToken"] },
      });
      await flush();
      expect(JSON.stringify(db.rows)).not.toContain(TOKEN);
      expect(store.get(agentId)).toEqual({ authorizationHeader: HEADER, bearerToken: TOKEN });
    });

    it("strips plaintext credentials of unmigrated cards from public payloads", () => {
      const card = plaintextCard({
        metadata: {
          bearerToken: TOKEN,
          nested: { apiKey: "nested-key", label: "kept" },
          maxTokens: 4096,
        },
      });
      const publicCard = toPublicAgentCard(card);
      expect(publicCard.metadata).toEqual({ nested: { label: "kept" }, maxTokens: 4096 });
      expect(card.metadata?.bearerToken).toBe(TOKEN);
    });
  });

  describe("renderer forwarding", () => {
    it("redacts ACP agent payloads from remote devices", () => {
      const legacy = plaintextCard({ metadata: { bearerToken: TOKEN, team: "a" } });
      const event = redactAcpControlPlanePayload(ACPEvents.AGENT_REGISTERED, { agent: legacy });
      const discover = redactAcpControlPlanePayload(ACPMethods.DISCOVER, { agents: [legacy] });
      const get = redactAcpControlPlanePayload(ACPMethods.AGENT_GET, { agent: legacy });
      for (const payload of [event, discover, get]) {
        expect(JSON.stringify(payload)).not.toContain(TOKEN);
      }
      expect((discover as { agents: ACPAgentCard[] }).agents[0].metadata).toEqual({ team: "a" });
    });

    it("leaves other payloads untouched", () => {
      const payload = { agent: { id: "x", metadata: { bearerToken: "unrelated" } } };
      expect(redactAcpControlPlanePayload("task.event", payload)).toBe(payload);
    });
  });

  describe("migration of plaintext card_json", () => {
    it("moves existing tokens into the secret store and scrubs card_json", async () => {
      seedRow(db, plaintextCard());
      const registry = new ACPAgentRegistry(db as Any, { secretStore: store });
      await registry.ready;

      expect(store.get("remote:legacy-agent")).toEqual({ bearerToken: TOKEN });
      expect(db.rows).toHaveLength(1);
      const persisted = JSON.parse(String(db.rows[0].card_json)) as ACPAgentCard;
      expect(String(db.rows[0].card_json)).not.toContain(TOKEN);
      expect(persisted.metadata).toMatchObject({
        team: "research",
        [REMOTE_AGENT_SECRET_REF_KEY]: { agentId: "remote:legacy-agent", fields: ["bearerToken"] },
      });
      // The rewrite ran with secure_delete on, and the previous setting was restored.
      expect(db.rows[0].secure_delete).toBe(1);
      expect(db.pragmas).toEqual(["secure_delete", "secure_delete = ON", "secure_delete = OFF"]);

      const loaded = registry.getAgent("remote:legacy-agent", []);
      expect(JSON.stringify(loaded)).not.toContain(TOKEN);
    });

    it.skipIf(!nativeSqlite)("scrubs a real SQLite row under secure_delete", () => {
      const sqlite = new nativeSqlite!(":memory:");
      try {
        sqlite.exec(`CREATE TABLE acp_agents (
          id TEXT PRIMARY KEY, origin TEXT NOT NULL, endpoint TEXT, name TEXT NOT NULL,
          provider TEXT, status TEXT NOT NULL, registered_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, card_json TEXT NOT NULL)`);
        const acpStore = new AcpStore(sqlite);
        acpStore.persistRemoteAgent(plaintextCard(), 1);
        const scrubbed = toPublicAgentCard(plaintextCard());
        // Units run inside a transaction; the pragma must work there too.
        sqlite.transaction(() => acpStore.scrubRemoteAgentCard(scrubbed, 2))();

        expect(JSON.stringify(acpStore.remoteAgentRows())).not.toContain(TOKEN);
        expect(sqlite.pragma("secure_delete", { simple: true })).toBe(0);
      } finally {
        sqlite.close();
      }
    });

    it("is a no-op for already migrated cards", async () => {
      seedRow(db, plaintextCard());
      await new ACPAgentRegistry(db as Any, { secretStore: store }).ready;
      const afterFirst = String(db.rows[0].card_json);
      db.pragmas = [];

      await new ACPAgentRegistry(db as Any, { secretStore: store }).ready;
      expect(String(db.rows[0].card_json)).toBe(afterFirst);
      expect(db.pragmas).toEqual([]);
    });

    it("keeps the card as it was when secure storage is unavailable, to retry later", async () => {
      seedRow(db, plaintextCard());
      store.failWrites = true;
      const registry = new ACPAgentRegistry(db as Any, { secretStore: store });
      await registry.ready;

      expect(store.entries.size).toBe(0);
      expect(String(db.rows[0].card_json)).toContain(TOKEN);
      expect(registry.getAgent("remote:legacy-agent", [])).toBeDefined();
    });
  });

  describe("invoker", () => {
    let server: Server | undefined;

    afterEach(async () => {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    async function startAgentServer(seen: IncomingHttpHeaders[]): Promise<string> {
      server = createServer((request, response) => {
        seen.push(request.headers);
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const payload = JSON.parse(body) as { id: string };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: { status: "running", taskId: "remote-1" },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/a2a`;
    }

    const task = { assigneeId: "x", title: "t", prompt: "p", workspaceId: "w" };

    it("still sends the Authorization header, resolved from the secret store", async () => {
      const seen: IncomingHttpHeaders[] = [];
      const endpoint = await startAgentServer(seen);
      const registry = new ACPAgentRegistry(undefined, { secretStore: store });
      const card = registry.registerRemoteAgent({
        name: "Secure Bot",
        description: "Needs auth",
        endpoint,
        metadata: { bearerToken: TOKEN },
      });
      const invoker = new RemoteAgentInvoker({
        resolveSecrets: createRemoteAgentSecretResolver(store),
      });

      const result = await invoker.invoke(card, task);

      expect(result).toMatchObject({ status: "running", remoteTaskId: "remote-1" });
      expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("sends a stored explicit authorization header after migration", async () => {
      const seen: IncomingHttpHeaders[] = [];
      const endpoint = await startAgentServer(seen);
      seedRow(
        db,
        plaintextCard({ endpoint, metadata: { authorizationHeader: HEADER, bearerToken: TOKEN } }),
      );
      const registry = new ACPAgentRegistry(db as Any, { secretStore: store });
      await registry.ready;
      const card = registry.getAgent("remote:legacy-agent", [])!;
      const invoker = new RemoteAgentInvoker({
        resolveSecrets: createRemoteAgentSecretResolver(store),
      });

      await invoker.invoke(card, task);
      expect(seen[0].authorization).toBe(HEADER);
    });

    it("never reads credentials from the card itself", async () => {
      const seen: IncomingHttpHeaders[] = [];
      const endpoint = await startAgentServer(seen);
      const invoker = new RemoteAgentInvoker({ resolveSecrets: () => undefined });

      await invoker.invoke(plaintextCard({ endpoint }), task);
      expect(seen[0].authorization).toBeUndefined();
    });

    it("fails closed when a referenced credential cannot be resolved", async () => {
      const seen: IncomingHttpHeaders[] = [];
      const endpoint = await startAgentServer(seen);
      const registry = new ACPAgentRegistry(undefined, { secretStore: store });
      const card = registry.registerRemoteAgent({
        name: "Secure Bot",
        description: "Needs auth",
        endpoint,
        metadata: { bearerToken: TOKEN },
      });
      store.entries.clear();
      const invoker = new RemoteAgentInvoker({
        resolveSecrets: createRemoteAgentSecretResolver(store),
      });

      await expect(invoker.invoke(card, task)).rejects.toThrow(/Credentials .* unavailable/);
      expect(seen).toHaveLength(0);
    });
  });

  describe("SecureSettingsRemoteAgentSecretStore", () => {
    function fakeRepository() {
      let value: object | undefined;
      const repository = {
        category: undefined as string | undefined,
        loadWithStatus: (category: string) => {
          repository.category = category;
          return value
            ? { status: "success", data: structuredClone(value) }
            : { status: "not_found" };
        },
        update: (category: string, mutate: (current: Any) => Any) => {
          repository.category = category;
          const next = mutate(value ? structuredClone(value) : undefined);
          if (next === DELETE_SECURE_SETTINGS) value = undefined;
          else if (next !== undefined) value = next;
          return { value, revision: 1 };
        },
        snapshot: () => value,
      };
      return repository;
    }

    it("keeps each agent's credentials under its id in the ACP category", () => {
      const repository = fakeRepository();
      const secureStore = new SecureSettingsRemoteAgentSecretStore(() => repository as Any);

      secureStore.set("remote:a", { bearerToken: TOKEN });
      secureStore.set("remote:b", { authorizationHeader: HEADER });

      expect(repository.category).toBe(ACP_REMOTE_AGENT_SECRETS_CATEGORY);
      expect(secureStore.get("remote:a")).toEqual({ bearerToken: TOKEN });
      expect(secureStore.get("remote:b")).toEqual({ authorizationHeader: HEADER });
      expect(secureStore.get("remote:missing")).toBeUndefined();

      secureStore.delete("remote:a");
      expect(secureStore.get("remote:a")).toBeUndefined();
      secureStore.delete("remote:b");
      expect(repository.snapshot()).toBeUndefined();
    });

    it("refuses to read when the stored category is unreadable", () => {
      const secureStore = new SecureSettingsRemoteAgentSecretStore(
        () => ({ loadWithStatus: () => ({ status: "decryption_failed" }) }) as Any,
      );
      expect(() => secureStore.get("remote:a")).toThrow(/unreadable/);
    });
  });
});
