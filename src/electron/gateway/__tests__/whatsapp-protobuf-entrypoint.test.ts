import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeWASocket, proto } from "baileys";
import { WhatsAppAdapter } from "../channels/whatsapp";

vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  return {
    ...actual,
    makeWASocket: vi.fn(),
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
    })),
    fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 1], isLatest: true })),
    makeCacheableSignalKeyStore: vi.fn((keys) => keys),
  };
});

describe("WhatsApp socket protobuf boundary", () => {
  it("installs real schema limits before a socket can receive bytes, including on reconnect", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cowork-whatsapp-protobuf-"));
    const adapter = new WhatsAppAdapter({
      enabled: true,
      authDir: directory,
      deduplicationEnabled: false,
    });
    function varint(value: number) {
      const bytes = [];
      do {
        bytes.push((value & 127) | (value > 127 ? 128 : 0));
        value >>>= 7;
      } while (value);
      return Buffer.from(bytes);
    }
    function field(tag: number, body: Uint8Array) {
      return Buffer.concat([varint(tag), varint(body.length), body]);
    }
    let attack: Uint8Array = proto.Message.encode({ conversation: "ordinary" }).finish();
    for (let i = 0; i < 500; i++) attack = field((37 << 3) | 2, field(10, attack));
    vi.mocked(makeWASocket).mockImplementation(() => {
      expect(() => proto.Message.decode(attack)).toThrow(
        "WhatsApp protobuf message nesting depth exceeded",
      );
      expect(
        proto.Message.decode(proto.Message.encode({ conversation: "normal" }).finish())
          .conversation,
      ).toBe("normal");
      return {
        ev: new EventEmitter(),
        ws: Object.assign(new EventEmitter(), { close: vi.fn() }),
      } as unknown as ReturnType<typeof makeWASocket>;
    });
    try {
      await adapter.connect();
      await adapter.disconnect();
      await adapter.connect();
      expect(makeWASocket).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
