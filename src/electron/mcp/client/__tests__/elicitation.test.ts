import { describe, expect, it, vi } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";
import type { MCPToolCallOptions } from "../../types";

const approval = {
  message: 'Allow Computer Use to use "Calculator"?',
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture() {
  const connection = new MCPServerConnection({
    id: "test",
    name: "codex-cu",
    transport: "stdio",
    enabled: true,
  });
  const toolResult = deferred<Any>();
  const transport = {
    sendRequest: vi.fn(() => toolResult.promise),
    sendResponse: vi.fn(async () => {}),
  };
  Object.assign(connection, {
    transport,
    status: "connected",
    tools: [{ name: "js" }],
  });
  const elicit = (params: Any = approval) =>
    (connection as Any).handleServerRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "elicitation/create",
      params,
    });
  return { connection, transport, toolResult, elicit };
}

describe("MCP approval form elicitation", () => {
  it("round-trips an approval through a real stdio server even when request IDs collide", async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
      let callId;
      rl.on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{
          protocolVersion:'2025-06-18', serverInfo:{name:'fixture',version:'1'},
          capabilities:{tools:{}}, receivedCapabilities:m.params.capabilities
        }});
        if (m.method === 'tools/list') send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'js',inputSchema:{type:'object'}}]}});
        if (m.method === 'tools/call') {
          callId = m.id;
          send({jsonrpc:'2.0', id:m.id, method:'elicitation/create', params:${JSON.stringify(approval)}});
        }
        if (!m.method && m.id === callId) send({jsonrpc:'2.0',id:callId,result:{content:[{type:'text',text:JSON.stringify(m.result)}]}});
      });`;
    const connection = new MCPServerConnection({
      id: "fixture",
      name: "fixture",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      requestTimeout: 5000,
    });
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: {} }));
    try {
      await connection.connect();
      const result = await connection.callTool("js", {}, { onElicitation });
      expect(result.content).toEqual([{ type: "text", text: '{"action":"accept","content":{}}' }]);
      expect(onElicitation).toHaveBeenCalledWith(approval);
    } finally {
      await connection.disconnect();
    }
  });

  it("advertises form elicitation only when the transport can reply to server requests", async () => {
    const { connection, transport } = fixture();
    transport.sendRequest.mockResolvedValue({ serverInfo: {}, capabilities: {} });
    (transport as Any).send = vi.fn();
    await (connection as Any).initialize();
    expect(
      transport.sendRequest.mock.calls.find(([method]) => method === "initialize")?.[1]
        .capabilities,
    ).toEqual({
      elicitation: { form: {} },
    });
    delete (transport as Any).sendResponse;
    transport.sendRequest.mockClear();
    await (connection as Any).initialize();
    expect(
      transport.sendRequest.mock.calls.find(([method]) => method === "initialize")?.[1]
        .capabilities,
    ).toEqual({});
  });

  it.each([
    { ...approval, mode: "url", url: "https://example.com" },
    {
      ...approval,
      requestedSchema: { type: "object", properties: { password: { type: "string" } } },
    },
    { ...approval, requestedSchema: { type: "object", properties: {}, required: ["missing"] } },
  ])("cancels unsupported forms without asking or accepting", async (params) => {
    const { connection, transport, toolResult, elicit } = fixture();
    const onElicitation = vi.fn();
    const call = connection.callTool("js", {}, { onElicitation });
    await vi.waitFor(() => expect(transport.sendRequest).toHaveBeenCalled());
    await elicit(params);
    expect(onElicitation).not.toHaveBeenCalled();
    expect(transport.sendResponse).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 2,
      result: { action: "cancel" },
    });
    toolResult.resolve({ content: [] });
    await call;
  });

  it("cancels an unsolicited request when no task owns the call", async () => {
    const { transport, elicit } = fixture();
    await elicit();
    expect(transport.sendResponse).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 2,
      result: { action: "cancel" },
    });
  });

  it.each(["decline", "cancel"] as const)("preserves a human %s decision", async (action) => {
    const { connection, transport, toolResult, elicit } = fixture();
    const call = connection.callTool("js", {}, { onElicitation: async () => ({ action }) });
    await vi.waitFor(() => expect(transport.sendRequest).toHaveBeenCalled());
    await elicit();
    expect(transport.sendResponse).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 2,
      result: { action },
    });
    toolResult.resolve({ content: [] });
    await call;
  });

  it("never applies a late approval to a subsequent task", async () => {
    const { connection, transport, toolResult, elicit } = fixture();
    const answer = deferred<Any>();
    const first = connection.callTool("js", {}, { onElicitation: () => answer.promise });
    await vi.waitFor(() => expect(transport.sendRequest).toHaveBeenCalledTimes(1));
    const elicitation = elicit();
    const secondHandler = vi.fn(async () => ({ action: "decline" as const }));
    const second = connection.callTool("js", {}, { onElicitation: secondHandler });
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    toolResult.resolve({ content: [] });
    await first;
    await second;
    answer.resolve({ action: "accept" });
    await elicitation;
    expect(transport.sendResponse).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 2,
      result: { action: "cancel" },
    });
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it("cancels an approval when tool execution is aborted", async () => {
    const { connection, transport, toolResult, elicit } = fixture();
    const controller = new AbortController();
    const options: MCPToolCallOptions = {
      signal: controller.signal,
      onElicitation: async () => {
        controller.abort();
        return { action: "accept" };
      },
    };
    const call = connection.callTool("js", {}, options);
    await vi.waitFor(() => expect(transport.sendRequest).toHaveBeenCalled());
    await elicit();
    expect(transport.sendResponse).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 2,
      result: { action: "cancel" },
    });
    toolResult.resolve({ content: [] });
    await call;
  });
});

it("recognizes app metadata only for the configured Codex driver, with a matching app consent message", async () => {
  const { connection, elicit, toolResult } = fixture();
  const onElicitation = vi.fn(async () => ({ action: "accept" as const }));
  const params = {
    ...approval,
    _meta: {
      connector_id: "computer-use",
      codex_approval_kind: "mcp_tool_call",
      tool_params: { app: "com.apple.calculator" },
      tool_params_display: [{ name: "app", value: "Calculator" }],
    },
  };
  let call = connection.callTool("js", {}, { onElicitation });
  await Promise.resolve();
  await elicit(params);
  expect(onElicitation.mock.calls[0][0].computerUseApp).toBeUndefined();
  toolResult.resolve({ content: [] });
  await call;
  const second = fixture();
  Object.assign((second.connection as Any).config, {
    args: ["/local/@oai/cua-repl/bin/cua-repl.mjs"],
    env: { CUA_REPL_ENABLED_SURFACES: "computer" },
  });
  onElicitation.mockClear();
  call = second.connection.callTool("js", {}, { onElicitation });
  await Promise.resolve();
  await second.elicit(params);
  expect(onElicitation.mock.calls[0][0].computerUseApp).toEqual({
    id: "com.apple.calculator",
    name: "Calculator",
  });
  await second.elicit({ ...params, message: "Allow Computer Use to record computer audio?" });
  expect(onElicitation.mock.calls.at(-1)![0].computerUseApp).toBeUndefined();
  await second.elicit({ ...params, _meta: { ...params._meta, tool_params_display: "malformed" } });
  expect(onElicitation.mock.calls.at(-1)![0].computerUseApp).toBeUndefined();
  second.toolResult.resolve({ content: [] });
  await call;
});

describe("MCP transport admission after delayed startup", () => {
  it.each(["stdio", "sse", "http", "websocket"])(
    "runs the current effect guard before %s sends any tool request",
    async (transportType) => {
      const f = fixture();
      f.transport.sendRequest.mockResolvedValue({ content: [] });
      (f.connection as Any).config.transport = transportType;
      const beforeSend = vi.fn(async () => {
        throw new Error("Revoked before send");
      });
      await expect(f.connection.callTool("js", {}, { beforeSend } as Any)).rejects.toThrow(
        "Revoked before send",
      );
      expect(beforeSend).toHaveBeenCalledOnce();
      expect(f.transport.sendRequest).not.toHaveBeenCalled();
    },
  );
  it("rechecks a queued stdio call after another task finishes", async () => {
    const f = fixture();
    const first = f.connection.callTool("js", {});
    await vi.waitFor(() => expect(f.transport.sendRequest).toHaveBeenCalledOnce());
    const beforeSend = vi.fn(async () => {
      throw new Error("Task stopped in queue");
    });
    const second = f.connection.callTool("js", {}, { beforeSend } as Any);
    const rejection = expect(second).rejects.toThrow("Task stopped in queue");
    expect(beforeSend).not.toHaveBeenCalled();
    f.toolResult.resolve({ content: [] });
    await first;
    await rejection;
    expect(f.transport.sendRequest).toHaveBeenCalledOnce();
    expect((f.connection as Any).activeToolCall).toBeNull();
    f.transport.sendRequest.mockResolvedValue({ content: [] });
    await f.connection.callTool("js", {});
    expect(f.transport.sendRequest).toHaveBeenCalledTimes(2);
  });
  it.each(["abort", "disconnect", "replace"])(
    "does not send after %s during the effect guard",
    async (change) => {
      const f = fixture();
      f.transport.sendRequest.mockResolvedValue({ content: [] });
      const controller = new AbortController();
      const replacement = { sendRequest: vi.fn() };
      const beforeSend = async () => {
        if (change === "abort") controller.abort();
        if (change === "disconnect") (f.connection as Any).status = "disconnected";
        if (change === "replace") (f.connection as Any).transport = replacement;
      };
      await expect(
        f.connection.callTool("js", {}, { beforeSend, signal: controller.signal } as Any),
      ).rejects.toThrow();
      expect(f.transport.sendRequest).not.toHaveBeenCalled();
      expect(replacement.sendRequest).not.toHaveBeenCalled();
    },
  );
  it("checks abort for non-stdio tools as well as queued stdio calls", async () => {
    const f = fixture();
    f.transport.sendRequest.mockResolvedValue({ content: [] });
    (f.connection as Any).config.transport = "http";
    const controller = new AbortController();
    controller.abort();
    await expect(f.connection.callTool("js", {}, { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(f.transport.sendRequest).not.toHaveBeenCalled();
  });
});

it("carries the connection guard into a transport that finishes setup after admission", async () => {
  const f = fixture();
  const beforeSend = vi.fn(async () => {});
  const wire = vi.fn();
  f.transport.sendRequest.mockImplementation(async (...args: Any[]) => {
    const options = args[2];
    (f.connection as Any).status = "disconnected";
    await options.beforeSend();
    wire();
    return { content: [] };
  });
  await expect(f.connection.callTool("js", {}, { beforeSend })).rejects.toThrow(
    "connection or tool changed",
  );
  expect(beforeSend).toHaveBeenCalledTimes(2);
  expect(wire).not.toHaveBeenCalled();
});
