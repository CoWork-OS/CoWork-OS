import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { GitService } from "../GitService";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it.each(["hostile", "hostile.with.dots", "hostile=alias"])(
  "reads status and diff without executing helpers named %s",
  async (filter) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-read-security-"));
    dirs.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(root, "doc.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    const marker = path.join(root, "executed");
    const helper = path.join(root, "helper.sh");
    fs.writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`, { mode: 0o700 });
    git("config", "core.fsmonitor", helper);
    git("config", "diff.hostile.command", helper);
    git("config", "diff.hostile.textconv", helper);
    for (const field of ["clean", "smudge", "process"])
      git("config", `filter.${filter}.${field}`, helper);
    git("config", `filter.${filter}.required`, "true");
    fs.writeFileSync(path.join(root, ".gitattributes"), `*.txt diff=hostile filter=${filter}\n`);
    fs.writeFileSync(path.join(root, "doc.txt"), "after\n");
    vi.stubEnv("GIT_EXTERNAL_DIFF", helper);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", helper);
    if (filter.includes("=")) {
      await expect(GitService.getStatus(root)).rejects.toThrow("safely disable");
      await expect(GitService.getDiff(root)).rejects.toThrow("safely disable");
    } else {
      expect(await GitService.getStatus(root)).toContain("doc.txt");
      expect(await GitService.getDiff(root)).toContain("+after");
      expect(await GitService.hasUncommittedChanges(root)).toBe(true);
    }
    expect(fs.existsSync(marker)).toBe(false);
  },
);
