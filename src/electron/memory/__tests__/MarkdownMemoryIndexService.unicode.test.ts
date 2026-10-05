/**
 * RECALL-9: the markdown index searches in any script. Its query dialect used to strip
 * everything outside `[a-z0-9_-]`, so a Turkish, Cyrillic, Greek or CJK query found
 * nothing.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import {
  MarkdownMemoryIndexService,
  buildMarkdownFtsQuery,
  tokenizeForMemorySearch,
} from "../MarkdownMemoryIndexService";

describe("markdown index tokens in any script", () => {
  it("keeps non-Latin words and folds Latin accents", () => {
    expect(tokenizeForMemorySearch("Ödeme planı için toplantı")).toEqual([
      "odeme",
      "planı",
      "icin",
      "toplantı",
    ]);
    expect(tokenizeForMemorySearch("Релиз в пятницу")).toEqual(["релиз", "пятницу"]);
    expect(tokenizeForMemorySearch("発表 計画")).toEqual(["発表", "計画"]);
    // A single CJK character is a word; a single Latin letter is not.
    expect(tokenizeForMemorySearch("猫 a b")).toEqual(["猫"]);
  });

  it("tokenizes ASCII text exactly as before (stored embeddings stay comparable)", () => {
    expect(tokenizeForMemorySearch("Deploy v2.1 to prod-eu --- see notes_v3")).toEqual([
      "deploy",
      "v2",
      "prod-eu",
      "---",
      "see",
      "notes_v3",
    ]);
  });

  it("builds quoted AND queries for non-Latin text", () => {
    expect(buildMarkdownFtsQuery("Релиз пятницу")).toBe('"релиз" AND "пятницу"');
    expect(buildMarkdownFtsQuery('say "hi" 計画')).toBe('"say" AND "hi" AND "計画"');
  });
});

describe("markdown index search in any script", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  it("finds Cyrillic, Turkish and CJK notes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-md-unicode-"));
    process.env.COWORK_USER_DATA_DIR = path.join(dir, "userdata");
    const manager = new DatabaseManager();
    const workspaceDir = path.join(dir, "workspace");
    const kit = path.join(workspaceDir, ".cowork");
    fs.mkdirSync(path.join(kit, "memory"), { recursive: true });
    fs.writeFileSync(path.join(kit, "USER.md"), "# Пользователь\n\n- Релиз выходит в пятницу\n");
    fs.writeFileSync(
      path.join(kit, "memory", "notes.md"),
      "# Notlar\n\n- Ödeme planı toplantısı salı günü\n\n## 計画\n\n- 新製品の発表計画を確認する\n",
    );
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const db = manager.getDatabase();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws', 'Index', ?, ?, '{}')`,
    ).run(workspaceDir, Date.now());
    const service = new MarkdownMemoryIndexService(db);
    await service.syncWorkspace("ws", workspaceDir, true);
    const allow = () => true;

    const russian = await service.search("ws", workspaceDir, "релиз пятницу", 5, allow);
    expect(russian[0]?.path).toBe("USER.md");
    // Case and accents fold: "ODEME" finds "Ödeme".
    const turkish = await service.search("ws", workspaceDir, "ODEME planı", 5, allow);
    expect(turkish[0]?.path).toBe("memory/notes.md");
    // A CJK word inside a longer run still matches (substring fallback).
    const japanese = await service.search("ws", workspaceDir, "発表計画", 5, allow);
    expect(japanese.map((hit) => hit.path)).toContain("memory/notes.md");
  });
});
