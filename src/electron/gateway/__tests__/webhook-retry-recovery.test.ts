import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioSmsAdapter } from "../channels/twilio-sms";
import { WebhookChannelState } from "../channels/webhook-channel-state";
import { WhatsAppCloudAdapter } from "../channels/whatsapp-cloud";

const cases = [
  {
    name: "Twilio SMS",
    create: (stateDir: string) =>
      new TwilioSmsAdapter({
        enabled: true,
        accountSid: `AC${"a".repeat(32)}`,
        authToken: "test-auth-token",
        fromNumber: "+15550009999",
        webhookPublicUrl: "https://sms.example.com",
        stateDir,
      }),
    payload: { MessageSid: "inbound-1", From: "+15550001111", Body: "hello" },
  },
  {
    name: "WhatsApp Cloud",
    create: (stateDir: string) =>
      new WhatsAppCloudAdapter({
        enabled: true,
        phoneNumberId: "1111",
        accessToken: "test-access-token",
        appSecret: "test-app-secret",
        verifyToken: "test-verify-token",
        stateDir,
      }),
    payload: { message: { id: "inbound-1", from: "15550001111", text: { body: "hello" } } },
  },
];

describe("webhook retry recovery", () => {
  afterEach(() => vi.useRealTimers());

  it.each(cases)(
    "re-arms $name's persisted retry deadline on connect",
    async ({ create, payload }) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-webhook-retry-"));
      const now = Date.now();
      const state = new WebhookChannelState(stateDir);
      state.enqueueInbound("inbound-1", payload, now);
      state.failInbound("inbound-1", "temporary routing failure", 6, now);
      state.flush();

      vi.useFakeTimers({ now, toFake: ["Date", "setTimeout", "clearTimeout"] });
      const adapter = create(stateDir);
      const internals = adapter as unknown as {
        probe: () => Promise<unknown>;
        startServer: () => Promise<void>;
        stopServer: () => Promise<void>;
        processInbound: (payload: unknown) => Promise<void>;
      };
      vi.spyOn(internals, "probe").mockResolvedValue({});
      vi.spyOn(internals, "startServer").mockResolvedValue(undefined);
      vi.spyOn(internals, "stopServer").mockResolvedValue(undefined);
      const processInbound = vi.spyOn(internals, "processInbound").mockResolvedValue(undefined);

      try {
        await adapter.connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(processInbound).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(59_999);
        expect(processInbound).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(processInbound).toHaveBeenCalledExactlyOnceWith(payload);
        expect((await adapter.getInfo()).extra?.health).toMatchObject({ pendingInbound: 0 });
      } finally {
        await adapter.disconnect();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
