import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";

const MANIFEST = {
  version: 1,
  connector: "crm",
  objects: [
    {
      type: "Deal",
      label: "Deal",
      keyField: "Id",
      fields: [
        { name: "Id", type: "id" },
        { name: "Stage", type: "enum", enum: ["Open", "Won"] },
      ],
    },
  ],
  tools: [
    { name: "crm.get_record", effect: "read", risk: "read", recordIdArg: "id" },
    { name: "crm.purge", effect: "delete", risk: "external_write" },
  ],
};

const TOOLS = [
  { name: "crm.get_record", inputSchema: { type: "object" } },
  {
    name: "crm.describe_objects",
    _meta: { "cowork.objectManifest": true },
    inputSchema: { type: "object" },
  },
];

function connected(respond: () => unknown = () => ({ content: [], structuredContent: MANIFEST })) {
  const connection = new MCPServerConnection({
    id: "crm",
    name: "crm",
    transport: "sse",
    enabled: true,
  });
  const transport = {
    sendRequest: vi.fn(async (method: string) =>
      method === "tools/list" ? { tools: TOOLS } : respond(),
    ),
    sendResponse: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
  };
  Object.assign(connection, { transport, status: "connected" });
  (connection as Any).setTools(TOOLS);
  return { connection, transport };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connector object manifest on a connection", () => {
  it("keeps the manifest tool out of the tools offered to callers", () => {
    const { connection } = connected();
    expect(connection.getTools().map((tool) => tool.name)).toEqual(["crm.get_record"]);
    expect(connection.getStatus().tools.map((tool) => tool.name)).toEqual(["crm.get_record"]);
  });

  it("reads the manifest once, validated against the server's other tools", async () => {
    const { connection, transport } = connected();

    const [first, second] = await Promise.all([
      connection.getObjectManifest(),
      connection.getObjectManifest(),
    ]);
    const third = await connection.getObjectManifest();

    expect(transport.sendRequest).toHaveBeenCalledTimes(1);
    expect(transport.sendRequest.mock.calls[0][1]).toEqual({
      name: "crm.describe_objects",
      arguments: {},
    });
    expect(first).toBe(second);
    expect(third).toBe(first);
    // crm.purge is not a tool the server lists.
    expect(first?.tools.map((tool) => tool.name)).toEqual(["crm.get_record"]);
  });

  it("checks the caller's gate before sending", async () => {
    const { connection, transport } = connected();
    const beforeSend = vi.fn(async () => {
      throw new Error("server blocked");
    });

    await expect(connection.getObjectManifest({ beforeSend })).resolves.toBeNull();
    expect(beforeSend).toHaveBeenCalled();
    expect(transport.sendRequest).not.toHaveBeenCalled();
  });

  it("gives null for an invalid manifest and retries after a minute", async () => {
    vi.useFakeTimers();
    let answer: unknown = { content: [], structuredContent: { version: 9 } };
    const { connection, transport } = connected(() => answer);

    await expect(connection.getObjectManifest()).resolves.toBeNull();
    await expect(connection.getObjectManifest()).resolves.toBeNull();
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);

    answer = { content: [{ type: "text", text: JSON.stringify(MANIFEST) }] };
    vi.advanceTimersByTime(61_000);
    await expect(connection.getObjectManifest()).resolves.toMatchObject({ connector: "crm" });
    expect(transport.sendRequest).toHaveBeenCalledTimes(2);
  });

  it("reads the manifest again after six hours or a new tool list", async () => {
    vi.useFakeTimers();
    const { connection, transport } = connected();

    await connection.getObjectManifest();
    vi.advanceTimersByTime(60 * 60 * 1000);
    await connection.getObjectManifest();
    expect(transport.sendRequest).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1);
    await connection.getObjectManifest();
    expect(transport.sendRequest).toHaveBeenCalledTimes(2);

    (connection as Any).setTools(TOOLS);
    await connection.getObjectManifest();
    expect(transport.sendRequest).toHaveBeenCalledTimes(3);
  });

  it("does not keep a manifest read for an older tool list", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const { connection, transport } = connected(() => pending);

    const stale = connection.getObjectManifest();
    (connection as Any).setTools(TOOLS);
    release({ content: [], structuredContent: MANIFEST });
    await stale;

    await connection.getObjectManifest();
    expect(transport.sendRequest).toHaveBeenCalledTimes(2);
  });

  it("gives null without a manifest tool or a connection", async () => {
    const { connection, transport } = connected();
    (connection as Any).setTools([TOOLS[0]]);
    await expect(connection.getObjectManifest()).resolves.toBeNull();

    (connection as Any).setTools(TOOLS);
    Object.assign(connection, { status: "disconnected" });
    await expect(connection.getObjectManifest()).resolves.toBeNull();
    expect(transport.sendRequest).not.toHaveBeenCalled();
  });
});
