#!/usr/bin/env node

import readline from "node:readline";

const MAX_LINE_BYTES = 16 * 1024;
const MAX_ECHO_LENGTH = 512;
const protocolVersion = "2025-06-18";

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

reader.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("browser-qa-mcp: ignored malformed JSON-RPC input\n");
    return;
  }

  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  const { id, method, params = {} } = message;
  if (id === undefined) return; // MCP notifications need no response.

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "CoWork Browser QA Echo", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "qa_echo",
            description: "Return a bounded synthetic QA message without accessing external data.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", maxLength: MAX_ECHO_LENGTH } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    if (params.name !== "qa_echo") {
      error(id, -32602, "Unknown QA fixture tool.");
      return;
    }
    const text = params.arguments?.text;
    if (typeof text !== "string" || text.length > MAX_ECHO_LENGTH) {
      error(id, -32602, "The QA echo input must be a string of at most 512 characters.");
      return;
    }
    write({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `qa_echo:${text}` }], isError: false },
    });
    return;
  }

  error(id, -32601, "Method not found.");
});
