import { describe, expect, it, vi } from "vitest";
import {
  buildFillScript,
  fillLogin,
  forgetFilledPasswords,
  maskFilledPasswords,
  registerFilledPassword,
} from "../autofill";
import { registerBrowserCredentialsIpc } from "../browser-credentials-ipc";
import { ImportSessions } from "../import-session";
import { BrowserVault, type Sealer, type VaultFile } from "../vault";
import { IPC_CHANNELS } from "../../../../shared/types";

const page = (url: string, result: unknown = { passwordField: true, usernameField: true }) => ({
  getURL: () => url,
  isDestroyed: () => false,
  executeJavaScriptInIsolatedWorld: vi.fn(async () => result),
});

describe("fillLogin", () => {
  const login = { origin: "https://a.example", username: "me", password: "pw" };
  it("fills only when the live page origin matches exactly", async () => {
    const good = page("https://a.example/login");
    expect(await fillLogin(good, login, () => undefined)).toMatchObject({ ok: true });
    expect(good.executeJavaScriptInIsolatedWorld.mock.calls[0][0]).not.toBe(0);
    for (const url of [
      "https://a.example.evil.com/",
      "http://a.example/",
      "https://evil.example/",
      "about:blank",
    ]) {
      const bad = page(url);
      expect(await fillLogin(bad, login, () => undefined)).toEqual({
        ok: false,
        reason: "origin_mismatch",
      });
      expect(bad.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    }
  });
  it("reports a missing password field", async () => {
    expect(
      await fillLogin(page("https://a.example/", { passwordField: false }), login, () => undefined),
    ).toEqual({
      ok: false,
      reason: "no_password_field",
    });
  });
  it("embeds the values as JSON so they cannot break out of the script", () => {
    const script = buildFillScript('x"});alert(1);//', "p\\w'`${1}", "https://a.example");
    expect(script).toContain(
      JSON.stringify({ username: 'x"});alert(1);//', password: "p\\w'`${1}" }),
    );
  });
});

describe("masking filled passwords", () => {
  it("masks nested strings and keys for that tab only, then forgets", () => {
    registerFilledPassword("t", "s", "hunter2");
    const out = maskFilledPasswords("t", "s", {
      text: "pw hunter2!",
      list: ["hunter2"],
      nested: { hunter2: 1 },
    });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(maskFilledPasswords("t", "other", { text: "hunter2" })).toEqual({ text: "hunter2" });
    forgetFilledPasswords("t", "s");
    expect(maskFilledPasswords("t", "s", { text: "hunter2" })).toEqual({ text: "hunter2" });
  });
});

describe("credentials IPC trust", () => {
  function setup(mainSender = true) {
    const handlers = new Map<string, (event: unknown, data: unknown) => Promise<Any> | Any>();
    let file: VaultFile | undefined;
    const sealer: Sealer = { available: () => true, seal: (p) => `s${p}`, open: (s) => s.slice(1) };
    const vault = new BrowserVault({ load: () => file, save: (v) => void (file = v) }, sealer);
    vault.addMany("browser-profile:ws", [
      { origin: "https://a.example", username: "me", password: "pw" },
    ]);
    const confirm = vi.fn(async () => true);
    registerBrowserCredentialsIpc({
      ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
      isMainWindowSender: () => mainSender,
      vault,
      external: { platform: "linux" } as Any,
      sessions: new ImportSessions(),
      cookieJar: () => ({ set: async () => undefined }),
      getTabContents: async () => page("https://a.example/"),
      pickPasswordFile: async () => null,
      confirm,
      promptBiometric: null,
      shredFile: async () => undefined,
    });
    return { handlers, vault, confirm };
  }

  it("rejects every call from a sender that is not the main window", async () => {
    const { handlers } = setup(false);
    for (const channel of [
      IPC_CHANNELS.BROWSER_VAULT_FILL,
      IPC_CHANNELS.BROWSER_IMPORT_COMMIT,
      IPC_CHANNELS.BROWSER_VAULT_LIST,
      IPC_CHANNELS.BROWSER_VAULT_CLEAR,
    ]) {
      const result = await handlers.get(channel)!({}, { workspaceId: "ws", taskId: "t", id: "x" });
      expect(result.success).toBe(false);
    }
  });
  it("never returns a password when listing or filling", async () => {
    const { handlers } = setup();
    const list = await handlers.get(IPC_CHANNELS.BROWSER_VAULT_LIST)!({}, { workspaceId: "ws" });
    expect(JSON.stringify(list)).not.toContain('pw"');
    expect(JSON.stringify(list)).not.toContain('"password"');
    const fill = await handlers.get(IPC_CHANNELS.BROWSER_VAULT_FILL)!(
      {},
      { workspaceId: "ws", taskId: "t", id: "none" },
    );
    expect(fill.success).toBe(false);
  });
  it("asks natively before clearing", async () => {
    const { handlers, confirm } = setup();
    confirm.mockResolvedValueOnce(false);
    const result = await handlers.get(IPC_CHANNELS.BROWSER_VAULT_CLEAR)!({}, { workspaceId: "ws" });
    expect(result.success).toBe(false);
    expect(confirm).toHaveBeenCalled();
  });
  it("rejects an unknown or forged import token", async () => {
    const { handlers } = setup();
    const result = await handlers.get(IPC_CHANNELS.BROWSER_IMPORT_COMMIT)!(
      {},
      { workspaceId: "ws", token: "x".repeat(64) },
    );
    expect(result).toMatchObject({ success: false, code: "expired" });
  });
});
