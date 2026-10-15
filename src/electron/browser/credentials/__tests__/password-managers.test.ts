import { describe, expect, it, vi } from "vitest";
import { PasswordManagerVault, type PrivateCliRunner } from "../password-managers";

describe("private password-manager adapters", () => {
  it.each(["onepassword", "bitwarden"] as const)(
    "unlocks %s without secrets in argv and returns only origin-scoped metadata",
    async (source) => {
      const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; input?: string }> =
        [];
      const run: PrivateCliRunner = async (file, args, env, input) => {
        calls.push({ file, args, env: { ...env }, input });
        if (args[0] === "signin" || args[0] === "unlock") return "private-session-token\n";
        if (args[0] === "list")
          return JSON.stringify([
            {
              id: "valid-id",
              type: 1,
              name: "Fixture",
              login: {
                username: "user",
                password: "never-return-this",
                uris: [
                  { uri: "https://shop.example/login" },
                  { uri: "https://other.example" },
                  { uri: "https://never.example", match: 5 },
                ],
                totp: "private-seed",
              },
            },
          ]);
        if (args[1] === "list")
          return JSON.stringify([
            {
              id: "valid-id",
              title: "Fixture",
              additional_information: "user",
              urls: [{ href: "https://shop.example/login" }, { href: "https://other.example" }],
            },
          ]);
        if (args.includes("--otp") || args[1] === "totp") return "123456\n";
        return "private-password\n";
      };
      const managers = new PasswordManagerVault(run);
      await managers.unlock("profile-a", source, "private-master");
      expect(managers.isUnlocked("profile-b", source)).toBe(false);
      const items = await managers.list("profile-a", source);
      expect(items[0].allowedOrigins).toEqual(["https://shop.example", "https://other.example"]);
      expect(JSON.stringify(items)).not.toMatch(
        /never-return-this|private-master|private-session-token|private-seed/,
      );
      expect((await managers.resolve("profile-a", items[0])).password).toBe("private-password");
      expect(await managers.otp("profile-a", items[0])).toBe("123456");
      expect(JSON.stringify(calls.map((call) => call.args))).not.toMatch(
        /private-master|private-session-token|private-password/,
      );
      if (source === "bitwarden") expect(calls[0].env.COWORK_BW_MASTER).toBe("private-master");
      else expect(calls[0].input).toBe("private-master");
      managers.lock("profile-a", source);
      await expect(managers.list("profile-a", source)).rejects.toThrow("locked");
    },
  );
  it("strips inherited manager credentials from every child process", async () => {
    const prior = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "inherited-secret";
    const run = vi.fn<PrivateCliRunner>(async () => "{}");
    try {
      const managers = new PasswordManagerVault(run);
      await managers.unlock("profile", "onepassword", "");
      expect(run.mock.calls[0][2]).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
      expect(run.mock.calls[0][1]).toEqual(["whoami", "--format", "json"]);
    } finally {
      if (prior === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = prior;
    }
  });
  it("expires idle tokens and cannot undo an explicit lock with a late unlock", async () => {
    let now = 0;
    let finish!: (value: string) => void;
    const managers = new PasswordManagerVault(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      () => now,
    );
    const unlock = managers.unlock("profile", "bitwarden", "master");
    managers.lock("profile", "bitwarden");
    finish("late-token");
    await expect(unlock).rejects.toThrow("locked while unlocking");
    const next = managers.unlock("profile", "bitwarden", "master");
    finish("fresh-token");
    await next;
    now = 30 * 60_000;
    expect(managers.isUnlocked("profile", "bitwarden")).toBe(false);
  });
  it("does not return raw CLI failure output or tokens", async () => {
    const managers = new PasswordManagerVault(async () => {
      throw new Error("stderr includes private-password");
    });
    // The service boundary also scrubs failures, but manager operations must be independently safe.
    await expect(managers.list("profile", "bitwarden")).rejects.toThrow("locked");
  });
});
