import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";

afterEach(() => vi.restoreAllMocks());

describe("MCP 2026 event discovery", () => {
  it("waits for a slow modern server using the connection budget instead of sending initialize", async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          send({jsonrpc:'2.0',id:message.id,error:{code:-32022,message:'modern connection rejects initialize'}});
          return;
        }
        if (message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
          send({jsonrpc:'2.0',id:message.id,error:{code:-32022,message:'wrong protocol envelope'}});
          return;
        }
        if (message.method === 'server/discover') {
          setTimeout(() => send({jsonrpc:'2.0',id:message.id,result:{
            resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}}
          }}), 6000);
        }
        if (message.method === 'tools/list') {
          send({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'slow_ready',inputSchema:{type:'object'}}]}});
        }
      });`;
    const connection = new MCPServerConnection({
      id: "slow-modern",
      name: "Slow modern server",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      connectionTimeout: 10_000,
      requestTimeout: 1_000,
    });
    try {
      await connection.connect();
      expect(connection.getStatus().status).toBe("connected");
      expect(connection.getStatus().serverInfo?.protocolVersion).toBe("2026-07-28");
      expect(connection.getTools()).toContainEqual(expect.objectContaining({ name: "slow_ready" }));
    } finally {
      await connection.disconnect();
    }
  }, 15_000);

  it("closes a failed handshake transport so its child process is not left running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      onMessage: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      isConnected: () => true,
      setProtocolVersion: vi.fn(),
      sendRequest: vi.fn(async (method: string) => {
        throw new Error(method === "server/discover" ? "unknown method" : "handshake rejected");
      }),
    };
    const connection = new MCPServerConnection({
      id: "failed-handshake",
      name: "Failed handshake",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
    });
    vi.spyOn(connection as Any, "createTransport").mockReturnValue(transport);
    await expect(connection.connect()).rejects.toThrow("handshake rejected");
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(connection.getStatus().status).toBe("error");
  });

  it("uses per-request metadata and discovers events without an initialize handshake", async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'legacy handshake unsupported'}});
          return;
        }
        const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        if (version !== '2026-07-28') {
          send({jsonrpc:'2.0',id:message.id,error:{code:-32022,message:'wrong version'}});
          return;
        }
        if (message.method === 'server/discover') send({jsonrpc:'2.0',id:message.id,result:{
          resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}},
          _meta:{'io.modelcontextprotocol/serverInfo':{name:'events-fixture',version:'1'}}
        }});
        if (message.method === 'tools/list') send({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',tools:[]}});
        if (message.method === 'events/list') send({jsonrpc:'2.0',id:message.id,result:{resultType:'complete',events:[{
          name:'comment.created',delivery:['webhook'],inputSchema:{type:'object'},payloadSchema:{type:'object'}
        }]}});
      });`;
    const connection = new MCPServerConnection({
      id: "modern",
      name: "modern",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: ["-e", script],
      requestTimeout: 5000,
    });
    try {
      await connection.connect();
      expect(connection.getStatus().serverInfo?.protocolVersion).toBe("2026-07-28");
      expect(connection.getStatus().serverInfo?.capabilities?.events).toEqual({});
      const catalog = await connection.requestEventMethod("events/list");
      expect(catalog.events[0].name).toBe("comment.created");
    } finally {
      await connection.disconnect();
    }
  });
});
