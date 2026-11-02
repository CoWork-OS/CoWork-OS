import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserCredentialsIpc } from "../browser-credentials-ipc";
import { mapCookies, type CookieSetDetails } from "../cookie-import";
import { ImportSessions } from "../import-session";
import {
  CookiesTxtError,
  MAX_COOKIES_TXT_BYTES,
  MAX_COOKIES_TXT_COOKIES,
  parseNetscapeCookies,
} from "../netscape-cookies";
import {
  BrowserVault,
  MAX_COOKIE_JARS_PER_PROFILE,
  VaultError,
  type Sealer,
  type VaultFile,
} from "../vault";
import { IPC_CHANNELS } from "../../../../shared/types";

const NOW = 1_800_000_000;
const line = (...fields: string[]) => fields.join("\t");

const SAMPLE = [
  "# Netscape HTTP Cookie File",
  "# https://curl.se/docs/http-cookies.html",
  "",
  line(".example.com", "TRUE", "/", "TRUE", String(NOW + 3600), "sid", "domain-secret"),
  line("app.example.com", "FALSE", "/", "FALSE", "0", "pref", "host-only-secret"),
  "#HttpOnly_" + line(".example.com", "TRUE", "/", "TRUE", String(NOW + 3600), "auth", "http-only"),
  line("example.org", "TRUE", "/docs", "FALSE", String(NOW + 60), "empty", ""),
].join("\n");

describe("parseNetscapeCookies", () => {
  it("reads cookies, HttpOnly lines, session cookies and empty values; ignores comments", () => {
    const { cookies, skipped } = parseNetscapeCookies(SAMPLE);
    expect(skipped).toEqual({ invalid: 0, tooMany: 0 });
    expect(cookies).toEqual([
      {
        host: ".example.com",
        name: "sid",
        value: "domain-secret",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "unspecified",
        expiresAt: NOW + 3600,
      },
      {
        host: "app.example.com",
        name: "pref",
        value: "host-only-secret",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "unspecified",
        expiresAt: undefined,
      },
      expect.objectContaining({ host: ".example.com", name: "auth", httpOnly: true }),
      // includeSubdomains TRUE without a dot still becomes a domain cookie.
      expect.objectContaining({ host: ".example.org", name: "empty", value: "", path: "/docs" }),
    ]);
  });

  it("maps to domain and host-only cookies the way mapCookies expects", () => {
    const { cookies } = mapCookies(parseNetscapeCookies(SAMPLE).cookies, NOW);
    expect(cookies.find((c) => c.name === "sid")).toMatchObject({
      domain: ".example.com",
      url: "https://example.com/",
    });
    expect(cookies.find((c) => c.name === "pref")).toMatchObject({
      domain: undefined,
      url: "http://app.example.com/",
    });
  });

  it("tolerates a byte-order mark and CRLF line endings", () => {
    const { cookies, skipped } = parseNetscapeCookies("﻿" + SAMPLE.replace(/\n/g, "\r\n"));
    expect(cookies).toHaveLength(4);
    expect(cookies[1].value).toBe("host-only-secret");
    expect(skipped.invalid).toBe(0);
  });

  it("skips and counts malformed lines instead of guessing", () => {
    const text = [
      line("example.com", "FALSE", "/", "FALSE", "0", "ok", "1"),
      line("example.com", "FALSE", "/", "FALSE", "0", "missing-value"),
      line("example.com", "FALSE", "/", "FALSE", "0", "extra", "a", "b"),
      line("example.com", "MAYBE", "/", "FALSE", "0", "flag", "1"),
      line("example.com", "FALSE", "/", "yes", "0", "secure", "1"),
      line("example.com", "FALSE", "/", "FALSE", "soon", "expiry", "1"),
      line("example.com", "FALSE", "/", "FALSE", "-5", "negative", "1"),
      // A leading dot that says "no subdomains" contradicts itself.
      line(".example.com", "FALSE", "/", "FALSE", "0", "dot", "1"),
      line("", "FALSE", "/", "FALSE", "0", "nohost", "1"),
      "just some text",
      "   ",
    ].join("\n");
    const { cookies, skipped } = parseNetscapeCookies(text);
    expect(cookies.map((c) => c.name)).toEqual(["ok"]);
    expect(skipped).toEqual({ invalid: 9, tooMany: 0 });
  });

  it("caps the cookie count and the input size", () => {
    const many = Array.from({ length: MAX_COOKIES_TXT_COOKIES + 3 }, (_, i) =>
      line("example.com", "FALSE", "/", "FALSE", "0", `c${i}`, "v"),
    ).join("\n");
    const { cookies, skipped } = parseNetscapeCookies(many);
    expect(cookies).toHaveLength(MAX_COOKIES_TXT_COOKIES);
    expect(skipped.tooMany).toBe(3);
    expect(() => parseNetscapeCookies("#".repeat(MAX_COOKIES_TXT_BYTES + 1))).toThrow(
      CookiesTxtError,
    );
    expect(() => parseNetscapeCookies("a\0b")).toThrow(CookiesTxtError);
  });
});

