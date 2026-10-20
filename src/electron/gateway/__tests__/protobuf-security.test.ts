import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { proto } from "baileys";
import { installWhatsAppProtobufDepthLimit } from "../channels/whatsapp-protobuf-limits";

const require = createRequire(import.meta.url);
const signalRequire = createRequire(require.resolve("libsignal"));
const signal = require("libsignal");
const protobuf = require("protobufjs");
const whisper = signalRequire("./src/protobufs.js");
const boltRequire = createRequire(require.resolve("@slack/bolt"));
const expressRequire = createRequire(boltRequire.resolve("express"));
const proxyaddr = expressRequire("proxy-addr");

function varint(value: number): Buffer {
  const bytes = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}

function field(number: number, bytes: Uint8Array): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function recursiveMessage(number: number, depth: number): Buffer {
  let bytes: Uint8Array = proto.Message.encode({ conversation: "ordinary message" }).finish();
  for (let i = 0; i < depth; i++) bytes = field(number, field(1, bytes));
  return Buffer.from(bytes);
}

describe("real protobuf dependency security boundaries", () => {
  it("sanitizes schema names before generated JavaScript while keeping ordinary fields", () => {
    const type = new protobuf.Type("Invalid;Name").add(new protobuf.Field("text", 1, "string"));
    expect(type.name).toBe("InvalidName");
    expect(type.decode(type.encode({ text: "ordinary" }).finish()).text).toBe("ordinary");
    expect(type.ctor.name).toBe("InvalidName");
  });

  it.each(["WhisperMessage", "PreKeyWhisperMessage"])(
    "%s rejects deep unknown groups before exhausting the stack",
    (name) => {
      const payload = Buffer.concat([
        Buffer.alloc(30_000, varint((127 << 3) | 3)),
        Buffer.alloc(30_000, varint((127 << 3) | 4)),
      ]);
      expect(() => whisper[name].decode(payload)).toThrow(/maximum nesting depth exceeded/i);
    },
  );

  it("preserves generated Signal wire bytes, uint32 limits and binary conversion", () => {
    const value = {
      ephemeralKey: Buffer.from([0, 128, 255]),
      counter: 0xffffffff,
      previousCounter: 0,
      ciphertext: Buffer.from([0, 255]),
    };
    const expected = Buffer.from("0a030080ff10ffffffff0f1800220200ff", "hex");
    const message = whisper.WhisperMessage.fromObject(value);
    expect(Buffer.from(whisper.WhisperMessage.encode(message).finish())).toEqual(expected);
    expect(
      whisper.WhisperMessage.toObject(whisper.WhisperMessage.decode(expected), { bytes: Array }),
    ).toEqual({
      ...value,
      ephemeralKey: [0, 128, 255],
      ciphertext: [0, 255],
    });
  });

  it("bounds known recursive fields in the actual generated WhatsApp schema and recovers after rejection", () => {
    installWhatsAppProtobufDepthLimit(proto);
    // Both representations recurse Message -> FutureProofMessage -> Message.
    for (const number of [37, 40]) {
      expect(() => proto.Message.decode(recursiveMessage(number, 5_000))).toThrow(
        "WhatsApp protobuf message nesting depth exceeded",
      );
      const normal = proto.Message.decode(recursiveMessage(number, 8));
      expect(Buffer.from(proto.Message.encode(normal).finish())).toEqual(
        recursiveMessage(number, 8),
      );
    }
    expect(
      proto.Message.decode(proto.Message.encode({ conversation: "after rejection" }).finish())
        .conversation,
    ).toBe("after rejection");
  });

  it("keeps decodeDelimited, Reader inputs, uint64 fields and repeated installation working", () => {
    installWhatsAppProtobufDepthLimit(proto);
    const decode = proto.Message.decode;
    installWhatsAppProtobufDepthLimit(proto);
    expect(proto.Message.decode).toBe(decode);
    const minimal = require("protobufjs/minimal");
    const value = proto.WebMessageInfo.fromObject({
      key: { remoteJid: "audit@s.whatsapp.net", id: "synthetic" },
      messageTimestamp: "9007199254740993",
      message: { ephemeralMessage: { message: { conversation: "control" } } },
    });
    const wire = proto.WebMessageInfo.encodeDelimited(value).finish();
    const decoded = proto.WebMessageInfo.decodeDelimited(minimal.Reader.create(wire));
    expect(decoded.messageTimestamp?.toString()).toBe("9007199254740993");
    expect(decoded.message?.ephemeralMessage?.message?.conversation).toBe("control");
  });
});

