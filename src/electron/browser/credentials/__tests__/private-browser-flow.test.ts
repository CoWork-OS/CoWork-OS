import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCredentialService, type CredentialTarget } from "../browser-credential-service";
import { BrowserVault, type VaultFile } from "../vault";
import { PasswordManagerVault } from "../password-managers";
import { maskFilledPasswords, forgetFilledPasswords } from "../autofill";
import { authenticatorCode, parseAuthenticator } from "../totp";
import { registerBrowserVaultIpc } from "../browser-vault-ipc";
import { BROWSER_VAULT_IPC } from "../../../../shared/browser-vault";
import { privateCaptureGuard } from "../private-capture-guard";

const services: BrowserCredentialService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  forgetFilledPasswords("task");
  vi.useRealTimers();
});
function setup(
  options: { canPrompt?: boolean; canStore?: boolean; approve?: boolean; ttl?: number } = {},
) {
  let file: VaultFile | undefined;
  let sequence = 0;
  const vault = new BrowserVault(
    {
      load: () => file,
      save: (value) => {
        file = structuredClone(value);
      },
    },
    {
      available: () => options.canStore !== false,
      seal: (value) => Buffer.from(value).toString("base64"),
      open: (value) => Buffer.from(value, "base64").toString(),
    },
    () => 1000,
    () => `item-${++sequence}`,
  );
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    url: "https://shop.example/login",
    isDestroyed: () => false,
    getURL() {
      return this.url;
    },
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world, scripts) =>
      scripts[0].code.startsWith("globalThis")
        ? true
        : scripts[0].code.includes("const inspectOnly = true")
          ? { fillable: true }
          : { success: true, filledFields: 2, filledPassword: true },
    ),
  });
  let target: CredentialTarget | null = { contents, workspaceId: "workspace", tabId: "tab" };
  const authorize = vi.fn(async () => options.approve !== false);
  const audit = vi.fn();
  const managers = new PasswordManagerVault(async () => {
    throw new Error("not installed");
  });
  const service = new BrowserCredentialService(
    {
      target: async () => target,
      canPrompt: () => options.canPrompt !== false,
      changed: vi.fn(),
      authorize,
      audit,
    },
    vault,
    managers,
    Date.now,
    options.ttl,
  );
  services.push(service);
  const answer = async (fields: Record<string, string>, remember = true) => {
    await vi.waitFor(() => expect(service.prompts()).toHaveLength(1));
    const prompt = service.prompts()[0];
    expect(service.respond(prompt.id, { fields, remember })).toBe(true);
    service.dismissPrompt(prompt.id);
    return prompt;
  };
  const login = () =>
    vault.addItem("workspace", "login", "https://shop.example", {
      username: "fixture@example.test",
      password: "fixture-secret-canary",
    });
  return {
    service,
    vault,
    contents,
    authorize,
    audit,
    managers,
    answer,
    login,
    raw: () => JSON.stringify(file),
    setTarget: (next: CredentialTarget | null) => {
      target = next;
    },
  };
}