function fakeVault(available = true) {
  let file: VaultFile | undefined;
  let n = 0;
  let clock = 1000;
  const sealer: Sealer = {
    available: () => available,
    seal: (plain) => `sealed:${Buffer.from(plain).toString("base64")}`,
    open: (sealed) => Buffer.from(sealed.slice(7), "base64").toString(),
  };
  const vault = new BrowserVault(
    { load: () => file, save: (value) => void (file = JSON.parse(JSON.stringify(value))) },
    sealer,
    () => (clock += 1000),
    () => `id${++n}`,
  );
  return {
    vault,
    raw: () => JSON.stringify(file ?? {}),
    setFile: (value: VaultFile) => void (file = value),
  };
}

const cookie = (overrides: Partial<CookieSetDetails>): CookieSetDetails => ({
  url: "https://example.com/",
  name: "sid",
  value: "v",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "unspecified",
  ...overrides,
});

describe("BrowserVault cookie jars", () => {
  it("seals the whole jar: no cookie value is stored in the clear", () => {
    const { vault, raw } = fakeVault();
    const listing = vault.addCookieJar("p", {
      label: "cookies.txt",
      source: "cookies.txt file",
      cookies: [
        cookie({ domain: ".Example.com", value: "top-secret-1" }),
        cookie({ url: "http://app.b.example/", name: "x", value: "top-secret-2" }),
      ],
    });
    expect(listing).toEqual({
      id: "id1",
      label: "cookies.txt",
      source: "cookies.txt file",
      sites: ["app.b.example", "example.com"],
      cookies: 2,
      createdAt: 2000,
    });
    expect(raw()).not.toContain("top-secret");
    expect(raw()).toContain("sealed:");
    expect(JSON.stringify(vault.listCookieJars("p"))).not.toContain("top-secret");
    expect(JSON.stringify(vault.listCookieJars("p"))).not.toContain("sealed");
    expect(vault.listCookieJars("other")).toEqual([]);
  });

  it("refuses to store without OS encryption and caps jars per profile", () => {
    const { vault: locked } = fakeVault(false);
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof VaultError ? error.code : "other";
      }
      return null;
    };
    expect(
      codeOf(() => locked.addCookieJar("p", { label: "a", source: "s", cookies: [cookie({})] })),
    ).toBe("encryption_unavailable");

    const { vault } = fakeVault();
    for (let i = 0; i < MAX_COOKIE_JARS_PER_PROFILE; i += 1) {
      vault.addCookieJar("p", { label: `j${i}`, source: "s", cookies: [cookie({})] });
    }
    expect(
      codeOf(() =>
        vault.addCookieJar("p", { label: "one more", source: "s", cookies: [cookie({})] }),
      ),
    ).toBe("too_many");
    expect(vault.listCookieJars("p")).toHaveLength(MAX_COOKIE_JARS_PER_PROFILE);
  });

  it("lists at most 12 sites per jar, newest jar first", () => {
    const { vault } = fakeVault();
    vault.addCookieJar("p", { label: "old", source: "s", cookies: [cookie({})] });
    vault.addCookieJar("p", {
      label: "new",
      source: "s",
      cookies: Array.from({ length: 20 }, (_, i) => cookie({ url: `https://s${i}.example/` })),
    });
    const [first, second] = vault.listCookieJars("p");
    expect(first.label).toBe("new");
    expect(first.sites).toHaveLength(12);
    expect(first.cookies).toBe(20);
    expect(second.label).toBe("old");
  });

  it("returns cookies for a host by domain and host-only rules, without expired ones", () => {
    const { vault } = fakeVault();
    vault.addCookieJar("p", {
      label: "a",
      source: "s",
      cookies: [
        cookie({ name: "domain", domain: ".example.com" }),
        cookie({ name: "hostonly", url: "https://app.example.com/" }),
        cookie({ name: "apexonly", url: "https://example.com/" }),
        cookie({ name: "expired", domain: ".example.com", expirationDate: NOW - 1 }),
        cookie({ name: "future", domain: ".example.com", expirationDate: NOW + 1 }),
        cookie({ name: "other", domain: ".other.example" }),
      ],
    });
    const names = (host: string) =>
      vault
        .cookiesForHost("p", host, NOW)
        .map((c) => c.name)
        .sort();
    expect(names("example.com")).toEqual(["apexonly", "domain", "future"]);
    expect(names("APP.Example.com")).toEqual(["domain", "future", "hostonly"]);
    expect(names("deep.app.example.com")).toEqual(["domain", "future"]);
    expect(names("notexample.com")).toEqual([]);
    expect(names("example.com:443")).toEqual([]);
    expect(vault.cookiesForHost("p", "app.example.com", NOW)[0].value).toBe("v");
    expect(vault.cookiesForHost("other-profile", "example.com", NOW)).toEqual([]);
  });

  it("lets the newest jar win when two jars hold the same cookie", () => {
    const { vault } = fakeVault();
    vault.addCookieJar("p", {
      label: "old",
      source: "s",
      cookies: [
        cookie({ domain: ".example.com", value: "old" }),
        cookie({ name: "keep", domain: ".example.com", value: "kept" }),
      ],
    });
    vault.addCookieJar("p", {
      label: "new",
      source: "s",
      cookies: [cookie({ domain: ".example.com", value: "new" })],
    });
    const found = vault.cookiesForHost("p", "example.com", NOW);
    expect(found.find((c) => c.name === "sid")?.value).toBe("new");
    expect(found.find((c) => c.name === "keep")?.value).toBe("kept");
    expect(found).toHaveLength(2);
  });

  it("removes one jar, and clearing a profile removes jars with logins", () => {
    const { vault } = fakeVault();
    vault.addMany("p", [{ origin: "https://a.example", username: "me", password: "pw" }]);
    const jar = vault.addCookieJar("p", { label: "a", source: "s", cookies: [cookie({})] });
    vault.addCookieJar("p", { label: "b", source: "s", cookies: [cookie({})] });
    expect(vault.removeCookieJar("p", "nope")).toBe(false);
    expect(vault.removeCookieJar("p", jar.id)).toBe(true);
    expect(vault.listCookieJars("p").map((j) => j.label)).toEqual(["b"]);
    expect(vault.list("p")).toHaveLength(1);
    expect(vault.clear("p")).toBe(2);
    expect(vault.listCookieJars("p")).toEqual([]);
    expect(vault.list("p")).toEqual([]);
  });

  it("loads a vault file written before cookie jars existed", () => {
    const { vault, raw, setFile } = fakeVault();
    setFile({
      version: 1,
      profiles: {
        p: [
          {
            id: "old",
            origin: "https://a.example",
            username: "me",
            sealed: "sealed:cHc=",
            createdAt: 1,
          },
        ] as Any,
      },
    });
    expect(vault.listCookieJars("p")).toEqual([]);
    expect(vault.cookiesForHost("p", "example.com", NOW)).toEqual([]);
    expect(vault.list("p").map((l) => l.id)).toEqual(["old"]);
    vault.addCookieJar("p", { label: "a", source: "s", cookies: [cookie({})] });
    expect(vault.list("p").map((l) => l.id)).toEqual(["old"]);
    expect(JSON.parse(raw()).version).toBe(1);
  });
});

