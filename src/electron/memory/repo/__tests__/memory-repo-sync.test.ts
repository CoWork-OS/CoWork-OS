import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { memoryRepoRemoteUrlProblem, redactRemoteUrl } from "../memory-repo-sync";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

describe("memoryRepoRemoteUrlProblem", () => {
  it("accepts https and ssh remotes only, without credentials", () => {
    for (const ok of [
      "https://github.com/me/memory.git",
      "ssh://git@github.com/me/memory.git",
      "git@github.com:me/memory.git",
      "",
    ]) {
      expect(memoryRepoRemoteUrlProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "file:///tmp/x",
      "/tmp/repo",
      "ext::sh -c touch% /tmp/pwned",
      "--upload-pack=touch /tmp/x",
      "https://user:token@github.com/me/memory.git",
      "http://github.com/me/memory.git",
      "https://github.com/me/memory.git extra",
    ]) {
      expect(memoryRepoRemoteUrlProblem(bad), bad).not.toBeNull();
    }
    expect(redactRemoteUrl("https://user:secret@example.com/r.git")).toBe("https://example.com/r.git");
  });
});

describeWithGit("memory repo sync between two machines", () => {
  let base: string;
  let remote: string;
  let a: MemoryRepoService;
  let b: MemoryRepoService;

  const make = async (name: string) => {
    const service = new MemoryRepoService({
      root: path.join(base, name),
      runtime: "desktop",
      allowLocalRemotesForTests: true,
    });
    await service.start();
    return service;
  };
  const remember = (service: MemoryRepoService, text: string) =>
    service.remember({ text, kind: "preference", scope: "global", by: "user", origin: "memory_hub" });
  const read = (service: MemoryRepoService, rel: string) =>
    fs.readFileSync(path.join(service.root, rel), "utf8");

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-sync-"));
    remote = path.join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    a = await make("machine-a");
    expect(await a.configureSync(remote)).toEqual({ ok: true });
    await remember(a, "Prefers short answers");
    expect(await a.syncNow()).toMatchObject({ lastError: null, conflict: null, ahead: 0 });
    // Machine B starts from a clone of the private remote.
    execFileSync("git", ["clone", "-q", remote, path.join(base, "machine-b")]);
    b = await make("machine-b");
    expect(await b.configureSync(remote)).toEqual({ ok: true });
  });

  afterEach(async () => {
    await a.stop();
    await b.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("carries changes both ways, rebasing independent edits", async () => {
    expect(read(b, "me.md")).toContain("Prefers short answers");
    await remember(a, "Uses metric units");
    await remember(b, "Works from Berlin");
    await a.syncNow();
    const state = await b.syncNow();
    expect(state).toMatchObject({ conflict: null, lastError: null, ahead: 0 });
    expect(read(b, "me.md")).toContain("Uses metric units");
    await a.syncNow();
    expect(read(a, "me.md")).toContain("Works from Berlin");
  });

  it("keeps both sides of a concurrent edit (union merge) and leaves the folder clean", async () => {
    const meA = path.join(a.root, "me.md");
    const meB = path.join(b.root, "me.md");
    fs.writeFileSync(meA, fs.readFileSync(meA, "utf8").replace("Prefers short answers", "Prefers long answers"));
    fs.writeFileSync(meB, fs.readFileSync(meB, "utf8").replace("Prefers short answers", "Prefers medium answers"));
    await a.syncNow();
    const state = await b.syncNow();
    expect(state).toMatchObject({ conflict: null, lastError: null });
    expect(read(b, "me.md")).toContain("medium");
    expect(read(b, "me.md")).toContain("long");
    expect((await b.status()).clean).toBe(true);
  });

  it("replaces the remote history after a compaction", async () => {
    await remember(a, "Old secret plan falcon");
    await a.syncNow();
    const written = (await a.entries("me.md")).find((entry) => entry.text.includes("falcon"));
    if (!written) throw new Error("missing");
    await a.forget("me.md", written.line);
    expect(await a.compactHistory()).toEqual({ compacted: true });
    expect(await a.syncNow()).toMatchObject({ lastError: null });
    const log = execFileSync("git", ["log", "-p", "--all"], { cwd: remote, encoding: "utf8" });
    expect(log).not.toContain("falcon");
  });
});