describe("real libsignal session compatibility", () => {
  it("preserves prekey exchange, reply ratchets and persisted sessions while rejecting tampering", async () => {
    function store() {
      const identity = signal.keyhelper.generateIdentityKeyPair();
      const signed = signal.keyhelper.generateSignedPreKey(identity, 1);
      const prekey = signal.keyhelper.generatePreKey(1);
      const records = new Map<string, unknown>();
      let prekeyUsed = false;
      return {
        identity,
        signed,
        prekey,
        storage: {
          getOurIdentity: async () => identity,
          getOurRegistrationId: async () => 42,
          isTrustedIdentity: async () => true,
          loadSignedPreKey: async () => signed.keyPair,
          loadPreKey: async () => (prekeyUsed ? undefined : prekey.keyPair),
          removePreKey: async () => {
            prekeyUsed = true;
          },
          storeSession: async (id: string, record: { serialize(): unknown }) => {
            records.set(id, JSON.parse(JSON.stringify(record.serialize())));
          },
          loadSession: async (id: string) =>
            records.has(id) ? signal.SessionRecord.deserialize(records.get(id)) : undefined,
        },
      };
    }
    const alice = store();
    const bob = store();
    const aliceAddress = new signal.ProtocolAddress("alice-audit", 1);
    const bobAddress = new signal.ProtocolAddress("bob-audit", 1);
    await new signal.SessionBuilder(alice.storage, bobAddress).initOutgoing({
      registrationId: 42,
      identityKey: bob.identity.pubKey,
      signedPreKey: {
        keyId: 1,
        publicKey: bob.signed.keyPair.pubKey,
        signature: bob.signed.signature,
      },
      preKey: { keyId: 1, publicKey: bob.prekey.keyPair.pubKey },
    });
    const outgoing = new signal.SessionCipher(alice.storage, bobAddress);
    const incoming = new signal.SessionCipher(bob.storage, aliceAddress);
    const first = await outgoing.encrypt(Buffer.from("prekey control"));
    expect(first.type).toBe(3);
    expect((await incoming.decryptPreKeyWhisperMessage(first.body)).toString()).toBe(
      "prekey control",
    );
    const reply = await incoming.encrypt(Buffer.from("reply ratchet"));
    expect(reply.type).toBe(1);
    expect((await outgoing.decryptWhisperMessage(reply.body)).toString()).toBe("reply ratchet");
    const resumed = new signal.SessionCipher(alice.storage, bobAddress);
    const next = await resumed.encrypt(Buffer.from("after persistence"));
    const tampered = Buffer.from(next.body);
    tampered[tampered.length - 1] ^= 1;
    await expect(incoming.decryptWhisperMessage(tampered)).rejects.toThrow();
    expect((await incoming.decryptWhisperMessage(next.body)).toString()).toBe("after persistence");
  });
});

describe("real Express proxy dependency", () => {
  it.each(["::ffff:10.0.0.0/8", "::/1"])(
    "does not trust an unrelated IPv4 peer for %s",
    (subnet) => {
      const request = {
        socket: { remoteAddress: "203.0.113.9" },
        headers: { "x-forwarded-for": "127.0.0.1" },
      };
      expect(proxyaddr(request, proxyaddr.compile([subnet]))).toBe("203.0.113.9");
    },
  );

  it.each(["10.0.0.0/8", "::ffff:10.0.0.0/104", "uniquelocal"])(
    "preserves legitimate trusted proxy chains for %s",
    (subnet) => {
      const request = {
        socket: { remoteAddress: "10.2.3.4" },
        headers: { "x-forwarded-for": "198.51.100.20" },
      };
      expect(proxyaddr(request, proxyaddr.compile([subnet]))).toBe("198.51.100.20");
    },
  );
});