describe("private browser credentials", () => {
  it("collects, seals, and fills a first login without secret-bearing results or audit events", async () => {
    const f = setup();
    const pending = f.service.execute("task", { action: "save_login" });
    const prompt = await f.answer({
      username: "fixture@example.test",
      password: "fixture-secret-canary",
    });
    const result = await pending;
    expect(result).toMatchObject({ success: true, authenticationVerified: false });
    expect(
      JSON.stringify([result, prompt, f.audit.mock.calls, f.vault.listItems("workspace"), f.raw()]),
    ).not.toContain("fixture-secret-canary");
    expect(f.vault.listItems("workspace")).toHaveLength(1);
    expect(
      maskFilledPasswords("task", "default", { text: "echo fixture-secret-canary" }).text,
    ).not.toContain("fixture-secret-canary");
    expect(f.service.hasPrivateSurface()).toBe(true);
    f.contents.emit("did-navigate");
    expect(f.service.hasPrivateSurface()).toBe(false);
  });
  it("supports use-once without saving and keeps legacy imported logins usable", async () => {
    const f = setup();
    const pending = f.service.execute("task", { action: "save_login" });
    await f.answer({ username: "fixture", password: "one-time-canary" }, false);
    expect(await pending).toMatchObject({ success: true });
    expect(f.vault.listItems("workspace")).toEqual([]);
    f.vault.addMany("workspace", [
      { origin: "https://shop.example", username: "legacy", password: "legacy-canary" },
    ]);
    expect(
      await f.service.execute("task", {
        action: "fill",
        handle: f.vault.listItems("workspace")[0].id,
      }),
    ).toMatchObject({ success: true });
  });
  it.each(["navigation", "tab", "workspace", "takeover"])(
    "refuses a stale answer after %s",
    async (change) => {
      const f = setup();
      const pending = f.service.execute("task", { action: "save_login" });
      await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
      if (change === "navigation") f.contents.url = "https://evil.example/login";
      if (change === "tab")
        f.setTarget({ contents: f.contents, workspaceId: "workspace", tabId: "another-tab" });
      if (change === "workspace")
        f.setTarget({ contents: f.contents, workspaceId: "other-workspace", tabId: "tab" });
      if (change === "takeover") f.setTarget(null);
      await f.answer({ username: "fixture", password: "must-not-be-filled" });
      expect(await pending).toMatchObject({ success: false, error: "page_or_authority_changed" });
      expect(f.vault.listItems("workspace")).toEqual([]);
      expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels the prompt on same-URL reload and rejects replayed responses", async () => {
    const f = setup();
    const pending = f.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
    const id = f.service.prompts()[0].id;
    f.contents.emit("did-start-navigation");
    expect(await pending).toMatchObject({ success: false });
    expect(f.service.respond(id, { fields: { password: "late", username: "late" } })).toBe(false);
    expect(f.vault.listItems("workspace")).toEqual([]);
  });
  it("does not re-prompt after decline and never prompts in headless sessions", async () => {
    const f = setup();
    const pending = f.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
    f.service.respond(f.service.prompts()[0].id, null);
    expect(await pending).toMatchObject({ success: false, error: "user_declined" });
    expect(await f.service.execute("task", { action: "save_login" })).toMatchObject({
      success: false,
      error: "user_declined",
    });
    expect(
      await setup({ canPrompt: false }).service.execute("task", { action: "save_login" }),
    ).toMatchObject({ success: false, error: "prompt_unavailable" });
  });
  it("expires private prompts and releases pending tool calls on task cancellation", async () => {
    const f = setup({ ttl: 15 });
    expect(await f.service.execute("task", { action: "save_login" })).toMatchObject({
      success: false,
      error: "user_declined",
    });
    const g = setup();
    const pending = g.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(g.service.prompts()).toHaveLength(1));
    g.service.cancelTask("task");
    expect(await pending).toMatchObject({ success: false });
    expect(g.service.prompts()).toEqual([]);
  });
  it("keeps captures blocked until the owner acknowledges that a closed form was cleared", async () => {
    const f = setup();
    const operation = f.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
    const id = f.service.prompts()[0].id;
    expect(f.service.dismissPrompt(id)).toBe(false);
    f.service.respond(id, null);
    await operation;
    expect(f.service.prompts()).toEqual([]);
    expect(() => privateCaptureGuard()).toThrow(/Private browser input/);
    const handlers = new Map<string, Any>();
    registerBrowserVaultIpc(
      { handle: (name, handler) => handlers.set(name, handler) },
      f.service,
      (event) => event === true,
    );
    expect(handlers.get(BROWSER_VAULT_IPC.dismiss)(false, id).success).toBe(false);
    expect(() => privateCaptureGuard()).toThrow(/Private browser input/);
    expect(handlers.get(BROWSER_VAULT_IPC.dismiss)(true, id).success).toBe(true);
    expect(privateCaptureGuard()).not.toThrow();
  });
  it("binds saved passwords AND OTP seeds to the selected login origin", async () => {
    const f = setup();
    const item = f.vault.addItem("workspace", "login", "https://other.example", {
      username: "fixture",
      password: "secret",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(await f.service.execute("task", { action: "fill", handle: item.id })).toMatchObject({
      success: false,
      error: "login_not_available_for_origin",
    });
    expect(
      await f.service.execute("task", { action: "enter_code", handle: item.id }),
    ).toMatchObject({ success: false, error: "login_not_available_for_origin" });
    expect(f.service.prompts()).toEqual([]);
  });
  it("generates TOTP privately or collects a one-time code without persisting it", async () => {
    const f = setup();
    const item = f.vault.addItem("workspace", "login", "https://shop.example", {
      username: "fixture",
      password: "secret",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(
      await f.service.execute("task", { action: "enter_code", handle: item.id }),
    ).toMatchObject({ success: true });
    expect(f.service.prompts()).toEqual([]);
    expect(f.authorize).toHaveBeenCalledWith(item, "https://shop.example", "code");
    const pending = f.service.execute("task", { action: "enter_code" });
    await f.answer({ code: "987654" });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(JSON.stringify(result) + f.raw()).not.toContain("987654");
    expect(maskFilledPasswords("task", "default", "987654")).not.toContain("987654");
    const snapshot = maskFilledPasswords("task", "default", {
      nodes: [..."987654"].map((value, i) => ({ ref: `b2:s:${i + 1}`, value })),
    });
    expect(snapshot.nodes.map((node) => node.value)).toEqual(Array(6).fill("[saved password]"));
    expect(snapshot.nodes[0].ref).toBe("b2:s:1");
  });
  it("declines saved OTP before resolving seeds and suppresses automatic retry", async () => {
    const f = setup({ approve: false });
    const item = f.vault.addItem("workspace", "login", "https://shop.example", {
      username: "fixture",
      password: "secret",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    const resolve = vi.spyOn(f.vault, "withItemSecret");
    expect(
      await f.service.execute("task", { action: "enter_code", handle: item.id }),
    ).toMatchObject({ success: false, error: "user_declined" });
    expect(resolve).not.toHaveBeenCalled();
    expect(
      await f.service.execute("task", { action: "enter_code", handle: item.id }),
    ).toMatchObject({ success: false, error: "user_declined" });
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it("offers one-use entry when OS secret storage is unavailable", async () => {
    const f = setup({ canStore: false });
    const operation = f.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
    expect(f.service.prompts()[0].canRemember).toBe(false);
    await f.answer({ username: "fixture", password: "one-use-secret" }, false);
    expect(await operation).toMatchObject({ success: true });
    expect(f.vault.listItems("workspace")).toEqual([]);
  });
  it("requires card approval before resolving secrets and never saves security codes", async () => {
    const f = setup();
    const card = f.vault.addItem("workspace", "payment", "https://shop.example", {
      cardNumber: "4111111111111111",
      expMonth: "12",
      expYear: "2030",
      cvc: "987",
    });
    expect(
      await f.vault.withItemSecret("workspace", card.id, (fields) => Boolean(fields.cvc)),
    ).toBe(false);
    const resolve = vi.spyOn(f.vault, "withItemSecret");
    expect(
      await f.service.execute("task", { action: "fill", handle: card.id }, async () => false),
    ).toMatchObject({ success: false, error: "payment_declined" });
    expect(resolve).not.toHaveBeenCalled();
    const pending = f.service.executeFromUser("task", { action: "fill", handle: card.id });
    const prompt = await f.answer({ cvc: "987" }, false);
    expect(prompt.kind).toBe("card_code");
    expect(await pending).toMatchObject({ success: true, kind: "payment" });
    expect(f.authorize).toHaveBeenCalled();
    expect(f.raw()).not.toContain("4111111111111111");
    expect(maskFilledPasswords("task", "default", "4111111111111111 987")).not.toContain("987");
  });
  it("rechecks authority after approval and refuses concurrent operations", async () => {
    const f = setup();
    const item = f.login();
    f.authorize.mockImplementationOnce(async () => {
      f.setTarget(null);
      return true;
    });
    expect(await f.service.execute("task", { action: "fill", handle: item.id })).toMatchObject({
      success: false,
      error: "page_or_authority_changed",
    });
    const g = setup();
    const pending = g.service.execute("task", { action: "save_login" });
    await vi.waitFor(() => expect(g.service.prompts()).toHaveLength(1));
    expect(await g.service.execute("task", { action: "save_login" })).toMatchObject({
      success: false,
      error: "credential_operation_pending",
    });
    g.service.cancelTask("task");
    await pending;
  });
  it("does not expose private prompts or accept answers from page/frame IPC senders", async () => {
    const f = setup();
    const handlers = new Map<string, (event: unknown, data?: unknown) => unknown>();
    registerBrowserVaultIpc(
      { handle: (name, handler) => handlers.set(name, handler) },
      f.service,
      (event) => (event as { owner?: boolean })?.owner === true,
    );
    expect(
      await handlers.get(BROWSER_VAULT_IPC.command)!(
        {},
        { taskId: "task", command: { action: "save_login" } },
      ),
    ).toMatchObject({ success: false });
    expect(handlers.get(BROWSER_VAULT_IPC.prompts)!({})).toEqual([]);
    expect(
      handlers.get(BROWSER_VAULT_IPC.respond)!(
        {},
        { id: "forged", answer: { fields: { password: "x" } } },
      ),
    ).toEqual({ success: false });
  });
});

describe("fill results and uncertain outcomes", () => {
  it("whitelists results even if a browser helper accidentally returns a secret", async () => {
    const f = setup();
    const login = f.login();
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world, scripts) =>
      scripts[0].code.startsWith("globalThis")
        ? true
        : { success: true, filledFields: 1, password: "fixture-secret-canary" },
    );
    const result = await f.service.execute("task", { action: "fill", handle: login.id });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-secret-canary");
  });
  it("reports an unknown outcome after an interrupted write and forbids blind retry", async () => {
    const f = setup();
    const login = f.login();
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world, scripts) => {
      if (scripts[0].code.startsWith("globalThis")) return true;
      throw new Error("context destroyed fixture-secret-canary");
    });
    const result = await f.service.execute("task", { action: "fill", handle: login.id });
    expect(result).toMatchObject({
      success: false,
      error: "fill_outcome_unknown",
      outcomeUnknown: true,
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret-canary");
  });
});

describe("passkey handoff", () => {
  it("does not resolve an OTP seed or prompt for a code when no code input exists", async () => {
    const f = setup();
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world, scripts) =>
      scripts[0].code.startsWith("globalThis") ? true : { fillable: false },
    );
    expect(await f.service.execute("task", { action: "enter_code" })).toMatchObject({
      success: false,
      error: "no_code_field",
      manualActionRequired: true,
    });
    expect(f.service.prompts()).toEqual([]);
  });
});

describe("credential cancellation", () => {
  it("aborts a private prompt and refuses a late answer", async () => {
    const f = setup();
    const abort = new AbortController();
    const pending = f.service.execute("task", { action: "save_login" }, undefined, abort.signal);
    await vi.waitFor(() => expect(f.service.prompts()).toHaveLength(1));
    const id = f.service.prompts()[0].id;
    abort.abort();
    expect(await pending).toMatchObject({ success: false });
    expect(
      f.service.respond(id, { fields: { username: "fixture", password: "late-secret" } }),
    ).toBe(false);
    expect(f.vault.listItems("workspace")).toEqual([]);
    expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });
  it("does not fill if cancelled during native approval", async () => {
    const f = setup();
    const abort = new AbortController();
    const login = f.login();
    f.authorize.mockImplementationOnce(async () => {
      abort.abort();
      return true;
    });
    expect(
      await f.service.execute(
        "task",
        { action: "fill", handle: login.id },
        undefined,
        abort.signal,
      ),
    ).toMatchObject({ success: false, error: "cancelled" });
    expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });
});

describe("RFC 6238", () => {
  it.each([
    [59000, "94287082"],
    [1111111109000, "07081804"],
    [1111111111000, "14050471"],
  ])("honors RFC test vector %i", (at, code) => {
    expect(
      authenticatorCode(
        "otpauth://totp/test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8",
        Number(at),
      ),
    ).toBe(code);
  });
  it("rejects invalid seeds, HOTP, and unsupported parameters", () => {
    for (const seed of [
      "bad-seed",
      "otpauth://hotp/test?secret=JBSWY3DPEHPK3PXP",
      "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&digits=99",
    ])
      expect(() => parseAuthenticator(seed)).toThrow();
  });
});
