import { describe, expect, it, vi } from "vitest";
import {
  rewrapChannelConfigs,
  rewrapEncryptedValues,
  rewrapMailboxValues,
  type OsSealedDecrypt,
} from "../safe-storage-rewrap";
import type { SafeStorageLike } from "../safe-storage";

// Data-key ciphertexts start with "ck1:"; OS keychain ones here with "os|".
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (text) =>
    Buffer.concat([Buffer.from("ck1:"), Buffer.alloc(28), Buffer.from(text)]),
  decryptString: (sealed) => sealed.subarray(32).toString(),
};
const osSeal = (text: string) => Buffer.from(`os|${text}`).toString("base64");
const decrypt: OsSealedDecrypt = async (sealed) => {
  const text = sealed.toString();
  return text.startsWith("os|") && !text.includes("foreign") ? text.slice(3) : null;
};
const opened = (value: string, prefix: string) =>
  storage.decryptString(Buffer.from(value.slice(prefix.length), "base64"));
const logger = { info: vi.fn(), warn: vi.fn() };

describe("data key rewrap", () => {
  it("rewraps encrypted: values anywhere in settings and leaves everything else", async () => {
    const already = `encrypted:${storage.encryptString("done").toString("base64")}`;
    const result = await rewrapEncryptedValues(
      {
        servers: [{ auth: { token: `encrypted:${osSeal("tok")}`, mode: "bearer" } }],
        hooks: { secret: already, masked: "***", foreign: `encrypted:${osSeal("foreign")}` },
        count: 3,
      },
      decrypt,
      storage,
    );

    expect(result.changed).toBe(true);
    const value = result.value as Any;
    expect(opened(value.servers[0].auth.token, "encrypted:")).toBe("tok");
    expect(value.servers[0].auth.mode).toBe("bearer");
    expect(value.hooks.secret).toBe(already);
    expect(value.hooks.masked).toBe("***");
    // The keychain cannot read it here: kept as it was, never dropped.
    expect(value.hooks.foreign).toBe(`encrypted:${osSeal("foreign")}`);
    expect(value.count).toBe(3);

    expect((await rewrapEncryptedValues({ secret: already }, decrypt, storage)).changed).toBe(
      false,
    );
  });

  it("rewraps channel configs only where the stored value is unchanged", async () => {
    const rows = [
      { id: "a", config: `enc:${osSeal('{"botToken":"x"}')}` },
      { id: "b", config: `enc:${storage.encryptString("{}").toString("base64")}` },
      { id: "c", config: `enc:${osSeal("foreign")}` },
    ];
    const run = vi.fn((_next: string, _updatedAt: number, id: string) => ({
      changes: id === "a" ? 1 : 0,
    }));
    const database = {
      prepare: (sql: string) => (sql.startsWith("SELECT") ? { all: () => rows } : { run }),
    };

    await expect(rewrapChannelConfigs({ database, storage, decrypt, logger })).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    const [next, , id, previous] = run.mock.calls[0]!;
    expect(id).toBe("a");
    expect(previous).toBe(rows[0]!.config);
    expect(opened(next, "enc:")).toBe('{"botToken":"x"}');
  });

  it("rewraps mailbox values through the conditional replace", async () => {
    const replaceIfUnchanged = vi.fn(async () => true);
    const count = await rewrapMailboxValues({
      store: {
        targets: ["messages.body"],
        list: async () => [
          { key: "1", value: `mbox:os:${osSeal("Hello")}` },
          { key: "2", value: "mbox:app:iv:tag:data" },
        ],
        replaceIfUnchanged,
      },
      storage,
      decrypt,
      logger,
    });

    expect(count).toBe(1);
    const [target, key, next, previous] = replaceIfUnchanged.mock.calls[0] as unknown as string[];
    expect([target, key, previous]).toEqual(["messages.body", "1", `mbox:os:${osSeal("Hello")}`]);
    expect(opened(next, "mbox:os:")).toBe("Hello");
  });
});
