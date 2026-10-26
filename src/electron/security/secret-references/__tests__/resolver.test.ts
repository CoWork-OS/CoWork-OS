import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordManagerVault } from "../../../browser/credentials/password-managers";
import { _resetResolvedSecretsForTests, redactResolvedSecrets } from "../known-secret-values";
import { SecretReferenceError, SecretReferenceResolver } from "../resolver";
import type { SecretCliResult } from "../secret-cli";
import {
  applySecretSourceSettingsUpdate,
  type SecretSourceSettings,
  type SecretSourceSettingsStore,
} from "../secret-source-settings";

const SECRET_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function ok(stdout: string): SecretCliResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}
function failed(stderr: string, extra: Partial<SecretCliResult> = {}): SecretCliResult {
  return { code: 1, stdout: "", stderr, timedOut: false, ...extra };
}

function store(initial: SecretSourceSettings = { version: 1 }): SecretSourceSettingsStore {
  let current = initial;
  return {
    load: () => current,
    update: (change) => (current = applySecretSourceSettingsUpdate(current, change)),
  };
}

function setup(
  options: {
    run?: (file: string, args: string[], env: NodeJS.ProcessEnv) => SecretCliResult;
    settings?: SecretSourceSettings;
    env?: NodeJS.ProcessEnv;
    managerRun?: (file: string, args: string[], env: NodeJS.ProcessEnv) => string;
  } = {},
) {
  let now = 1_000;
  const run = vi.fn(async (file: string, args: string[], env: NodeJS.ProcessEnv) =>
    options.run ? options.run(file, args, env) : ok("value-from-vault"),
  );
  const managerRun = vi.fn(async (file: string, args: string[], env: NodeJS.ProcessEnv) => {
    if (!options.managerRun) throw new Error("no manager");
    return options.managerRun(file, args, env);
  });
  const managers = new PasswordManagerVault(managerRun, () => now);
  const resolver = new SecretReferenceResolver({
    run,
    settings: store(options.settings),
    managers,
    env: options.env ?? { PATH: "/usr/bin", HOME: "/Users/tester", OPENAI_API_KEY: "sk-leak" },
    now: () => now,
    ttlMs: 60_000,
  });
  return { resolver, run, managerRun, advance: (ms: number) => (now += ms) };
}

afterEach(() => _resetResolvedSecretsForTests());