describe("cookies.txt import IPC", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  async function setup(
    options: { mainSender?: boolean; canStore?: boolean; noFile?: boolean } = {},
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cookies-txt-test-"));
    dirs.push(dir);
    const cookiesFile = path.join(dir, "my-cookies.txt");
    await fs.writeFile(cookiesFile, SAMPLE);
    const handlers = new Map<string, (event: unknown, data: unknown) => Promise<Any> | Any>();
    let file: VaultFile | undefined;
    const sealer: Sealer = {
      available: () => options.canStore !== false,
      seal: (plain) => `s${Buffer.from(plain).toString("base64")}`,
      open: (sealed) => Buffer.from(sealed.slice(1), "base64").toString(),
    };
    const vault = new BrowserVault(
      { load: () => file, save: (value) => void (file = JSON.parse(JSON.stringify(value))) },
      sealer,
      () => NOW * 1000,
    );
    const confirm = vi.fn(async (_options: { message: string; detail: string }) => true);
    const setCookie = vi.fn(async (_details: CookieSetDetails) => undefined);
    const shredFile = vi.fn(async (_file: string) => undefined);
    registerBrowserCredentialsIpc({
      ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
      isMainWindowSender: () => options.mainSender !== false,
      vault,
      external: { platform: "linux" } as Any,
      sessions: new ImportSessions(),
      cookieJar: () => ({ set: setCookie }),
      getTabContents: async () => null,
      pickPasswordFile: async () => null,
      pickCookiesFile: async () => (options.noFile ? null : cookiesFile),
      confirm,
      promptBiometric: null,
      shredFile,
      now: () => NOW * 1000,
    });
    const call = (channel: string, data: unknown) => handlers.get(channel)!({}, data);
    const prepare = () =>
      call(IPC_CHANNELS.BROWSER_IMPORT_PREPARE, { workspaceId: "ws", kind: "cookies_txt" });
    return { call, prepare, vault, confirm, setCookie, shredFile, cookiesFile };
  }

  const SECRETS = ["domain-secret", "host-only-secret", "http-only"];
  const leaksNothing = (value: unknown) => {
    for (const secret of SECRETS) expect(JSON.stringify(value)).not.toContain(secret);
  };

  it("prepares a cookies.txt file with counts and sites only", async () => {
    const { prepare } = await setup();
    const result = await prepare();
    expect(result).toMatchObject({
      success: true,
      kind: "cookies_txt",
      source: "cookies.txt file",
      cookies: 4,
      logins: 0,
      skipped: { invalid: 0, expired: 0, tooMany: 0 },
    });
    expect(result.sampleSites).toEqual(
      expect.arrayContaining(["example.com", "app.example.com", "example.org"]),
    );
    leaksNothing(result);
  });

  it("saves an encrypted jar by default and leaves the in-app browser alone", async () => {
    const { prepare, call, vault, confirm, setCookie } = await setup();
    const { token } = await prepare();
    const result = await call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, { workspaceId: "ws", token });
    expect(result).toMatchObject({
      success: true,
      cookiesSaved: 4,
      cookies: 0,
      logins: 0,
      canDeleteFile: true,
    });
    leaksNothing(result);
    expect(setCookie).not.toHaveBeenCalled();
    const [prompt] = confirm.mock.calls[0];
    expect(prompt.message).toBe("Import 4 cookies from my-cookies.txt?");
    expect(prompt.detail).toContain("Cookies can sign CoWork in to these sites.");
    expect(prompt.detail).toContain("Camofox");
    expect(prompt.detail).not.toContain("in-app browser");
    expect(vault.listCookieJars("ws")).toEqual([
      expect.objectContaining({ label: "my-cookies.txt", source: "cookies.txt file", cookies: 4 }),
    ]);
    expect(
      vault
        .cookiesForHost("ws", "app.example.com")
        .map((c) => c.value)
        .sort(),
    ).toEqual(["domain-secret", "host-only-secret", "http-only"]);

    const list = await call(IPC_CHANNELS.BROWSER_VAULT_LIST, { workspaceId: "ws" });
    expect(list.cookieJars).toHaveLength(1);
    leaksNothing(list);
    expect(JSON.stringify(list)).not.toContain('"sealed"');
  });

  it("can add the cookies to the in-app browser only, or to both", async () => {
    const browserOnly = await setup();
    const first = await browserOnly.prepare();
    const result = await browserOnly.call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, {
      workspaceId: "ws",
      token: first.token,
      saveToVault: false,
      applyToBrowser: true,
    });
    expect(result).toMatchObject({ success: true, cookies: 4, cookiesSaved: 0 });
    leaksNothing(result);
    expect(browserOnly.setCookie).toHaveBeenCalledTimes(4);
    expect(browserOnly.vault.listCookieJars("ws")).toEqual([]);
    expect(browserOnly.confirm.mock.calls[0][0].detail).toContain("in-app browser");

    const both = await setup();
    const second = await both.prepare();
    expect(
      await both.call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, {
        workspaceId: "ws",
        token: second.token,
        applyToBrowser: true,
      }),
    ).toMatchObject({ success: true, cookies: 4, cookiesSaved: 4 });
    expect(both.vault.listCookieJars("ws")).toHaveLength(1);
  });

  it("refuses an empty selection, a declined confirmation and a vault without encryption", async () => {
    const none = await setup();
    const a = await none.prepare();
    expect(
      await none.call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, {
        workspaceId: "ws",
        token: a.token,
        saveToVault: false,
      }),
    ).toMatchObject({ success: false, code: "empty" });
    expect(none.confirm).not.toHaveBeenCalled();

    const declined = await setup();
    declined.confirm.mockResolvedValueOnce(false);
    const b = await declined.prepare();
    expect(
      await declined.call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, {
        workspaceId: "ws",
        token: b.token,
      }),
    ).toMatchObject({ success: false, code: "cancelled" });
    expect(declined.vault.listCookieJars("ws")).toEqual([]);

    const locked = await setup({ canStore: false });
    const c = await locked.prepare();
    expect(
      await locked.call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, { workspaceId: "ws", token: c.token }),
    ).toMatchObject({ success: false, code: "encryption_unavailable" });
    expect(locked.confirm).not.toHaveBeenCalled();
  });

  it("offers to shred the cookies file with wording for cookies", async () => {
    const { prepare, call, confirm, shredFile, cookiesFile } = await setup();
    const { token } = await prepare();
    await call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, { workspaceId: "ws", token });
    const result = await call(IPC_CHANNELS.BROWSER_IMPORT_DELETE_FILE, { token });
    expect(result).toEqual({ success: true, deleted: true });
    expect(confirm.mock.calls[1][0].message).toBe("Delete the cookies file?");
    expect(shredFile).toHaveBeenCalledWith(cookiesFile);
  });

  it("removes a jar by kind and rejects unknown kinds", async () => {
    const { prepare, call, vault } = await setup();
    const { token } = await prepare();
    await call(IPC_CHANNELS.BROWSER_IMPORT_COMMIT, { workspaceId: "ws", token });
    const [jar] = vault.listCookieJars("ws");
    expect(
      await call(IPC_CHANNELS.BROWSER_VAULT_REMOVE, { workspaceId: "ws", id: jar.id, kind: "x" }),
    ).toEqual({ success: false });
    expect(
      await call(IPC_CHANNELS.BROWSER_VAULT_REMOVE, { workspaceId: "ws", id: jar.id }),
    ).toEqual({ success: false });
    expect(
      await call(IPC_CHANNELS.BROWSER_VAULT_REMOVE, {
        workspaceId: "ws",
        id: jar.id,
        kind: "cookie_jar",
      }),
    ).toEqual({ success: true });
    expect(vault.listCookieJars("ws")).toEqual([]);
  });

  it("reports a cancelled picker and an oversized file", async () => {
    const cancelled = await setup({ noFile: true });
    expect(await cancelled.prepare()).toMatchObject({ success: false, code: "cancelled" });
    const { prepare, cookiesFile } = await setup();
    await fs.writeFile(cookiesFile, "#".repeat(MAX_COOKIES_TXT_BYTES + 1));
    expect(await prepare()).toMatchObject({ success: false, code: "bad_file" });
  });

  it("denies every cookies.txt call from a sender that is not the main window", async () => {
    const { call, setCookie, vault } = await setup({ mainSender: false });
    for (const [channel, data] of [
      [IPC_CHANNELS.BROWSER_IMPORT_PREPARE, { workspaceId: "ws", kind: "cookies_txt" }],
      [IPC_CHANNELS.BROWSER_IMPORT_COMMIT, { workspaceId: "ws", token: "x".repeat(64) }],
      [IPC_CHANNELS.BROWSER_VAULT_LIST, { workspaceId: "ws" }],
      [IPC_CHANNELS.BROWSER_VAULT_REMOVE, { workspaceId: "ws", id: "id", kind: "cookie_jar" }],
    ] as const) {
      const result = await call(channel, data);
      expect(result.success).toBe(false);
      expect(result.cookieJars).toBeUndefined();
    }
    expect(setCookie).not.toHaveBeenCalled();
    expect(vault.listCookieJars("ws")).toEqual([]);
  });
});
