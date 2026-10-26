import { describe, expect, it, vi } from "vitest";
import { SECRET_SOURCES_IPC, type SecretSourcesStatus } from "../../../../shared/secret-references";
import type { SecretReferenceResolver } from "../resolver";
import { registerSecretSourcesIpc } from "../secret-sources-ipc";
import {
  applySecretSourceSettingsUpdate,
  type SecretSourceSettings,
  type SecretSourceSettingsStore,
} from "../secret-source-settings";

const STATUS: SecretSourcesStatus = {
  onepassword: { installed: true, serviceAccountConfigured: true, account: "" },
  bitwardenSecretsManager: { installed: false, accessTokenConfigured: false, serverUrl: "" },
  bitwarden: { installed: true, unlocked: false },
};

function setup() {
  const handlers = new Map<string, (event: unknown, data?: unknown) => unknown>();
  let stored: SecretSourceSettings = { version: 1 };
  const settings: SecretSourceSettingsStore = {
    load: () => stored,
    update: (change) => (stored = applySecretSourceSettingsUpdate(stored, change)),
  };
  const resolver = {
    status: vi.fn(async () => STATUS),
    clear: vi.fn(),
    unlockBitwarden: vi.fn(async () => {}),
    lockBitwarden: vi.fn(),
    test: vi.fn(async () => ({ ok: true, source: "onepassword", length: 12 })),
  };
  let now = 0;
  registerSecretSourcesIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    (event) => event === "owner",
    { resolver: resolver as unknown as SecretReferenceResolver, settings, now: () => now },
  );
  const call = (channel: string, data?: unknown, event: unknown = "owner") =>
    handlers.get(channel)!(event, data) as Promise<Record<string, unknown>>;
  return { call, resolver, stored: () => stored, advance: (ms: number) => (now += ms) };
}

describe("Password Managers IPC", () => {
  it("refuses callers other than the app window", async () => {
    const { call, resolver } = setup();
    await expect(call(SECRET_SOURCES_IPC.status, undefined, "page")).resolves.toEqual({
      success: false,
      error: "denied",
    });
    await expect(
      call(SECRET_SOURCES_IPC.unlockBitwarden, { password: "x" }, "page"),
    ).resolves.toMatchObject({ success: false });
    expect(resolver.unlockBitwarden).not.toHaveBeenCalled();
  });

  it("saves tokens, clears that vault's cache, and never returns the token", async () => {
    const { call, resolver, stored } = setup();
    const response = await call(SECRET_SOURCES_IPC.save, {
      onepasswordServiceAccountToken: "ops_secret_token",
    });
    expect(response).toEqual({ success: true, status: STATUS });
    expect(JSON.stringify(response)).not.toContain("ops_secret_token");
    expect(stored().onepassword?.serviceAccountToken).toBe("ops_secret_token");
    expect(resolver.clear).toHaveBeenCalledWith("onepassword");
    expect(resolver.clear).not.toHaveBeenCalledWith("bitwarden-secrets-manager");
  });

  it("rejects unknown fields and invalid values", async () => {
    const { call } = setup();
    await expect(call(SECRET_SOURCES_IPC.save, { openaiApiKey: "sk" })).resolves.toEqual({
      success: false,
      error: "Invalid settings.",
    });
    await expect(
      call(SECRET_SOURCES_IPC.save, { bitwardenSecretsManagerServerUrl: "http://vault.example" }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("https") });
  });

  it("limits unlock attempts per minute", async () => {
    const { call, resolver, advance } = setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(
        call(SECRET_SOURCES_IPC.unlockBitwarden, { password: "guess" }),
      ).resolves.toEqual({ success: true });
    }
    await expect(
      call(SECRET_SOURCES_IPC.unlockBitwarden, { password: "guess" }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("Too many") });
    advance(60_000);
    await expect(call(SECRET_SOURCES_IPC.unlockBitwarden, { password: "guess" })).resolves.toEqual({
      success: true,
    });
    expect(resolver.unlockBitwarden).toHaveBeenCalledTimes(6);
  });

  it("tests a reference and returns only its length", async () => {
    const { call } = setup();
    await expect(
      call(SECRET_SOURCES_IPC.test, { reference: "op://Private/OpenAI/credential" }),
    ).resolves.toEqual({ success: true, result: { ok: true, source: "onepassword", length: 12 } });
    await expect(call(SECRET_SOURCES_IPC.test, { reference: "" })).resolves.toMatchObject({
      success: false,
    });
  });
});