describe("SecretReferenceResolver", () => {
  it("passes plain values through without running anything", async () => {
    const { resolver, run } = setup();
    await expect(resolver.resolve("sk-plain-key")).resolves.toBe("sk-plain-key");
    await expect(resolver.resolve(undefined)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("reads a 1Password reference with op read and a minimal environment", async () => {
    const { resolver, run } = setup({
      settings: { version: 1, onepassword: { serviceAccountToken: "ops_token", account: "team" } },
      run: () => ok("sk-live-123456\n"),
    });

    await expect(resolver.resolve("op://Private/OpenAI/credential")).resolves.toBe(
      "sk-live-123456",
    );
    const [file, args, env] = run.mock.calls[0];
    expect(file).toBe("op");
    expect(args).toEqual([
      "read",
      "--no-newline",
      "--account",
      "team",
      "--",
      "op://Private/OpenAI/credential",
    ]);
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_token");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toContain("/usr/bin");
  });

  it("uses an op session from the environment when no service account is set", async () => {
    const { resolver, run } = setup({
      env: { PATH: "/usr/bin", OP_SESSION_team: "session-token", OPENAI_API_KEY: "sk-leak" },
    });
    await resolver.resolve("op://Private/OpenAI/credential");
    const env = run.mock.calls[0][2];
    expect(env.OP_SESSION_team).toBe("session-token");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("caches a value for the TTL and reads it again after", async () => {
    const { resolver, run, advance } = setup();
    await resolver.resolve("op://Private/OpenAI/credential");
    await resolver.resolve("op://Private/OpenAI/credential");
    expect(run).toHaveBeenCalledTimes(1);
    advance(61_000);
    await resolver.resolve("op://Private/OpenAI/credential");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent callers", async () => {
    const { resolver, run } = setup();
    const [a, b] = await Promise.all([
      resolver.resolve("op://Private/OpenAI/credential"),
      resolver.resolve("op://Private/OpenAI/credential"),
    ]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    [failed("", { spawnError: "ENOENT" }), "not_installed", "Install the 1Password CLI"],
    [failed("[ERROR] You are not currently signed in."), "auth_failed", "Unlock the 1Password app"],
    [
      failed('[ERROR] "OpenAI" isn\'t an item in the "Private" vault'),
      "not_found",
      "Check the vault",
    ],
    [failed("", { timedOut: true, code: null }), "timeout", "approve it and retry"],
    [ok(""), "empty_value", "the field is empty"],
  ] as const)("explains a failed 1Password read (%#)", async (result, kind, hint) => {
    const { resolver } = setup({ run: () => result });
    const error = await resolver.resolve("op://Private/OpenAI/credential").catch((e) => e);
    expect(error).toBeInstanceOf(SecretReferenceError);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain("op://Private/OpenAI/credential");
    expect(error.message).toContain(hint);
    // The CLI's own error text is never passed on.
    expect(error.message).not.toContain("[ERROR]");
  });

  it("does not cache a failed read", async () => {
    let attempt = 0;
    const { resolver, run } = setup({
      run: () => (attempt++ === 0 ? failed("not currently signed in") : ok("sk-second-try")),
    });
    await expect(resolver.resolve("op://Private/OpenAI/credential")).rejects.toThrow();
    await expect(resolver.resolve("op://Private/OpenAI/credential")).resolves.toBe("sk-second-try");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed reference instead of using it as a key", async () => {
    const { resolver, run } = setup();
    await expect(resolver.resolve("op://Private")).rejects.toMatchObject({
      kind: "invalid_reference",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reads a Bitwarden Secrets Manager secret with the stored access token", async () => {
    const { resolver, run } = setup({
      settings: {
        version: 1,
        bitwardenSecretsManager: {
          accessToken: "0.bws-token",
          serverUrl: "https://vault.bitwarden.eu",
        },
      },
      run: () => ok(JSON.stringify({ id: SECRET_ID, key: "OPENAI", value: "sk-bws-987654" })),
    });

    await expect(resolver.resolve(`bws://${SECRET_ID}`)).resolves.toBe("sk-bws-987654");
    const [file, args, env] = run.mock.calls[0];
    expect(file).toBe("bws");
    expect(args).toEqual([
      "secret",
      "get",
      SECRET_ID,
      "--output",
      "json",
      "--server-url",
      "https://vault.bitwarden.eu",
    ]);
    expect(env.BWS_ACCESS_TOKEN).toBe("0.bws-token");
  });

  it("asks for a Secrets Manager token when none is set up", async () => {
    const { resolver, run } = setup();
    await expect(resolver.resolve(`bws://${SECRET_ID}`)).rejects.toMatchObject({
      kind: "not_configured",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a revoked Secrets Manager token to a sign-in failure", async () => {
    const { resolver } = setup({
      settings: { version: 1, bitwardenSecretsManager: { accessToken: "0.bws-token" } },
      run: () => failed('[400 Bad Request] {"error":"invalid_client"}'),
    });
    await expect(resolver.resolve(`bws://${SECRET_ID}`)).rejects.toMatchObject({
      kind: "auth_failed",
    });
  });

  it("says Bitwarden is locked until it is unlocked, then reads the field", async () => {
    const { resolver, managerRun } = setup({
      managerRun: (_file, args, env) => {
        if (args[0] === "unlock") return "bw-session";
        expect(env.BW_SESSION).toBe("bw-session");
        if (args[0] === "get" && args[1] === "password") return "sk-bw-password\n";
        if (args[0] === "get" && args[1] === "item") {
          return JSON.stringify({ fields: [{ name: "API token", value: "tok-custom-field" }] });
        }
        throw new Error("unexpected");
      },
    });

    await expect(resolver.resolve("bw://OpenAI/password")).rejects.toMatchObject({
      kind: "locked",
    });
    await resolver.unlockBitwarden("master");
    await expect(resolver.resolve("bw://OpenAI/password")).resolves.toBe("sk-bw-password");
    await expect(resolver.resolve("bw://OpenAI/API token")).resolves.toBe("tok-custom-field");
    expect(managerRun).toHaveBeenCalledWith(
      "bw",
      ["get", "password", "OpenAI", "--nointeraction"],
      expect.anything(),
    );
  });

  it("forgets Bitwarden values when Bitwarden is locked again", async () => {
    const { resolver, managerRun } = setup({
      managerRun: (_file, args) => (args[0] === "unlock" ? "bw-session" : "sk-bw-password"),
    });
    await resolver.unlockBitwarden("master");
    await resolver.resolve("bw://OpenAI/password");
    resolver.lockBitwarden();
    await expect(resolver.resolve("bw://OpenAI/password")).rejects.toMatchObject({
      kind: "locked",
    });
    expect(managerRun).toHaveBeenCalledTimes(2);
  });

  it("uses BW_SESSION from the environment, for cowork run", async () => {
    const { resolver } = setup({
      env: { PATH: "/usr/bin", BW_SESSION: "exported-session" },
      managerRun: (_file, _args, env) => {
        expect(env.BW_SESSION).toBe("exported-session");
        return "sk-from-cli-session";
      },
    });
    await expect(resolver.resolve("bw://OpenAI/password")).resolves.toBe("sk-from-cli-session");
  });

  it("resolves every value of an env map", async () => {
    const { resolver } = setup({ run: () => ok("ghp_resolved_token") });
    await expect(
      resolver.resolveRecord({ GITHUB_TOKEN: "op://Dev/GitHub/token", LOG_LEVEL: "info" }),
    ).resolves.toEqual({ GITHUB_TOKEN: "ghp_resolved_token", LOG_LEVEL: "info" });
  });

  it("tests a reference without returning its value", async () => {
    const { resolver } = setup({ run: () => ok("sk-test-value") });
    await expect(resolver.test("op://Private/OpenAI/credential")).resolves.toEqual({
      ok: true,
      source: "onepassword",
      length: "sk-test-value".length,
    });
    await expect(resolver.test("sk-plain")).resolves.toMatchObject({ ok: false });
  });

  it("remembers resolved values so echoes of them are masked", async () => {
    const { resolver } = setup({ run: () => ok("sk-echoed-secret-42") });
    await resolver.resolve("op://Private/OpenAI/credential");
    expect(redactResolvedSecrets("env: OPENAI_API_KEY=sk-echoed-secret-42 done")).toBe(
      "env: OPENAI_API_KEY=[REDACTED_VAULT_SECRET] done",
    );
  });
});

describe("applySecretSourceSettingsUpdate", () => {
  it("keeps fields that are absent and clears fields that are blank", () => {
    const current: SecretSourceSettings = {
      version: 1,
      onepassword: { serviceAccountToken: "ops_old", account: "team" },
      bitwardenSecretsManager: { accessToken: "0.old" },
    };
    const next = applySecretSourceSettingsUpdate(current, {
      onepasswordServiceAccountToken: "",
      bitwardenSecretsManagerServerUrl: "https://vault.bitwarden.eu/",
    });
    expect(next.onepassword).toEqual({ serviceAccountToken: undefined, account: "team" });
    expect(next.bitwardenSecretsManager).toEqual({
      accessToken: "0.old",
      serverUrl: "https://vault.bitwarden.eu",
    });
  });

  it.each([
    [{ onepasswordServiceAccountToken: "two words" }, "single line"],
    [{ bitwardenSecretsManagerServerUrl: "http://vault.example.com" }, "must use https"],
    [{ bitwardenSecretsManagerServerUrl: "https://user:pw@vault.example.com" }, "user name"],
    [{ onepasswordAccount: "team; rm -rf" }, "account shorthand"],
  ])("rejects %j", (change, message) => {
    expect(() => applySecretSourceSettingsUpdate({ version: 1 }, change)).toThrow(message);
  });
});
