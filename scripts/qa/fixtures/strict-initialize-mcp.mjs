#!/usr/bin/env node
// A stdio MCP server that, like rmcp-based servers (e.g. codex-cu), requires `initialize`
// as the very first request and exits on anything else. Each start appends a line to
// STRICT_MCP_STARTS so tests can count launches.

import fs from "node:fs";
import readline from "node:readline";

if (process.env.STRICT_MCP_STARTS) fs.appendFileSync(process.env.STRICT_MCP_STARTS, "start\n");

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message ?? {};
  if (typeof method !== "string") return;
  if (!initialized && method !== "initialize") {
    process.stderr.write(`expect initialized request, but received: ${method}\n`);
    process.exit(1);
  }
  if (id === undefined) return;
  if (method === "initialize") {
    initialized = true;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "Strict initialize fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "strict_ping", description: "Replies pong.", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  write({ jsonrpc: "2.0", id, result: {} });
});
