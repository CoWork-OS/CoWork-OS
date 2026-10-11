import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";
import { legacyOnlyServers } from "../legacy-only-servers";
import type { MCPServerConfig } from "../../types";

describe("servers that require initialize first", () => {
  let connection: MCPServerConnection | null = null;
  const dir = fs.mkdtempSync(join(os.tmpdir(), "strict-mcp-"));
  const starts = join(dir, "starts.log");
  const remembered = join(dir, "initialize-only.json");

  beforeAll(() => legacyOnlyServers.persistTo(remembered));

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  const config = (): MCPServerConfig => ({
    id: "strict-initialize-fixture",
    name: "Strict initialize",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: [resolve(process.cwd(), "scripts/qa/fixtures/strict-initialize-mcp.mjs")],
    env: { STRICT_MCP_STARTS: starts },
    requestTimeout: 3_000,
  });
  const startCount = () =>
    fs.existsSync(starts) ? fs.readFileSync(starts, "utf8").trim().split("\n").length : 0;

  it("restarts a server that exits on discovery and connects with initialize", async () => {
    connection = new MCPServerConnection(config(), {
      maxReconnectAttempts: 0,
      reconnectDelayMs: 100,
    });
    await connection.connect();
    expect(connection.getTools()).toContainEqual(expect.objectContaining({ name: "strict_ping" }));
    // Probed once (it exited), then started again for the classic handshake.
    expect(startCount()).toBe(2);
    // Saved for the next launch, as a hash only.
    const saved = fs.readFileSync(remembered, "utf8");
    expect(Object.keys(JSON.parse(saved).servers)).toHaveLength(1);
    expect(saved).not.toContain("strict-initialize-mcp");
  });

  it("goes straight to initialize the next time", async () => {
    const before = startCount();
    connection = new MCPServerConnection(config(), {
      maxReconnectAttempts: 0,
      reconnectDelayMs: 100,
    });
    await connection.connect();
    expect(connection.getTools()).toContainEqual(expect.objectContaining({ name: "strict_ping" }));
    expect(startCount() - before).toBe(1);
  });
});
