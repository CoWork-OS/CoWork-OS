import { createCipheriv, createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_BROWSERS,
  decryptChromiumValue,
  defaultExternalBrowserDeps,
  deriveChromiumKey,
  detectBrowsers,
  ImportError,
  readChromiumCookies,
  readChromiumLogins,
  readFirefoxCookies,
  type ExternalBrowserDeps,
} from "../external-browsers";

const chrome = CHROMIUM_BROWSERS[0];

function seal(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

describe("Chromium decryption", () => {
  it("matches an independent OpenSSL vector", () => {
    // openssl kdf PBKDF2 (SHA1, salt "saltysalt", 1003 rounds) over "peanuts", then AES-128-CBC.
    const key = deriveChromiumKey(Buffer.from("peanuts"));
    expect(key.toString("hex")).toBe("d9a09d499b4e1b7461f28e67972c6dbd");
    const encrypted = Buffer.concat([
      Buffer.from("v10"),
      Buffer.from("9febc86f409db9ef3658501519b7a223", "hex"),
    ]);
    expect(decryptChromiumValue(encrypted, key)?.toString()).toBe("peanuts");
  });

  it("returns null for unknown formats or a wrong key", () => {
    const key = deriveChromiumKey(Buffer.from("a"));
    expect(decryptChromiumValue(Buffer.from("v11abc"), key)).toBeNull();
    expect(decryptChromiumValue(Buffer.alloc(0), key)).toBeNull();
    const sealed = seal(Buffer.from("secret"), key);
    expect(
      decryptChromiumValue(sealed, deriveChromiumKey(Buffer.from("b")))?.toString() ?? null,
    ).not.toBe("secret");
  });
});

describe("reading another browser", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function fakeHome() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "import-test-"));
    dirs.push(home);
    const root = path.join(home, "Library/Application Support", chrome.dir);
    await fs.mkdir(path.join(root, "Default/Network"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Me" }, "../evil": { name: "x" } } },
      }),
    );
    await fs.writeFile(path.join(root, "Default/Network/Cookies"), "db");
    await fs.writeFile(path.join(root, "Default/Login Data"), "db");
    return home;
  }

  function deps(
    home: string,
    rowsFor: (sql: string) => Array<Record<string, unknown>>,
  ): ExternalBrowserDeps {
    const base = defaultExternalBrowserDeps();
    return {
      ...base,
      platform: "darwin",
      homeDir: home,
      keychainSecret: vi.fn(async () => Buffer.from("peanuts")),
      querySqlite: vi.fn(async (_db, sql) => rowsFor(sql)),
    };
  }

  it("detects browsers and only well-formed profile folders", async () => {
    const home = await fakeHome();
    const found = await detectBrowsers(deps(home, () => []));
    expect(found).toEqual([
      {
        id: "chrome",
        name: "Google Chrome",
        kind: "chromium",
        profiles: [{ id: "Default", name: "Me" }],
      },
    ]);
    expect(await detectBrowsers({ ...deps(home, () => []), platform: "linux" })).toEqual([]);
  });

  it("decrypts cookies, drops the host hash prefix and converts expiry", async () => {
    const home = await fakeHome();
    const key = deriveChromiumKey(Buffer.from("peanuts"));
    const host = ".example.com";
    const hashed = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from("tok")]);
    const d = deps(home, () => [
      {
        host_key: host,
        name: "sid",
        value: "",
        enc: seal(hashed, key).toString("hex"),
        path: "/",
        expires_utc: (1_900_000_000 + 11_644_473_600) * 1_000_000,
        is_secure: 1,
        is_httponly: 1,
        samesite: 1,
      },
      {
        host_key: "a.com",
        name: "bad",
        value: "",
        enc: "763130ff",
        path: "/",
        expires_utc: 0,
        is_secure: 0,
        is_httponly: 0,
        samesite: -1,
      },
    ]);
    const cookies = await readChromiumCookies(d, chrome, "Default");
    expect(cookies).toEqual([
      {
        host,
        name: "sid",
        value: "tok",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expiresAt: 1_900_000_000,
      },
    ]);
  });

  it("reads logins, skipping non-web origins and undecryptable rows", async () => {
    const home = await fakeHome();
    const key = deriveChromiumKey(Buffer.from("peanuts"));
    const d = deps(home, () => [
      {
        origin_url: "https://a.example/login",
        username_value: "me",
        enc: seal(Buffer.from("pw1"), key).toString("hex"),
      },
      {
        origin_url: "chrome://x",
        username_value: "me",
        enc: seal(Buffer.from("pw2"), key).toString("hex"),
      },
      { origin_url: "https://b.example/", username_value: "me", enc: "00" },
    ]);
    expect(await readChromiumLogins(d, chrome, "Default")).toEqual([
      { origin: "https://a.example", username: "me", password: "pw1" },
    ]);
  });

  it("rejects profile ids that could leave the browser folder", async () => {
    const home = await fakeHome();
    const d = deps(home, () => []);
    await expect(readChromiumCookies(d, chrome, "../../etc")).rejects.toBeInstanceOf(ImportError);
    await expect(readFirefoxCookies(d, "../x")).rejects.toBeInstanceOf(ImportError);
  });

  it("does not read anything when the Keychain is refused", async () => {
    const home = await fakeHome();
    const d = deps(home, () => []);
    d.keychainSecret = vi.fn(async () => {
      throw new ImportError("keychain_denied", "no");
    });
    await expect(readChromiumLogins(d, chrome, "Default")).rejects.toMatchObject({
      code: "keychain_denied",
    });
    expect(d.querySqlite).not.toHaveBeenCalled();
  });
});
