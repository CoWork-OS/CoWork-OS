import * as http from "http";
import type { AddressInfo } from "net";
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioSmsAdapter, splitSmsBody } from "../channels/twilio-sms";
import type { DeliveryStatusUpdate, IncomingMessage } from "../channels/types";

const realFetch = globalThis.fetch;
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const AUTH_TOKEN = "twilio-auth-token-123456";
const PUBLIC_BASE = "https://sms.example.com";

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TwilioSmsAdapter", () => {
  let server: http.Server;
  let localBase: string;
  let adapter: TwilioSmsAdapter;
  let apiCalls: Array<{ url: string; form?: URLSearchParams }>;
  let apiResponder: (url: string) => Response;

  beforeEach(async () => {
    apiCalls = [];
    apiResponder = () => apiResponse({ sid: "SM-out" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
        apiCalls.push({
          url,
          form: typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined,
        });
        return apiResponder(url);
      }),
    );
    adapter = new TwilioSmsAdapter({
      enabled: true,
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fromNumber: "+15550009999",
      webhookPublicUrl: PUBLIC_BASE,
    });
    server = http.createServer((req, res) => void adapter.handleHttpRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postSigned(pathName: string, params: Record<string, string>, signature?: string) {
    const expected = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${PUBLIC_BASE}${pathName}`,
      params,
    );
    return realFetch(`${localBase}${pathName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature ?? expected,
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  const inbound = (sid: string, body = "hello") => ({
    MessageSid: sid,
    AccountSid: ACCOUNT_SID,
    From: "+15550001111",
    To: "+15550009999",
    Body: body,
    NumMedia: "0",
  });

  it("verifies signatures against the public URL and rejects forgeries", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    expect((await postSigned("/twilio-sms/webhook", inbound("SM1"), "forged")).status).toBe(403);
    const ok = await postSigned("/twilio-sms/webhook", inbound("SM1"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<Response></Response>");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("deduplicates retried deliveries by MessageSid", async () => {
    const received: IncomingMessage[] = [];
    adapter.onMessage((message) => {
      received.push(message);
    });

    await postSigned("/twilio-sms/webhook", inbound("SM2"));
    await postSigned("/twilio-sms/webhook", inbound("SM2"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      channel: "twilio_sms",
      chatId: "+15550001111",
      text: "hello",
    });
  });

  it("records STOP messages without routing them to the agent", async () => {
    const received: IncomingMessage[] = [];
    adapter.onMessage((message) => {
      received.push(message);
    });

    await postSigned("/twilio-sms/webhook", inbound("SM3", "STOP"));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].ingestOnly).toBe(true);
  });

  it("maps signed status callbacks to delivery updates", async () => {
    const updates: DeliveryStatusUpdate[] = [];
    adapter.onDeliveryStatus((update) => updates.push(update));

    await postSigned("/twilio-sms/status", {
      MessageSid: "SM-out",
      MessageStatus: "delivered",
      To: "+15550001111",
    });
    await postSigned("/twilio-sms/status", {
      MessageSid: "SM-out",
      MessageStatus: "delivered",
      To: "+15550001111",
    });
    await postSigned("/twilio-sms/status", {
      MessageSid: "SM-out2",
      MessageStatus: "undelivered",
      ErrorCode: "30003",
      To: "+15550001111",
    });

    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[0]).toMatchObject({ messageId: "SM-out", state: "delivered" });
    expect(updates[1]).toMatchObject({ state: "undelivered", errorCode: "30003" });
  });

  it("sends E.164 messages with a status callback and rejects local numbers", async () => {
    const sid = await adapter.sendMessage({ chatId: "+1 (555) 000-1111", text: "reply" });

    expect(sid).toBe("SM-out");
    const form = apiCalls.at(-1)?.form;
    expect(apiCalls.at(-1)?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(form?.get("To")).toBe("+15550001111");
    expect(form?.get("From")).toBe("+15550009999");
    expect(form?.get("StatusCallback")).toBe(`${PUBLIC_BASE}/twilio-sms/status`);

    await expect(adapter.sendMessage({ chatId: "5550001111", text: "x" })).rejects.toThrow(
      /E\.164/,
    );
  });

  it("only sends media from public HTTPS URLs", async () => {
    await expect(
      adapter.sendMessage({
        chatId: "+15550001111",
        text: "photo",
        attachments: [{ type: "image", url: "/tmp/photo.png" }],
      }),
    ).rejects.toThrow(/public HTTPS URL/);
  });

  it("explains opted-out recipients and bad credentials", async () => {
    apiResponder = () =>
      apiResponse({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, 400);
    await expect(adapter.sendMessage({ chatId: "+15550001111", text: "x" })).rejects.toThrow(
      /opted out/,
    );

    apiResponder = () => apiResponse({ code: 20003, message: "Authenticate" }, 401);
    await expect(adapter.probe()).rejects.toThrow(/rejected the Account SID or auth token/);
  });

  it("records HELP/START keywords and non-replyable senders without routing", async () => {
    const received: IncomingMessage[] = [];
    adapter.onMessage((message) => {
      received.push(message);
    });

    await postSigned("/twilio-sms/webhook", inbound("SM10", "HELP"));
    await postSigned("/twilio-sms/webhook", {
      ...inbound("SM11", "your code is 1234"),
      From: "72345",
    });
    await postSigned("/twilio-sms/webhook", {
      ...inbound("SM12", "hi"),
      From: "whatsapp:+15550001111",
    });
    await postSigned("/twilio-sms/webhook", inbound("SM13", "yes"));

    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received.map((message) => message.ingestOnly ?? false)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(received[1].metadata).toMatchObject({ senderKind: "short_code" });
    expect(received[2].metadata).toMatchObject({ senderKind: "whatsapp" });
  });

  it("labels multi-part replies so out-of-order delivery is readable", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const parts = splitSmsBody(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 1600)).toBe(true);
    expect(parts[0].startsWith(`(1/${parts.length}) `)).toBe(true);
    expect(splitSmsBody("short")).toEqual(["short"]);
  });

  it("accepts webhooks behind a proxy that keeps the public path prefix", async () => {
    const prefixed = new TwilioSmsAdapter({
      enabled: true,
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fromNumber: "+15550009999",
      webhookPublicUrl: "https://gw.example.com/cowork",
    });
    const handler = vi.fn();
    prefixed.onMessage(handler);
    const prefixedServer = http.createServer(
      (req, res) => void prefixed.handleHttpRequest(req, res),
    );
    await new Promise<void>((resolve) => prefixedServer.listen(0, "127.0.0.1", resolve));
    const port = (prefixedServer.address() as AddressInfo).port;
    try {
      const params = inbound("SM20");
      const signature = twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        "https://gw.example.com/cowork/twilio-sms/webhook",
        params,
      );
      for (const pathName of ["/cowork/twilio-sms/webhook", "/twilio-sms/webhook"]) {
        const response = await realFetch(`http://127.0.0.1:${port}${pathName}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Twilio-Signature": signature,
          },
          body: new URLSearchParams(params).toString(),
        });
        expect(response.status).toBe(200);
      }
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    } finally {
      await new Promise<void>((resolve) => prefixedServer.close(() => resolve()));
    }
  });

  it("explains rejected signatures with the URL it verified against", async () => {
    const errors: string[] = [];
    adapter.onError((error) => errors.push(error.message));
    await postSigned("/twilio-sms/webhook", inbound("SM30"), "forged");

    expect(errors[0]).toContain(`${PUBLIC_BASE}/twilio-sms/webhook`);
    const health = (await adapter.getInfo()).extra?.health as { rejectedWebhooks: number };
    expect(health.rejectedWebhooks).toBe(1);
  });

  it("refuses to start without a public HTTPS URL", async () => {
    const insecure = new TwilioSmsAdapter({
      enabled: true,
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fromNumber: "+15550009999",
      webhookPublicUrl: "http://sms.example.com",
    });
    await expect(insecure.probe()).rejects.toThrow(/must use https/);
    expect(apiCalls).toHaveLength(0);
  });
});
