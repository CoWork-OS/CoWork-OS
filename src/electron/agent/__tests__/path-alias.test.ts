import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectTaskRootPathRewrite, shouldRewriteWorkspaceAliasPath } from "../path-alias";
import type { WorkspacePathAliasMatch } from "../path-alias";

function makeAliasMatch(sourceExists: boolean): WorkspacePathAliasMatch {
  return {
    originalPath: "/workspace/project/src/index.ts",
    aliasRoot: "/workspace",
    suffix: "project/src/index.ts",
    normalizedPath: "project/src/index.ts",
    normalizedAbsolutePath: "/Users/test/project/src/index.ts",
    sourceExists,
  };
}

describe("workspace path alias rewrite policy", () => {
  it("rewrites alias paths when source is missing and policy is rewrite_and_retry", () => {
    const match = makeAliasMatch(false);
    expect(
      shouldRewriteWorkspaceAliasPath(match, "rewrite_and_retry", { requireSourceMissing: true }),
    ).toBe(true);
  });

  it("does not rewrite alias paths when source exists and source-missing guard is enabled", () => {
    const match = makeAliasMatch(true);
    expect(
      shouldRewriteWorkspaceAliasPath(match, "rewrite_and_retry", { requireSourceMissing: true }),
    ).toBe(false);
  });

  it("does not rewrite alias paths when policy is strict_fail", () => {
    const match = makeAliasMatch(false);
    expect(
      shouldRewriteWorkspaceAliasPath(match, "strict_fail", { requireSourceMissing: true }),
    ).toBe(false);
  });

  it("rewrites drifted task-root paths even when the unpinned source exists", () => {
    const workspaceDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-task-root-rewrite-"));
    fs.mkdirSync(path.join(workspaceDir, "app"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "influencer-chat", "app"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "app", "page.tsx"), "export default null;\n", "utf8");

    try {
      const match = detectTaskRootPathRewrite("app/page.tsx", workspaceDir, "influencer-chat", {
        requireSourceMissing: true,
      });

      expect(match).not.toBeNull();
      expect(match?.normalizedPath).toBe("influencer-chat/app/page.tsx");
      expect(match?.sourceExists).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
