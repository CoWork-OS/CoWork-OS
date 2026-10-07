/**
 * Supermemory remote ids (audit SEC-17): mirrored writes keep their remote id, local
 * deletes / suppression / privacy changes forget the remote copy, "Disconnect & purge"
 * deletes every recorded copy before disabling, and 4xx answers do not trip the circuit
 * breaker. The HTTP layer is a mocked `fetch`; the mapping lives in in-memory SQLite.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupermemorySettings } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  settings: undefined as SupermemorySettings | undefined,
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      load: () => mocks.settings,
      save: (_key: string, value: SupermemorySettings) => {
        mocks.settings = value;
      },
    }),
  },
}));
vi.mock("../MemoryWriteGate", () => ({
  MemoryWriteGate: { evaluate: vi.fn(async () => ({ allowed: true })) },
}));

import {
  SupermemoryService,
  countsTowardCircuitBreaker,
  SupermemoryRequestError,
} from "../SupermemoryService";
import { SupermemoryRemoteRefRepository } from "../SupermemoryRemoteRefRepository";
import { ensureSupermemoryRemoteRefsSchema } from "../supermemory-remote-refs-sql";
import { createMemoryItemsTestDb, nativeSqliteAvailable } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function jsonResponse(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const workspace = { id: "ws-1", name: "Atlas" };

describeWithSqlite("Supermemory remote ids (SEC-17)", () => {
  let db: Database.Database;
  let calls: FetchCall[];
  let respond: (call: FetchCall) => ReturnType<typeof jsonResponse>;

  const refs = () =>
    db
      .prepare(
        "SELECT local_ref, remote_id, remote_kind, container_tag FROM supermemory_remote_refs ORDER BY id",
      )
      .all() as Array<Record<string, string>>;

  beforeEach(async () => {
    mocks.settings = {
      enabled: true,
      apiKey: "sm_test",
      containerTagTemplate: "cowork:{workspaceName}",
    };
    SupermemoryService.clearCache();
    (SupermemoryService as Any).recordSuccess();
    db = await createMemoryItemsTestDb(["ws-1"]);
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, workspace_id TEXT, content TEXT, is_private INTEGER DEFAULT 0);
      CREATE TABLE memory_observation_metadata (memory_id TEXT PRIMARY KEY, privacy_state TEXT);
    `);
    ensureSupermemoryRemoteRefsSchema(db);
    SupermemoryRemoteRefRepository.initialize(db);
    calls = [];
    let documentSeq = 0;
    respond = (call) => {
      if (call.method === "POST" && call.url.endsWith("/v3/documents")) {
        documentSeq += 1;
        return jsonResponse(200, { id: `doc-${documentSeq}`, status: "queued" });
      }
      if (call.method === "POST" && call.url.endsWith("/v4/memories")) {
        return jsonResponse(200, { memories: [{ id: "mem-1" }] });
      }
      if (call.method === "DELETE" && call.url.endsWith("/v4/memories")) {
        return jsonResponse(200, { id: call.body?.id, forgotten: true });
      }
      return jsonResponse(200, {});
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const call: FetchCall = {
          url,
          method: String(init?.method || "GET"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        };
        calls.push(call);
        return respond(call);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    SupermemoryRemoteRefRepository.setInstance(null);
    db.close();
  });

  const mirror = async (memoryId: string) => {
    db.prepare("INSERT INTO memories (id, workspace_id, content) VALUES (?, 'ws-1', 'x')").run(
      memoryId,
    );
    await SupermemoryService.mirrorMemory({
      workspace,
      taskId: "task-1",
      memoryType: "observation",
      content: `content of ${memoryId}`,
      localRef: `archive:${memoryId}`,
    });
  };

  it("records the remote id and container of a mirrored archive row", async () => {
    await mirror("m-1");
    expect(refs()).toEqual([
      {
        local_ref: "archive:m-1",
        remote_id: "doc-1",
        remote_kind: "document",
        container_tag: "cowork:Atlas",
      },
    ]);
    expect(calls[0].body?.containerTag).toBe("cowork:Atlas");
  });

  it("forgets remote copies of deleted, suppressed and private rows, and keeps live ones", async () => {
    await mirror("m-1");
    await mirror("m-2");
    await mirror("m-3");
    await mirror("m-4");
    db.prepare("DELETE FROM memories WHERE id = 'm-1'").run();
    db.prepare(
      "INSERT INTO memory_observation_metadata (memory_id, privacy_state) VALUES ('m-2', 'suppressed')",
    ).run();
    db.prepare("UPDATE memories SET is_private = 1 WHERE id = 'm-3'").run();
    calls = [];

    const result = await SupermemoryService.sweepOrphanedCopies();
    expect(result).toMatchObject({ forgotten: 3, failed: 0 });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "DELETE /v3/documents/doc-1",
      "DELETE /v3/documents/doc-2",
      "DELETE /v3/documents/doc-3",
    ]);
    expect(refs().map((row) => row.local_ref)).toEqual(["archive:m-4"]);
  });

  it("treats a 404 as already forgotten and keeps the mapping on other failures", async () => {
    await mirror("m-1");
    await mirror("m-2");
    db.prepare("DELETE FROM memories").run();
    respond = (call) =>
      call.url.endsWith("doc-1") ? jsonResponse(404, { error: "not found" }) : jsonResponse(503);
    const result = await SupermemoryService.sweepOrphanedCopies();
    expect(result).toMatchObject({ forgotten: 1, failed: 1 });
    expect(refs().map((row) => row.remote_id)).toEqual(["doc-2"]);
  });

  it("forgets the copy of a deleted memory item", async () => {
    await SupermemoryRemoteRefRepository.get()!.record({
      localRef: "memory:item-gone",
      remoteId: "doc-x",
      remoteKind: "document",
      containerTag: "cowork:Atlas",
      workspaceId: "ws-1",
      createdAt: 1,
    });
    const result = await SupermemoryService.sweepOrphanedCopies();
    expect(result).toMatchObject({ forgotten: 1 });
    expect(refs()).toEqual([]);
  });

  it("keeps remote-only remembers out of the orphan sweep and drops them on forget", async () => {
    const remembered = await SupermemoryService.remember({
      workspace,
      content: "Prefers tea",
      taskId: "task-1",
      skipMemoryWriteGate: true,
    });
    expect(remembered.memoryIds).toEqual(["mem-1"]);
    expect(refs()).toEqual([
      {
        local_ref: "external:mem-1",
        remote_id: "mem-1",
        remote_kind: "memory",
        container_tag: "cowork:Atlas",
      },
    ]);
    expect(await SupermemoryService.sweepOrphanedCopies()).toMatchObject({ forgotten: 0 });
    expect(refs()).toHaveLength(1);

    await SupermemoryService.forget({ workspace, memoryId: "mem-1" });
    expect(refs()).toEqual([]);
  });

  it("redacts secrets and honours <no-memory> before an explicit remember leaves the device", async () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    await SupermemoryService.remember({
      workspace,
      content: `Deploys use the bot account with ${token}`,
      skipMemoryWriteGate: true,
    });
    const sent = calls.find((call) => call.url.endsWith("/v4/memories"));
    const memories = sent?.body?.memories as Array<{ content: string }>;
    expect(memories[0].content).not.toContain(token);
    expect(memories[0].content).toContain("[REDACTED_SECRET]");

    calls = [];
    const optedOut = await SupermemoryService.remember({
      workspace,
      content: "Prefers tea <no-memory>",
      skipMemoryWriteGate: true,
    });
    expect(optedOut).toMatchObject({ blocked: true, memoryIds: [] });
    const secretOnly = await SupermemoryService.remember({
      workspace,
      content: token,
      skipMemoryWriteGate: true,
    });
    expect(secretOnly).toMatchObject({ blocked: true, memoryIds: [] });
    expect(calls).toEqual([]);
  });

  it("does not sweep while Supermemory is disconnected", async () => {
    await mirror("m-1");
    db.prepare("DELETE FROM memories").run();
    mocks.settings = { ...mocks.settings!, enabled: false };
    SupermemoryService.clearCache();
    calls = [];
    expect(await SupermemoryService.sweepOrphanedCopies()).toBeNull();
    expect(calls).toEqual([]);
    expect(refs()).toHaveLength(1);
  });

  it("forgets every copy of a cleared workspace", async () => {
    await mirror("m-1");
    await SupermemoryService.remember({
      workspace,
      content: "Prefers tea",
      skipMemoryWriteGate: true,
    });
    const result = await SupermemoryService.forgetWorkspaceCopies("ws-1");
    expect(result).toMatchObject({ forgotten: 2, failed: 0 });
    expect(refs()).toEqual([]);
    const deleteMemory = calls.find(
      (call) => call.method === "DELETE" && call.url.endsWith("/v4/memories"),
    );
    expect(deleteMemory?.body).toEqual({ containerTag: "cowork:Atlas", id: "mem-1" });
  });

  describe("Disconnect & purge", () => {
    it("deletes every recorded copy, then disables the integration", async () => {
      await mirror("m-1");
      await SupermemoryService.remember({
        workspace,
        content: "Prefers tea",
        skipMemoryWriteGate: true,
      });
      const result = await SupermemoryService.disconnectAndPurge();
      expect(result).toMatchObject({ success: true, disabled: true, forgotten: 2, failed: 0 });
      expect(refs()).toEqual([]);
      expect(mocks.settings?.enabled).toBe(false);
      // The API key is kept, so the user can reconnect.
      expect(mocks.settings?.apiKey).toBe("sm_test");
    });

    it("stays connected when a copy cannot be deleted", async () => {
      await mirror("m-1");
      respond = () => jsonResponse(500, { error: "boom" });
      const result = await SupermemoryService.disconnectAndPurge();
      expect(result).toMatchObject({ success: false, disabled: false, failed: 1 });
      expect(result.error).toContain("could not be deleted");
      expect(mocks.settings?.enabled).toBe(true);
      expect(refs()).toHaveLength(1);
    });

    it("refuses while disconnected when copies are on record", async () => {
      await mirror("m-1");
      mocks.settings = { ...mocks.settings!, enabled: false };
      SupermemoryService.clearCache();
      const result = await SupermemoryService.disconnectAndPurge();
      expect(result).toMatchObject({ success: false, disabled: false, failed: 1 });
      expect(refs()).toHaveLength(1);
    });
  });

  describe("circuit breaker", () => {
    it("does not open on 4xx answers, but does on 5xx and 429", async () => {
      respond = () => jsonResponse(400, { error: "bad request" });
      for (let i = 0; i < 4; i += 1) {
        await expect(SupermemoryService.forget({ workspace, memoryId: "x" })).rejects.toThrow(
          /400/,
        );
      }
      expect(SupermemoryService.getConfigStatus().circuitBreakerUntil).toBeNull();

      respond = () => jsonResponse(503);
      for (let i = 0; i < 3; i += 1) {
        await expect(SupermemoryService.forget({ workspace, memoryId: "x" })).rejects.toThrow(
          /503/,
        );
      }
      expect(SupermemoryService.getConfigStatus().circuitBreakerUntil).toBeGreaterThan(0);
    });

    it("classifies errors", () => {
      expect(countsTowardCircuitBreaker(new SupermemoryRequestError("x", 404))).toBe(false);
      expect(countsTowardCircuitBreaker(new SupermemoryRequestError("x", 401))).toBe(false);
      expect(countsTowardCircuitBreaker(new SupermemoryRequestError("x", 429))).toBe(true);
      expect(countsTowardCircuitBreaker(new SupermemoryRequestError("x", 408))).toBe(true);
      expect(countsTowardCircuitBreaker(new SupermemoryRequestError("x", 502))).toBe(true);
      expect(countsTowardCircuitBreaker(new Error("network down"))).toBe(true);
    });
  });
});
