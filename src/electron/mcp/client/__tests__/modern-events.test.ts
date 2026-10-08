import { describe, expect, it } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";

describe("MCP 2026 event discovery", () => {
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
