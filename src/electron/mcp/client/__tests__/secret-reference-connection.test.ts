import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "../../types";

const reference = "op://Dev/Fixture/start log";
const dir = fs.mkdtempSync(join(os.tmpdir(), "vault-ref-mcp-"));
const startLog = join(dir, "starts.log");
const resolveRecord = vi.fn(async (record?: Record<string, string>) =>
  record
    ? Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, value === reference ? startLog : value]),
      )
    : record,
);

vi.mock("../../../security/secret-references/resolver", () => ({
  getSecretReferenceResolver: () => ({ resolveRecord }),
}));

const { MCPServerConnection } = await import("../MCPServerConnection");

describe("an MCP server whose env holds a vault reference", () => {
  let connection: InstanceType<typeof MCPServerConnection> | null = null;
  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  it("starts with the resolved value, also when it reconnects, and keeps the reference", async () => {
    const config: MCPServerConfig = {
      id: "vault-reference-fixture",
      name: "Vault reference fixture",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [resolve(process.cwd(), "scripts/qa/fixtures/strict-initialize-mcp.mjs")],
      env: { STRICT_MCP_STARTS: reference },
      requestTimeout: 3_000,
    };
    connection = new MCPServerConnection(config, {
      maxReconnectAttempts: 0,
      reconnectDelayMs: 100,
    });
    await connection.connect();

    expect(connection.getTools()).toContainEqual(expect.objectContaining({ name: "strict_ping" }));
    // The fixture appends a line per launch to the path it gets: the resolved one.
    expect(fs.readFileSync(startLog, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(join(process.cwd(), reference))).toBe(false);
    expect(config.env?.STRICT_MCP_STARTS).toBe(reference);
    expect(resolveRecord).toHaveBeenCalledWith(config.env);
  });
});
