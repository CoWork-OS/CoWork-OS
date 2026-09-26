import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyReleaseBrief } from "../verify-release-brief";

const fixture = path.resolve("resources/starter-missions/release-brief-v1");
const roots: string[] = [];

async function sampleWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-brief-check-"));
  roots.push(root);
  for (const file of ["issues.csv", "release-notes.md", "brief-instructions.md"]) {
    await fs.copyFile(path.join(fixture, file), path.join(root, file));
  }
  await fs.mkdir(path.join(root, "outputs"));
  const source = (await fs.readFile(path.join(root, "issues.csv"), "utf8")).trimEnd();
  const lines = source.split("\n");
  await fs.writeFile(
    path.join(root, "outputs", "issues-clean.csv"),
    lines.slice(0, -1).join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(root, "outputs", "summary.json"),
    JSON.stringify({
      totalIssues: 12,
      openIssues: 7,
      closedIssues: 5,
      openBlockerIds: ["AST-101", "AST-102", "AST-103"],
      openOwnerlessIds: ["AST-103", "AST-105"],
    }),
  );
  await fs.writeFile(
    path.join(root, "outputs", "release-brief.html"),
    "<!doctype html><html><body><h1>Aster Notes 2.4</h1><p>12 issues: 7 open, 5 closed.</p><p>Blockers AST-101 AST-102 AST-103. Ownerless AST-103 AST-105.</p><p>Sources: release-notes.md and issues.csv</p></body></html>",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("release brief verifier", () => {
  it("checks actual output files and binds a pass to their hashes", async () => {
    const root = await sampleWorkspace();
    const first = await verifyReleaseBrief(root);
    expect(first.passed).toBe(true);
    await fs.appendFile(
      path.join(root, "outputs", "release-brief.html"),
      "<p>Revised for release managers.</p>",
    );
    const revised = await verifyReleaseBrief(root);
    expect(revised.passed).toBe(true);
    expect(revised.artifactHashes["release-brief.html"]).not.toBe(
      first.artifactHashes["release-brief.html"],
    );
  });

  it("rejects source mutation, active HTML, and symlinked outputs", async () => {
    const root = await sampleWorkspace();
    await fs.appendFile(path.join(root, "release-notes.md"), "changed");
    expect((await verifyReleaseBrief(root)).passed).toBe(false);

    const safe = await sampleWorkspace();
    const html = path.join(safe, "outputs", "release-brief.html");
    await fs.appendFile(html, '<script src="https://example.com/x.js"></script>');
    expect((await verifyReleaseBrief(safe)).errors).toContain(
      "HTML contains active content, links, or external resources",
    );

    const link = await sampleWorkspace();
    const csv = path.join(link, "outputs", "issues-clean.csv");
    await fs.rm(csv);
    await fs.symlink(path.join(link, "issues.csv"), csv);
    expect((await verifyReleaseBrief(link)).errors).toContain(
      "Missing or unsafe output: issues-clean.csv",
    );

    const aliased = `${link}-alias`;
    roots.push(aliased);
    await fs.symlink(link, aliased);
    expect((await verifyReleaseBrief(aliased)).errors).toContain(
      "Missing or unsafe sample workspace",
    );
  });

  it("rejects invented report IDs and conflicting counts", async () => {
    const root = await sampleWorkspace();
    await fs.appendFile(
      path.join(root, "outputs", "release-brief.html"),
      "<p>AST-999: 8 open issues.</p>",
    );
    const result = await verifyReleaseBrief(root);
    expect(result.passed).toBe(false);
    expect(result.errors).toContain("HTML mentions an issue ID absent from the source");
    expect(result.errors).toContain("HTML open issues count does not match the source");
  });
});
