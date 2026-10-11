import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_ONLY_RECHECK_MS, LegacyOnlyServerStore } from "../legacy-only-servers";

const KEY = JSON.stringify(["server-1", "stdio", "/usr/bin/tool", ["--token", "secret-123"], null]);

function tempFile(): string {
  return join(fs.mkdtempSync(join(os.tmpdir(), "mcp-legacy-")), "servers.json");
}

describe("LegacyOnlyServerStore", () => {
  it("remembers a server across launches once persisted", () => {
    const file = tempFile();
    const first = new LegacyOnlyServerStore();
    first.persistTo(file);
    first.add(KEY);

    const nextLaunch = new LegacyOnlyServerStore();
    nextLaunch.persistTo(file);
    expect(nextLaunch.has(KEY)).toBe(true);
    expect(nextLaunch.has(KEY.replace("server-1", "server-2"))).toBe(false);
  });

  it("stores only hashes, never the command line", () => {
    const file = tempFile();
    const store = new LegacyOnlyServerStore();
    store.persistTo(file);
    store.add(KEY);

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("secret-123");
    expect(raw).not.toContain("/usr/bin/tool");
    expect(Object.keys(JSON.parse(raw).servers)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it("forgets an entry after the recheck window so an upgraded server is probed again", () => {
    let now = 1_000_000;
    const file = tempFile();
    const store = new LegacyOnlyServerStore(() => now);
    store.persistTo(file);
    store.add(KEY);

    now += LEGACY_ONLY_RECHECK_MS + 1;
    expect(store.has(KEY)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).servers).toEqual({});
  });

  it("works in memory without a file and tolerates a corrupt one", () => {
    const memoryOnly = new LegacyOnlyServerStore();
    memoryOnly.add(KEY);
    expect(memoryOnly.has(KEY)).toBe(true);

    const file = tempFile();
    fs.writeFileSync(file, "{not json");
    const store = new LegacyOnlyServerStore();
    store.persistTo(file);
    expect(store.has(KEY)).toBe(false);
    store.add(KEY);
    expect(new LegacyOnlyServerStore().has(KEY)).toBe(false);
    const reloaded = new LegacyOnlyServerStore();
    reloaded.persistTo(file);
    expect(reloaded.has(KEY)).toBe(true);
  });
});
