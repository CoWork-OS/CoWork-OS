import { describe, expect, it } from "vitest";
import { applyCookies, mapCookies } from "../cookie-import";
import { ImportSessions } from "../import-session";
import { BrowserVault, VaultError, type Sealer, type VaultFile } from "../vault";

function fakeVault(available = true) {
  let file: VaultFile | undefined;
  let n = 0;
  const sealer: Sealer = {
    available: () => available,
    seal: (plain) => `sealed:${Buffer.from(plain).toString("base64")}`,
    open: (sealed) => Buffer.from(sealed.slice(7), "base64").toString(),
  };
  const vault = new BrowserVault(
    { load: () => file, save: (value) => void (file = JSON.parse(JSON.stringify(value))) },
    sealer,
    () => 1000,
    () => `id${++n}`,
  );
  return { vault, raw: () => JSON.stringify(file ?? {}) };
}

describe("BrowserVault", () => {
  it("stores sealed passwords, never plaintext, and lists metadata only", () => {
    const { vault, raw } = fakeVault();
    expect(
      vault.addMany("p", [{ origin: "https://a.example", username: "me", password: "hunter2" }]),
    ).toEqual({
      added: 1,
      updated: 0,
    });
    expect(raw()).not.toContain("hunter2");
    const listing = vault.list("p");
    expect(listing).toEqual([
      { id: "id1", origin: "https://a.example", username: "me", createdAt: 1000 },
    ]);
    expect(JSON.stringify(listing)).not.toContain("sealed");
  });
  it("updates an existing login instead of duplicating it, and isolates profiles", () => {
    const { vault } = fakeVault();
    vault.addMany("p", [{ origin: "https://a.example", username: "me", password: "one" }]);
    expect(
      vault.addMany("p", [{ origin: "https://a.example", username: "me", password: "two" }]),
    ).toEqual({
      added: 0,
      updated: 1,
    });
    expect(vault.count("p")).toBe(1);
    expect(vault.list("other")).toEqual([]);
    expect(vault.forOrigin("p", "https://a.example")).toHaveLength(1);
    expect(vault.forOrigin("p", "https://evil.example")).toHaveLength(0);
  });
  it("hands the secret only to the callback", async () => {
    const { vault } = fakeVault();
    vault.addMany("p", [{ origin: "https://a.example", username: "me", password: "hunter2" }]);
    const seen = await vault.withSecret("p", "id1", (secret) => secret.password.length);
    expect(seen).toBe(7);
    expect(vault.list("p")[0].lastUsedAt).toBe(1000);
    await expect(vault.withSecret("other", "id1", () => 1)).rejects.toBeInstanceOf(VaultError);
  });
  it("refuses to store when OS encryption is unavailable", () => {
    const { vault } = fakeVault(false);
    expect(vault.canStore()).toBe(false);
    expect(() =>
      vault.addMany("p", [{ origin: "https://a.example", username: "", password: "x" }]),
    ).toThrow(VaultError);
  });
  it("removes and clears", () => {
    const { vault } = fakeVault();
    vault.addMany("p", [
      { origin: "https://a.example", username: "a", password: "1" },
      { origin: "https://b.example", username: "b", password: "2" },
    ]);
    expect(vault.remove("p", "id1")).toBe(true);
    expect(vault.clear("p")).toBe(1);
  });
});

describe("ImportSessions", () => {
  const data = (profileKey = "p") => ({
    profileKey,
    source: "x",
    cookies: [],
    logins: [{ origin: "https://a.example", username: "u", password: "secret" }],
  });
  it("works once, only for its profile, and expires", () => {
    let t = 0;
    const sessions = new ImportSessions(
      () => t,
      () => "a".repeat(64),
    );
    const token = sessions.stage(data());
    expect(sessions.take("b".repeat(64), "p")).toBeNull();
    expect(sessions.take(token, "other")).toBeNull();
    expect(sessions.take(token, "p")).toBeNull();
    const again = sessions.stage(data());
    t += 6 * 60_000;
    expect(sessions.take(again, "p")).toBeNull();
    expect(sessions.size).toBe(0);
  });
  it("wipes secrets on cancel", () => {
    const sessions = new ImportSessions();
    const payload = data();
    const token = sessions.stage(payload);
    sessions.cancel(token);
    expect(payload.logins).toHaveLength(0);
  });
});

describe("cookies", () => {
  const cookie = {
    host: ".example.com",
    name: "sid",
    value: "v",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction" as const,
    expiresAt: 2_000,
  };
  it("maps valid cookies and skips invalid, expired and unsafe ones", () => {
    const result = mapCookies(
      [
        cookie,
        { ...cookie, name: "old", expiresAt: 10 },
        { ...cookie, name: "bad name" },
        { ...cookie, host: "localhost evil", name: "h" },
        { ...cookie, value: "a;b", name: "semi" },
        { ...cookie, name: "__Host-x", host: ".example.com" },
        { ...cookie, name: "plain", secure: false, sameSite: "no_restriction" as const },
      ],
      1_000,
    );
    expect(result.cookies.map((c) => c.name)).toEqual(["sid", "plain"]);
    expect(result.cookies[0]).toMatchObject({
      domain: ".example.com",
      url: "https://example.com/",
    });
    expect(result.cookies[1].sameSite).toBe("unspecified");
    expect(result.skipped).toEqual({ invalid: 4, expired: 1, tooMany: 0 });
  });
  it("counts what the browser rejects", async () => {
    let n = 0;
    const out = await applyCookies(
      {
        set: async () => {
          if (++n === 2) throw new Error("rejected");
        },
      },
      mapCookies([cookie, { ...cookie, name: "b" }], 1_000).cookies,
    );
    expect(out).toEqual({ imported: 1, rejected: 1 });
  });
});
