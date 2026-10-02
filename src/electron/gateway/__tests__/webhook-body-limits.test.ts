import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { LineClient } from "../channels/line-client";
import { TeamsAdapter } from "../channels/teams";
import { GoogleChatAdapter } from "../channels/google-chat";
import { FeishuAdapter } from "../channels/feishu";
import { WeComAdapter } from "../channels/wecom";
import {
  readLimitedBody,
  DEFAULT_WEBHOOK_BODY_LIMIT_BYTES,
} from "../channels/webhook-channel-utils";

const state = vi.hoisted(() => ({ handler: undefined as Any }));
vi.mock("http", async () => {
  const actual = await vi.importActual<typeof import("http")>("http");
  return {
    ...actual,
    createServer: vi.fn((handler) => {
      state.handler = handler;
      const server = new EventEmitter() as Any;
      server.listen = (_port: number, cb: () => void) => cb();
      return server;
    }),
  };
});

async function setup(channel: string) {
  let adapter: Any;
  let path: string;
  let downstream: Any;
  if (channel === "line") {
    adapter = new LineClient({
      channelAccessToken: "token",
      channelSecret: "secret",
      webhookPath: "/line",
    });
    vi.spyOn(adapter, "verifySignature").mockReturnValue(true);
    downstream = vi.spyOn(adapter, "processEvent").mockResolvedValue(undefined);
    path = "/line";
    return { handler: adapter.handleWebhook.bind(adapter), downstream, path };
  }
  if (channel === "teams") {
    adapter = new TeamsAdapter({ enabled: true, appId: "app", appPassword: "secret" });
    downstream = vi
      .spyOn(adapter, "processIncomingActivity")
      .mockImplementation(async (_req: Any, res: Any) => {
        res.writeHead(200);
        res.end();
      });
    path = "/api/messages";
  } else if (channel === "google-chat") {
    adapter = new GoogleChatAdapter({ enabled: true, webhookSecret: "secret" });
    downstream = vi
      .spyOn(adapter, "processIncomingEvent")
      .mockImplementation(async (_req: Any, res: Any) => {
        res.writeHead(200);
        res.end();
      });
    path = "/googlechat/webhook";
  } else if (channel === "feishu") {
    adapter = new FeishuAdapter({
      enabled: true,
      appId: "app",
      appSecret: "secret",
      verificationToken: "verify",
    });
    downstream = vi.spyOn(adapter, "parseAndVerifyPayload").mockReturnValue({ challenge: "hello" });
    path = "/feishu/webhook";
  } else {
    adapter = new WeComAdapter({
      enabled: true,
      corpId: "corp",
      corpSecret: "secret",
      agentId: "1",
    });
    downstream = vi.spyOn(adapter, "parseIncomingXml").mockReturnValue("<xml/>");
    vi.spyOn(adapter, "handleIncomingXml").mockResolvedValue(undefined);
    path = "/wecom/webhook";
  }
  await (channel === "feishu" || channel === "wecom"
    ? adapter.startServer()
    : adapter.startWebhookServer());
  return { handler: state.handler, downstream, path };
}
function request(path: string) {
  const req = new PassThrough() as Any;
  req.method = "POST";
  req.url = path;
  req.headers = { "x-line-signature": "sig" };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
});
describe("all affected webhook ingress paths", () => {
  it.each(["line", "teams", "google-chat", "feishu", "wecom"])(
    "rejects oversized unauthenticated %s input before provider processing",
    async (channel) => {
      const { handler, downstream, path } = await setup(channel);
      const { req, res } = request(path);
      const pending = handler(req, res);
      req.write(Buffer.alloc(DEFAULT_WEBHOOK_BODY_LIMIT_BYTES));
      req.end(Buffer.from("overflow"));
      await pending;
      expect(res.writeHead).toHaveBeenCalledWith(
        413,
        ...(["feishu", "wecom"].includes(channel) ? [expect.any(Object)] : []),
      );
      expect(downstream).not.toHaveBeenCalled();
    },
  );
  it.each(["line", "teams", "google-chat", "feishu", "wecom"])(
    "accepts ordinary chunked %s input",
    async (channel) => {
      const { handler, downstream, path } = await setup(channel);
      const { req, res } = request(path);
      const pending = handler(req, res);
      const bytes = Buffer.from('{"events":[{"text":"€ hello"}]}');
      for (const byte of bytes) req.write(Buffer.from([byte]));
      req.end();
      await pending;
      expect(res.writeHead.mock.calls[0][0]).toBe(200);
      expect(downstream).toHaveBeenCalledOnce();
      if (channel === "teams" || channel === "google-chat")
        expect(downstream.mock.calls[0][2]).toBe(bytes.toString());
    },
  );
  it("reads exact byte limits intact and rejects interrupted uploads", async () => {
    const req = new PassThrough();
    const reading = readLimitedBody(req as Any, 3);
    req.end(Buffer.from("€"));
    expect((await reading).toString()).toBe("€");
    const interrupted = new PassThrough();
    const rejected = readLimitedBody(interrupted as Any);
    interrupted.emit("aborted");
    await expect(rejected).rejects.toThrow("interrupted");
  });
});
