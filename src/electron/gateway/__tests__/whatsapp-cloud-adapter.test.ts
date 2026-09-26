import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppCloudAdapter, computeWhatsAppSignature } from "../channels/whatsapp-cloud";
import type { DeliveryStatusUpdate, IncomingMessage } from "../channels/types";

const realFetch = globalThis.fetch;
const APP_SECRET = "test-app-secret-value";

function graphResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function inboundPayload(messageId: string, overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1111" },
              contacts: [{ wa_id: "15550001111", profile: { name: "Ada" } }],
              messages: [
                {
                  from: "15550001111",
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hello" },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsAppCloudAdapter", () => {
  let server: http.Server;
  let baseUrl: string;
  let adapter: WhatsAppCloudAdapter;
  let graphCalls: Array<{ url: string; body?: unknown }>;
  let graphResponder: (url: string, body?: unknown) => Response;

  beforeEach(async () => {
    graphCalls = [];
    graphResponder = () => graphResponse({ messages: [{ id: "wamid.out" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        graphCalls.push({ url, body });
        return graphResponder(url, body);
      }),
    );
    adapter = new WhatsAppCloudAdapter({
      enabled: true,
      phoneNumberId: "1111",
      accessToken: "token-abcdefghijklmnopqrstuvwxyz",
      appSecret: APP_SECRET,
      verifyToken: "verify-me-please",
      fallbackTemplateName: "follow_up",
    });
    server = http.createServer((req, res) => void adapter.handleHttpRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/whatsapp-cloud/webhook`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postSigned(payload: unknown, signature?: string) {
    const body = JSON.stringify(payload);
    return realFetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature ?? computeWhatsAppSignature(APP_SECRET, Buffer.from(body)),
      },
      body,
    });
  }

  it("answers Meta's verification handshake only with the right token", async () => {
    const ok = await realFetch(
      `${baseUrl}?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=42`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");

    const bad = await realFetch(
      `${baseUrl}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`,
    );
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned or mis-signed webhooks", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    expect((await postSigned(inboundPayload("wamid.1"), "sha256=deadbeef")).status).toBe(401);
    expect((await postSigned(inboundPayload("wamid.1"), "")).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes a signed inbound message once, even when Meta retries it", async () => {
    const received: IncomingMessage[] = [];
    adapter.onMessage((message) => {
      received.push(message);
    });

    expect((await postSigned(inboundPayload("wamid.1"))).status).toBe(200);
    expect((await postSigned(inboundPayload("wamid.1"))).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      channel: "whatsapp_cloud",
      messageId: "wamid.1",
      chatId: "15550001111",
      userName: "Ada",
      text: "hello",
    });
  });

  it("ignores events for other phone numbers on the same app", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    const payload = inboundPayload("wamid.2");
    payload.entry[0].changes[0].value.metadata.phone_number_id = "9999";

    await adapter.handleWebhookPayload(payload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports delivery receipts including failures", async () => {
    const updates: DeliveryStatusUpdate[] = [];
    adapter.onDeliveryStatus((update) => updates.push(update));

    await adapter.handleWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1111" },
                statuses: [
                  {
                    id: "wamid.out",
                    status: "delivered",
                    recipient_id: "15550001111",
                    timestamp: "1",
                  },
                  {
                    id: "wamid.out2",
                    status: "failed",
                    recipient_id: "15550001111",
                    timestamp: "2",
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(updates.map((update) => update.state)).toEqual(["delivered", "failed"]);
    expect(updates[1]).toMatchObject({
      errorCode: "131047",
      errorMessage: "Re-engagement message",
    });
  });

  it("replies with free text inside the window", async () => {
    await adapter.handleWebhookPayload(inboundPayload("wamid.3"));
    await adapter.sendMessage({ chatId: "15550001111", text: "hi there", replyTo: "wamid.3" });
    expect(graphCalls.at(-1)?.body).toMatchObject({
      to: "15550001111",
      type: "text",
      text: { body: "hi there" },
      context: { message_id: "wamid.3" },
    });
  });

  it("holds replies outside the window, templates once, and delivers them when the contact returns", async () => {
    const received: IncomingMessage[] = [];
    adapter.onMessage((message) => {
      received.push(message);
    });
    await adapter.handleWebhookPayload(
      inboundPayload("wamid.4", {
        from: "15550002222",
        timestamp: String(Math.floor(Date.now() / 1000) - 25 * 3600),
      }),
    );

    await adapter.sendMessage({ chatId: "15550002222", text: "late reply" });
    await adapter.sendMessage({ chatId: "15550002222", text: "second late reply" });
    const templates = graphCalls.filter(
      (call) => (call.body as { type?: string })?.type === "template",
    );
    expect(templates).toHaveLength(1);
    expect(graphCalls.some((call) => (call.body as { type?: string })?.type === "text")).toBe(
      false,
    );
    expect((await adapter.getInfo()).extra?.health).toMatchObject({
      heldReplies: [{ chatId: "15550002222", count: 2 }],
    });

    await adapter.handleWebhookPayload(
      inboundPayload("wamid.5", { from: "15550002222", text: { body: "ok, go ahead" } }),
    );
    const texts = graphCalls
      .filter((call) => (call.body as { type?: string })?.type === "text")
      .map((call) => (call.body as { text: { body: string } }).text.body);
    expect(texts).toEqual(["late reply", "second late reply"]);
    expect(received.map((message) => message.text)).toEqual(["hello", "ok, go ahead"]);
    expect((await adapter.getInfo()).extra?.health).toMatchObject({ heldReplies: [] });
  });

  it("holds unsent content when Meta reports the window closed", async () => {
    graphResponder = (_url, body) =>
      (body as { type?: string })?.type === "text"
        ? graphResponse({ error: { code: 131047, message: "Re-engagement message" } }, 400)
        : graphResponse({ messages: [{ id: "wamid.template" }] });

    const id = await adapter.sendMessage({ chatId: "+1 555 000 3333", text: "hello again" });
    expect(id).toBe("wamid.template");
    expect(graphCalls.map((call) => (call.body as { type?: string })?.type)).toEqual([
      "text",
      "template",
    ]);
    expect((await adapter.getInfo()).extra?.health).toMatchObject({
      heldReplies: [{ chatId: "15550003333", count: 1 }],
    });
  });

  it("checks the window before sending attachments", async () => {
    await adapter.handleWebhookPayload(
      inboundPayload("wamid.6", {
        from: "15550004444",
        timestamp: String(Math.floor(Date.now() / 1000) - 30 * 3600),
      }),
    );
    await adapter.sendMessage({
      chatId: "15550004444",
      text: "see attached",
      attachments: [{ type: "image", url: "https://example.com/a.png" }],
    });
    expect(graphCalls.map((call) => (call.body as { type?: string })?.type)).toEqual(["template"]);
  });

  it("counts rejected webhooks for the health view", async () => {
    const errors: string[] = [];
    adapter.onError((error) => errors.push(error.message));
    await postSigned(inboundPayload("wamid.7"), "sha256=bad");
    await postSigned(inboundPayload("wamid.7"), "sha256=bad");

    const health = (await adapter.getInfo()).extra?.health as { rejectedWebhooks: number };
    expect(health.rejectedWebhooks).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/App Secret/);
  });

  it("retries spooled messages whose processing failed, across restarts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-cloud-state-"));
    const config = {
      enabled: true,
      phoneNumberId: "1111",
      accessToken: "token-abcdefghijklmnopqrstuvwxyz",
      appSecret: APP_SECRET,
      verifyToken: "verify-me-please",
      stateDir,
    };
    const first = new WhatsAppCloudAdapter(config);
    first.onMessage(() => {
      throw new Error("router unavailable");
    });
    await first.handleWebhookPayload(inboundPayload("wamid.8"));
    await first.disconnect();

    const second = new WhatsAppCloudAdapter(config);
    expect(
      ((await second.getInfo()).extra?.health as { pendingInbound: number }).pendingInbound,
    ).toBe(1);
    // A provider retry of the same event is still recognised as a duplicate.
    const received: IncomingMessage[] = [];
    second.onMessage((message) => {
      received.push(message);
    });
    await second.handleWebhookPayload(inboundPayload("wamid.8"));
    expect(received).toHaveLength(0);

    vi.useFakeTimers({ now: Date.now() + 5 * 60_000, toFake: ["Date"] });
    try {
      await second.handleWebhookPayload({ object: "whatsapp_business_account", entry: [] });
    } finally {
      vi.useRealTimers();
    }
    expect(received.map((message) => message.messageId)).toEqual(["wamid.8"]);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("surfaces expired tokens as an actionable connection error", async () => {
    graphResponder = () =>
      graphResponse({ error: { code: 190, message: "Error validating access token" } }, 401);
    const statuses: string[] = [];
    const disconnected = new WhatsAppCloudAdapter({
      enabled: true,
      phoneNumberId: "1111",
      accessToken: "expired-token-abcdefghijk",
      appSecret: APP_SECRET,
      verifyToken: "verify-me-please",
      webhookPort: 0,
    });
    disconnected.onStatusChange((status) => statuses.push(status));

    await expect(disconnected.connect()).rejects.toThrow(/rejected the access token/);
    expect(statuses).toEqual(["connecting", "error"]);
    expect(disconnected.status).toBe("error");
  });

  it("refuses to start without webhook credentials", async () => {
    const unconfigured = new WhatsAppCloudAdapter({
      enabled: true,
      phoneNumberId: "1111",
      accessToken: "token",
      appSecret: "",
      verifyToken: "",
    });
    await expect(unconfigured.probe()).rejects.toThrow(/appSecret, verifyToken/);
    expect(graphCalls).toHaveLength(0);
  });
});
