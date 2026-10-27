/**
 * An import with credentials opted in writes provider keys and channel tokens through the
 * real settings and channel stores of a throwaway profile. No credential value may appear
 * in the SQLite files (database, WAL) or in anything logged during the import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rest of the module stays real (data key state: no key opened in this test).
vi.mock("../../utils/safe-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/safe-storage")>()),
  getSafeStorage: () => ({
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DISCORD_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.fixture.discordtoken`;
const SECRETS = {
  openrouter: "sk-or-fixture-sqlite-0003",
  telegram: "654321:fixture-sqlite-telegram",
  discord: DISCORD_TOKEN,
};

describeWithSqlite("agent import credentials", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;

  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-secrets-")));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = path.join(tmpDir, "profile");
    fs.mkdirSync(process.env.COWORK_USER_DATA_DIR, { recursive: true });
    const [{ DatabaseManager }, { SecureSettingsRepository }] = await Promise.all([
      import("../../database/schema"),
      import("../../database/SecureSettingsRepository"),
    ]);
    manager = new DatabaseManager();
    new SecureSettingsRepository(manager.getDatabase());
    const home = path.join(tmpDir, ".openclaw");
    fs.cpSync(path.join(__dirname, "fixtures", "openclaw-home"), home, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".env"),
      [
        `OPENROUTER_API_KEY=${SECRETS.openrouter}`,
        `TELEGRAM_BOT_TOKEN=${SECRETS.telegram}`,
        `DISCORD_BOT_TOKEN=${SECRETS.discord}`,
      ].join("\n"),
    );
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stores keys and tokens encrypted and never logs them", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    const { LLMProviderFactory } = await import("../../agent/llm/provider-factory");
    const { PersonalityManager } = await import("../../settings/personality-manager");
    LLMProviderFactory.initialize();
    PersonalityManager.initialize();
    const { createDefaultImportTargets, runAgentImport } = await import("../index");
    const targets = createDefaultImportTargets({
      db: manager.getDatabase(),
      workspace: null,
      cron: null,
    });
    // Only the stores under test are real; the rest would need running services.
    targets.memory.available = () => false;
    targets.skills.install = async () => ({ ok: false, reason: "not under test" });

    const result = await runAgentImport("openclaw", targets, {
      withSecrets: true,
      dryRun: false,
      homedir: tmpDir,
      excludeItemIds: ["command:/opt/homebrew/bin/rg"],
    });
    const status = (id: string) => result.items.find((item) => item.id === id)?.status;
    expect(status("key:openrouter")).toBe("imported");
    expect(status("channel:telegram")).toBe("imported");
    expect(status("channel:discord")).toBe("imported");
    expect(status("persona")).toBe("imported");

    // Readable back through the stores that own them.
    LLMProviderFactory.clearCache?.();
    expect(LLMProviderFactory.loadSettings().openrouter?.apiKey).toBe(SECRETS.openrouter);
    const { ChannelRepository } = await import("../../database/repository-facades");
    const telegram = await new ChannelRepository(manager.getDatabase()).findByType("telegram");
    expect(telegram).toMatchObject({
      enabled: false,
      config: { botToken: SECRETS.telegram },
      securityConfig: { mode: "allowlist", allowedUsers: ["777"] },
    });

    // Nothing in plain text on disk or in the logs.
    const db = manager.getDatabase();
    db.pragma("wal_checkpoint(FULL)");
    const files = fs
      .readdirSync(process.env.COWORK_USER_DATA_DIR as string)
      .filter((name) => /\.db(-wal|-shm)?$|\.sqlite/.test(name))
      .map((name) => fs.readFileSync(path.join(process.env.COWORK_USER_DATA_DIR as string, name)));
    expect(files.length).toBeGreaterThan(0);
    const logText = JSON.stringify(logged);
    for (const secret of Object.values(SECRETS)) {
      for (const bytes of files) expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
      expect(logText).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
