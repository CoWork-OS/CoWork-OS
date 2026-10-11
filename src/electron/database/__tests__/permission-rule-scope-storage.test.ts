import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { WorkspacePermissionRuleStore } from "../repositories";
import { PermissionEngine } from "../../agent/runtime/PermissionEngine";
import type { Workspace } from "../../../shared/types";

// Exercise the production SQL encoder/decoder against SQLite without requiring
// an Electron-specific native addon in the Node test process.
describe("permission scope SQLite persistence", () => {
  it("retains consent constraints after reconstructing the store", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE workspace_permission_rules (
        id TEXT PRIMARY KEY, workspace_id TEXT, effect TEXT, scope_kind TEXT,
        scope_tool_name TEXT, scope_path TEXT, scope_prefix TEXT, scope_server_name TEXT,
        metadata_json TEXT, created_at INTEGER, updated_at INTEGER)`);
      const workspace: Workspace = {
        id: "ws",
        name: "ws",
        path: "/tmp/ws",
        createdAt: 0,
        permissions: { read: true, write: true, delete: true, shell: true, network: true },
      };
      const request = {
        workspace,
        toolName: "http_request",
        mode: "default" as const,
        rules: [],
        toolInput: { url: "https://api.example.com", method: "GET" },
      };
      const scope = PermissionEngine.inferScope(request);
      const store = new WorkspacePermissionRuleStore(db as unknown as Database.Database);
      const created = store.create({
        workspaceId: "ws",
        effect: "allow",
        scope,
        metadata: { source: "approval" },
      });
      const reloaded = new WorkspacePermissionRuleStore(
        db as unknown as Database.Database,
      ).findById(created.id)!;
      expect(reloaded.scope).toEqual(scope);
      expect(reloaded.metadata).toEqual(created.metadata);
      expect(PermissionEngine.evaluate({ ...request, rules: [reloaded] }).decision).toBe("allow");
      expect(
        PermissionEngine.evaluate({
          ...request,
          rules: [reloaded],
          toolInput: { ...request.toolInput, method: "POST", body: "secret" },
        }).decision,
      ).toBe("ask");
      expect(
        PermissionEngine.evaluate({
          ...request,
          rules: [reloaded],
          toolInput: { ...request.toolInput, credentialId: "secret-1" },
        }).decision,
      ).toBe("ask");
      const browserScope = PermissionEngine.inferScope({
        ...request,
        toolName: "browser_navigate",
      });
      const browser = store.create({ workspaceId: "ws", effect: "allow", scope: browserScope });
      expect(store.findById(browser.id)?.scope).toEqual(browserScope);
      const legacy = store.create({
        workspaceId: "ws",
        effect: "allow",
        scope: { kind: "domain", domain: "api.example.com", toolName: "http_request" },
      });
      expect(store.findById(legacy.id)?.scope.effectClass).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
