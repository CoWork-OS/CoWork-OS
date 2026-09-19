import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("default CoWork bot team", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bot-team-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seeds a reusable roster and workspace-scoped persistent team idempotently", async () => {
    const [{ WorkspaceRepository }, { ensureDefaultBotTeam, DEFAULT_BOT_TEAM_NAME }] =
      await Promise.all([import("../../database/repositories"), import("../bot-team")]);
    const workspace = new WorkspaceRepository(manager.getDatabase()).create(
      "Bot Team Workspace",
      tmpDir,
      { read: true, write: true, delete: true, network: true, shell: false },
    );

    const first = ensureDefaultBotTeam(manager.getDatabase(), workspace.id);
    const second = ensureDefaultBotTeam(manager.getDatabase(), workspace.id);
    expect(first?.team.name).toBe(DEFAULT_BOT_TEAM_NAME);
    expect(first?.team.persistent).toBe(true);
    expect(second?.team.id).toBe(first?.team.id);
    expect(first?.roles.map((role) => role.name)).toEqual([
      "atlas-your-chief-of-staff",
      "forge",
      "scribe",
      "exec",
      "chief-community-officer",
      "product-engineer",
    ]);

    const members = manager
      .getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM agent_team_members WHERE team_id = ?")
      .get(first!.team.id) as { count: number };
    expect(members.count).toBe(6);
    expect(first?.roles[0].systemPrompt).toContain("send_agent_message");
  });
});
