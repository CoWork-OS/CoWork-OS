import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import {
  configureTeamMemoryRepos,
  pullTeamMemoryRepos,
  resetTeamMemoryReposForTests,
  teamMemoryRepoRoots,
  teamMemoryRepoStatuses,
  teamMemoryReposFor,
} from "../memory-repo-team";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

describeWithGit("team memory repos", () => {
  let base: string;
  let personal: string;

  const makeRepo = async (name: string) => {
    const service = new MemoryRepoService({ root: path.join(base, name), runtime: "desktop" });
    await service.start();
    await service.remember({
      text: `${name} deploys on Tuesdays`,
      kind: "project_fact",
      scope: "global",
      by: "user",
      pinned: true,
      origin: "memory_hub",
    });
    await service.stop();
    return path.join(base, name);
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "team-memory-"));
    personal = path.join(base, "personal");
  });

  afterEach(() => {
    resetTeamMemoryReposForTests();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("opens team repos read-only and scopes them to workspaces", async () => {
    const platform = await makeRepo("platform");
    const billing = await makeRepo("billing");
    const statuses = await configureTeamMemoryRepos(
      [
        { name: "Platform", path: platform },
        { name: "Billing", path: billing, workspaceIds: ["ws-billing"] },
      ],
      { personalRoot: personal, workspacePaths: [] },
    );
    expect(statuses.map((status) => [status.name, status.ready])).toEqual([
      ["Platform", true],
      ["Billing", true],
    ]);
    expect(teamMemoryReposFor("ws-other").map((repo) => repo.name)).toEqual(["Platform"]);
    expect(teamMemoryReposFor("ws-billing").map((repo) => repo.name)).toEqual(["Platform", "Billing"]);
    expect(teamMemoryRepoRoots()).toEqual([path.resolve(platform), path.resolve(billing)]);
    const [repo] = teamMemoryReposFor("ws-other");
    expect(repo.service.isWritable()).toBe(false);
    expect(await repo.service.readFile("MEMORY.md")).toContain("platform deploys on Tuesdays");
  });

  it("refuses overlaps, the personal folder and folders that are not memory repos", async () => {
    const platform = await makeRepo("platform");
    const notes = path.join(base, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "todo.md"), "- milk\n");
    const statuses = await configureTeamMemoryRepos(
      [
        { name: "Platform", path: platform },
        { name: "Again", path: path.join(platform, "workspaces") },
        { name: "Mine", path: personal },
        { name: "Notes", path: notes },
      ],
      { personalRoot: personal, workspacePaths: [] },
    );
    expect(statuses.map((status) => status.ready)).toEqual([true, false, false, false]);
    expect(statuses[1].problem).toMatch(/overlap/);
    expect(statuses[2].problem).toMatch(/your own memory folder/);
    expect(statuses[3].problem).toMatch(/not a memory repo/);
    expect(teamMemoryRepoRoots()).toEqual([path.resolve(platform)]);
  });

  it("fast-forwards a clean clone and leaves one with local changes alone", async () => {
    const upstream = await makeRepo("upstream");
    const clone = path.join(base, "clone");
    execFileSync("git", ["clone", "-q", upstream, clone]);
    await configureTeamMemoryRepos([{ name: "Team", path: clone }], {
      personalRoot: personal,
      workspacePaths: [],
    });
    const writer = new MemoryRepoService({ root: upstream, runtime: "node" });
    await writer.start();
    await writer.remember({
      text: "Freeze deploys during the holidays",
      kind: "rule",
      scope: "global",
      by: "user",
      origin: "memory_hub",
    });
    await pullTeamMemoryRepos();
    expect(fs.readFileSync(path.join(clone, "lessons.md"), "utf8")).toContain("Freeze deploys");
    expect(teamMemoryRepoStatuses()[0]).toMatchObject({ lastPullError: null });

    fs.appendFileSync(path.join(clone, "lessons.md"), "- Local note\n");
    await pullTeamMemoryRepos();
    expect(teamMemoryRepoStatuses()[0].lastPullError).toMatch(/Local changes/);
  });
});
