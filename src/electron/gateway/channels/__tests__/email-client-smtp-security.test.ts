import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailClient } from "../email-client";

const mocks = vi.hoisted(() => ({ tcp: vi.fn(), tls: vi.fn() }));
vi.mock("net", async (original) => ({
  ...(await original<typeof import("net")>()),
  connect: mocks.tcp,
}));
vi.mock("tls", async (original) => ({
  ...(await original<typeof import("tls")>()),
  connect: mocks.tls,
}));
vi.mock("child_process", () => ({ execFileSync: () => "" }));

class Socket extends EventEmitter {
  writes: string[] = [];
  authorized = false;
  write(data: string) {
    this.writes.push(data);
    return true;
  }
  destroy() {
    this.emit("close");
    return this;
  }
  end() {
    this.emit("close");
    return this;
  }
  reply(data: string) {
    this.emit("data", Buffer.from(data));
  }
  secure() {
    this.authorized = true;
    this.emit("secureConnect");
  }
}

describe("SMTP authenticated transport", () => {
  let tcp: Socket;
  let tls: Socket;
  beforeEach(() => {
    tcp = new Socket();
    tls = new Socket();
    mocks.tcp.mockReset().mockReturnValue(tcp);
    mocks.tls.mockReset().mockReturnValue(tls);
  });
  afterEach(() => {
    tcp.destroy();
    tls.destroy();
    vi.restoreAllMocks();
  });

  async function begin(oauth = false, implicit = false) {
    const client = new EmailClient({
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.example.com",
      smtpPort: implicit ? 465 : 587,
      smtpSecure: implicit,
      email: "user@example.com",
      password: "fake-password",
      ...(oauth ? { authMethod: "oauth" as const, accessToken: "fake-access-token" } : {}),
    });
    const result = client.sendEmail({
      to: "recipient@example.com",
      subject: "control",
      text: "hello",
    });
    // Attach rejection handling before driving the fake transport.
    const outcome = result.then(
      (value) => ({ value }),
      (error) => ({ error: error as Error }),
    );
    await vi.waitFor(() => expect(implicit ? mocks.tls : mocks.tcp).toHaveBeenCalled());
    return { outcome };
  }

  it.each([false, true])("fails closed without STARTTLS (OAuth=%s)", async (oauth) => {
    const { outcome } = await begin(oauth);
    tcp.reply("220 smtp ready\r\n");
    tcp.reply("250-smtp\r\n250 AUTH PLAIN XOAUTH2\r\n");
    expect(tcp.writes.join("")).not.toMatch(/AUTH |MAIL FROM|DATA/);
    expect(await outcome).toHaveProperty("error.message", expect.stringMatching(/STARTTLS|TLS/i));
  });

  it.each(["250 not an upgrade\r\n", "334 challenge\r\n", "454 unavailable\r\n"])(
    "rejects an invalid STARTTLS response %s",
    async (response) => {
      const { outcome } = await begin();
      tcp.reply("220 ready\r\n");
      tcp.reply("250-STARTTLS\r\n250 OK\r\n");
      expect(tcp.writes.at(-1)).toBe("STARTTLS\r\n");
      tcp.reply(response);
      expect(tcp.writes.join("")).not.toMatch(/AUTH |MAIL FROM|DATA/);
      expect(await outcome).toHaveProperty("error");
    },
  );

  it("does not process pipelined plaintext after the upgrade response or authenticate before TLS verification", async () => {
    const { outcome } = await begin();
    tcp.reply("220 ready\r\n");
    tcp.reply("250 STARTTLS\r\n");
    tcp.reply("220 upgrade\r\n250 injected\r\n235 injected\r\n");
    tls.reply("250 premature\r\n");
    expect([...tcp.writes, ...tls.writes].join("")).not.toMatch(/AUTH |MAIL FROM|DATA/);
    tls.emit("error", new Error("certificate validation failed"));
    expect(await outcome).toHaveProperty("error");
  });

  it("does not treat STARTTLS inside an AUTH capability as an upgrade offer", async () => {
    const { outcome } = await begin();
    tcp.reply("220 ready\r\n");
    tcp.reply("250 AUTH PLAIN STARTTLS\r\n");
    expect(tcp.writes.join("")).not.toMatch(/AUTH |MAIL FROM|DATA/);
    expect(await outcome).toHaveProperty("error");
  });

  it("rejects an unverified implicit TLS connection", async () => {
    const { outcome } = await begin(false, true);
    tls.emit("secureConnect");
    tls.reply("220 ready\r\n250 AUTH PLAIN\r\n");
    expect(tls.writes).toEqual([]);
    expect(await outcome).toHaveProperty("error.message", expect.stringMatching(/certificate/i));
  });

  it.each([
    [false, false, 250],
    [false, true, 251],
    [true, false, 252],
    [true, true, 250],
  ] as const)(
    "sends a normal message only after verified TLS (implicit=%s, OAuth=%s, recipient=%s)",
    async (implicit, oauth, recipientCode) => {
      const { outcome } = await begin(oauth, implicit);
      if (!implicit) {
        tcp.reply("220 ready\r\n");
        tcp.reply("250-STARTTLS\r\n250 AUTH XOAUTH2\r\n");
        tcp.reply("220 upgrade\r\n");
      }
      tls.secure();
      if (implicit) tls.reply("220 ready\r\n");
      tls.reply("250 AUTH XOAUTH2\r\n");
      expect(tls.writes.at(-1)).toMatch(oauth ? /^AUTH XOAUTH2 / : /^AUTH PLAIN /);
      if (oauth) {
        tls.reply("334 continuation\r\n");
        expect(tls.writes.at(-1)).toBe("\r\n");
      }
      tls.reply("235 authenticated\r\n");
      expect(tls.writes.at(-1)).toMatch(/^MAIL FROM:/);
      tls.reply("250 sender\r\n");
      tls.reply(`${recipientCode} recipient\r\n`);
      tls.reply("354 data\r\n");
      expect(tls.writes.at(-1)).toContain("Subject: control");
      tls.reply("250 accepted\r\n");
      expect(await outcome).toHaveProperty("value", expect.any(String));
      expect(tcp.writes.join("")).not.toMatch(/AUTH |MAIL FROM|DATA/);
      expect(mocks.tls.mock.calls[0][0]).toMatchObject({
        rejectUnauthorized: true,
        servername: "smtp.example.com",
      });
    },
  );
});
