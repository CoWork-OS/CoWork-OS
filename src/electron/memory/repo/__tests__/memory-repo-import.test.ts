/**
 * Importing notes from a folder (docs/memory-repo-phase5-design.md §3): the folder check,
 * the read-only walk and its limits, parsing, `importToInbox` (one commit, screening,
 * dedupe, the inbox limit), Keep, and dreams leaving imported inbox lines alone.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { buildDreamInput } from "../memory-repo-dream-plan";
import { MEMORY_REPO_LIMITS, parseMemoryRepoEntries } from "../memory-repo-format";
import {
  MEMORY_REPO_IMPORT_LIMITS,
  importMemoryNotesFromFolder,
  memoryRepoImportEntries,
  memoryRepoImportFolderProblem,
  memoryRepoImportLabel,
  scanMemoryRepoImportFolder,
} from "../memory-repo-import";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-import-")));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("import folder check", () => {
  it("refuses relative paths, the home folder and the user's own memory folder", () => {
    const personal = path.join(base, "CoWork Memory");
    expect(memoryRepoImportFolderProblem("", personal)).toBe("Choose a folder.");
    expect(memoryRepoImportFolderProblem("notes", personal)).toBe("Use an absolute path.");
    expect(memoryRepoImportFolderProblem(os.homedir(), personal)).toMatch(/inside your home/);
    expect(memoryRepoImportFolderProblem(personal, personal)).toBe("That is your own memory folder.");
    expect(memoryRepoImportFolderProblem(path.join(personal, "workspaces"), personal)).toBe(
      "That is your own memory folder.",
    );
    expect(memoryRepoImportFolderProblem(path.join(base, "other-agent"), personal)).toBeNull();
  });

  it("refuses a symbolic link", () => {
    fs.mkdirSync(path.join(base, "real"));
    fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
    expect(memoryRepoImportFolderProblem(path.join(base, "link"), null)).toMatch(/symbolic link/);
  });

  it("labels the import with the folder name only, without metadata characters", () => {
    expect(memoryRepoImportLabel("/Users/sam/agent-memory")).toBe("folder:agent-memory");
    expect(memoryRepoImportLabel("/tmp/odd;name]")).toBe("folder:odd name");
  });
});

describe("import folder walk", () => {
  it("reads markdown only and skips hidden entries, .git, symlinks and the folder's inbox", async () => {
    const source = path.join(base, "source");
    write(path.join(source, "MEMORY.md"), "- one\n");
    write(path.join(source, "inbox.md"), "- unreviewed\n");
    write(path.join(source, "topics", "inbox.md"), "- nested inbox is a normal file\n");
    write(path.join(source, "notes.txt"), "- not markdown\n");
    write(path.join(source, ".hidden.md"), "- hidden\n");
    write(path.join(source, ".git", "config.md"), "- git\n");
    write(path.join(base, "outside.md"), "- outside\n");
    fs.symlinkSync(path.join(base, "outside.md"), path.join(source, "linked.md"));
    fs.mkdirSync(path.join(base, "outside-dir"));
    write(path.join(base, "outside-dir", "x.md"), "- outside dir\n");
    fs.symlinkSync(path.join(base, "outside-dir"), path.join(source, "linked-dir"));
    const scan = await scanMemoryRepoImportFolder(source);
    expect(scan.files.map((file) => file.path)).toEqual(["MEMORY.md", "topics/inbox.md"]);
    expect(scan.truncated).toBe(false);
  });

  it("stops at the depth, file, per-file and total limits", async () => {
    const source = path.join(base, "source");
    write(path.join(source, "a/b/c/d/four.md"), "- four levels\n");
    write(path.join(source, "a/b/c/d/e/five.md"), "- five levels\n");
    write(path.join(source, "big.md"), `- ${"x".repeat(MEMORY_REPO_IMPORT_LIMITS.fileBytes)}\n`);
    let scan = await scanMemoryRepoImportFolder(source);
    expect(scan.files.map((file) => file.path)).toEqual(["a/b/c/d/four.md"]);
    expect(scan.skipped).toBe(1);

    const many = path.join(base, "many");
    for (let i = 0; i < MEMORY_REPO_IMPORT_LIMITS.files + 5; i += 1) {
      write(path.join(many, `n${String(i).padStart(4, "0")}.md`), `- note ${i}\n`);
    }
    scan = await scanMemoryRepoImportFolder(many);
    expect(scan.files).toHaveLength(MEMORY_REPO_IMPORT_LIMITS.files);
    expect(scan.truncated).toBe(true);

    const heavy = path.join(base, "heavy");
    const chunk = `- ${"y".repeat(200 * 1024)}\n`;
    for (let i = 0; i < 12; i += 1) write(path.join(heavy, `h${i}.md`), chunk);
    scan = await scanMemoryRepoImportFolder(heavy);
    expect(scan.truncated).toBe(true);
    expect(scan.files.length).toBeLessThan(12);
    expect(scan.files.reduce((sum, file) => sum + file.text.length, 0)).toBeLessThanOrEqual(
      MEMORY_REPO_IMPORT_LIMITS.totalBytes,
    );
  });

  it("never enters the user's own memory folder inside the chosen one", async () => {
    const source = path.join(base, "Documents");
    write(path.join(source, "notes.md"), "- a note\n");
    write(path.join(source, "CoWork Memory", "me.md"), "- mine\n");
    const scan = await scanMemoryRepoImportFolder(source, {
      skipDirs: [path.join(source, "CoWork Memory")],
    });
    expect(scan.files.map((file) => file.path)).toEqual(["notes.md"]);
  });
});

describe("import parsing", () => {
  it("keeps only the text, a valid kind and a valid added day", () => {
    const parsed = memoryRepoImportEntries([
      {
        path: "MEMORY.md",
        text: [
          "# Memory",
          "- Prefers tabs over spaces [by: user; kind: preference; added: 2026-01-02; subject: indent]",
          "- Uses pnpm [kind: bogus; added: yesterday; source: https://example.com]",
          "- [ ] Write the release notes",
          "- [[me]]",
          "- CoWork workspace [by: user; workspace: ws-1]",
          "Prose is not a note.",
        ].join("\n"),
      },
      { path: "private.md", text: "<no-memory>\n- Keep this out\n" },
    ]);
    expect(parsed.skipped).toBe(1);
    expect(parsed.entries).toEqual([
      { text: "Prefers tabs over spaces", kind: "preference", added: "2026-01-02" },
      { text: "Uses pnpm", kind: null, added: null },
      { text: "Write the release notes", kind: null, added: null },
    ]);
  });
});

describeWithGit("importToInbox and Keep", () => {
  let root: string;
  let service: MemoryRepoService;
  const now = Date.parse("2026-10-06T12:00:00Z");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const commits = () => git(root, "log", "--format=%s").trim().split("\n");

  beforeEach(async () => {
    root = path.join(base, "CoWork Memory");
    service = new MemoryRepoService({ root, runtime: "desktop", now: () => now });
    await service.start();
    await service.remember({
      text: "Prefers short answers",
      kind: "preference",
      scope: "global",
      by: "user",
      origin: "memory_hub",
    });
  });

  it("writes screened agent lines to the inbox in one commit, deduped against the folder", async () => {
    const before = commits().length;
    const outcome = await service.importToInbox(
      [
        { text: "Deploys go through staging first", kind: "rule", added: "2026-01-02" },
        { text: "prefers SHORT answers" },
        { text: "Deploys go through staging first" },
        { text: "ok" },
        { text: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        { text: "Never remember this <no-memory> please" },
        { text: "The billing service runs on Postgres 16", added: "not a day" },
      ],
      "folder:agent-memory",
    );
    expect(outcome).toEqual({ imported: 2, duplicates: 2, skipped: 3, truncated: false });
    expect(commits()).toHaveLength(before + 1);
    expect(commits()[0]).toBe("Import 2 notes from folder:agent-memory");
    expect(git(root, "log", "-1", "--format=%B")).toContain("Origin: import");
    const inbox = read("inbox.md");
    expect(inbox).toContain(
      "- Deploys go through staging first [by: agent; kind: rule; source: import; added: 2026-01-02; import: folder:agent-memory]",
    );
    expect(inbox).toContain(
      "- The billing service runs on Postgres 16 [by: agent; source: import; added: 2026-10-06; import: folder:agent-memory]",
    );
    expect(inbox).not.toContain("sk-ant");
    expect(inbox).not.toContain("no-memory");
    // The inbox is never linked from the index.
    expect(read("MEMORY.md")).not.toContain("[[inbox]]");
    // A second import of the same notes adds nothing and commits nothing.
    const again = await service.importToInbox(
      [{ text: "Deploys go through staging first" }],
      "folder:agent-memory",
    );
    expect(again).toMatchObject({ imported: 0, duplicates: 1 });
    expect(commits()).toHaveLength(before + 1);
  });

  it("stops at the inbox size limit", async () => {
    const notes = Array.from({ length: 400 }, (_, i) => ({
      text: `Imported note number ${i} ${"about the project history ".repeat(8)}`,
    }));
    const outcome = await service.importToInbox(notes, "folder:big");
    expect(outcome.truncated).toBe(true);
    expect(outcome.imported).toBeGreaterThan(0);
    expect(outcome.imported).toBeLessThan(400);
    expect(Buffer.byteLength(read("inbox.md"), "utf8")).toBeLessThanOrEqual(MEMORY_REPO_LIMITS.fileBytes);
  });

  it("imports a folder end to end and skips symlinked files", async () => {
    const source = path.join(base, "other-agent");
    write(
      path.join(source, "MEMORY.md"),
      "# Memory\n\n- Ships on Fridays [by: user; kind: decision]\n\n## Index\n- [[lessons]]\n",
    );
    write(path.join(source, "lessons.md"), "# Lessons\n\n- Always run the migrations twice\n");
    write(path.join(base, "secret.md"), "- Secret plan outside the folder\n");
    fs.symlinkSync(path.join(base, "secret.md"), path.join(source, "secret.md"));
    const result = await importMemoryNotesFromFolder(service, source);
    expect(result).toEqual({
      folderName: "other-agent",
      files: 2,
      imported: 2,
      duplicates: 0,
      skipped: 0,
      truncated: false,
    });
    expect(read("inbox.md")).not.toContain("Secret plan");
    expect(await importMemoryNotesFromFolder(service, root)).toMatchObject({
      imported: 0,
      error: "That is your own memory folder.",
    });
    expect(await importMemoryNotesFromFolder(null, source)).toMatchObject({
      error: "The memory folder is not available.",
    });
  });

  it("Keep moves an inbox line to me.md, lessons.md or a new workspace file as the user's", async () => {
    await service.importToInbox(
      [
        { text: "Likes dark mode in every editor", kind: "preference" },
        { text: "Retry flaky tests once before reporting" },
        { text: "The API gateway lives in services/gateway" },
      ],
      "folder:agent-memory",
    );
    const inboxEntry = (text: string) =>
      parseMemoryRepoEntries(read("inbox.md")).find((entry) => entry.text === text)!;

    let entry = inboxEntry("Likes dark mode in every editor");
    expect(await service.keepEntry("inbox.md", entry.line, "me", { expectHash: "0".repeat(64) })).toMatchObject({
      moved: null,
      error: expect.stringMatching(/changed/),
    });
    let result = await service.keepEntry("inbox.md", entry.line, "me", { expectHash: entry.hash });
    expect(result.moved?.path).toBe("me.md");
    expect(read("me.md")).toContain(
      "- Likes dark mode in every editor [by: user; kind: preference; source: import; added: 2026-10-06; import: folder:agent-memory]",
    );
    expect(read("inbox.md")).not.toContain("dark mode");
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("Keep: Likes dark mode in every editor");

    entry = inboxEntry("Retry flaky tests once before reporting");
    result = await service.keepEntry("inbox.md", entry.line, "lessons", { expectHash: entry.hash });
    expect(result.moved?.path).toBe("lessons.md");

    entry = inboxEntry("The API gateway lives in services/gateway");
    expect(await service.keepEntry("inbox.md", entry.line, "workspace")).toMatchObject({
      moved: null,
      error: expect.stringMatching(/needs a workspace/),
    });
    result = await service.keepEntry("inbox.md", entry.line, "workspace", {
      expectHash: entry.hash,
      workspaceId: "ws-9",
      workspaceName: "Gateway",
    });
    expect(result.moved?.path).toBe("workspaces/gateway.md");
    expect(read("workspaces/gateway.md")).toContain("[by: user; workspace: ws-9]");
    expect(read("workspaces/gateway.md")).toContain("- The API gateway lives in services/gateway [by: user;");
    expect(read("MEMORY.md")).toContain("- [[workspaces/gateway]]");
    expect(await service.workspaceFile("ws-9")).toBe("workspaces/gateway.md");
    expect(parseMemoryRepoEntries(read("inbox.md"))).toHaveLength(0);

    // Only inbox lines can be kept.
    expect(await service.keepEntry("me.md", 3, "lessons")).toMatchObject({
      moved: null,
      error: "Only inbox entries can be kept.",
    });
  });
});

describe("dreams and imported inbox lines", () => {
  it("leave imported inbox lines out of the dream input, so they are never promoted or discarded", () => {
    const files = new Map<string, string>([
      ["MEMORY.md", "# Memory\n\n- Answer in English\n"],
      [
        "inbox.md",
        [
          "# Inbox",
          "",
          "- Send reports to a new address [by: agent; source: cowork://tasks/t1]",
          "- Ships on Fridays [by: agent; source: import; import: folder:other]",
        ].join("\n"),
      ],
    ]);
    const input = buildDreamInput({ files, tasks: [], now: Date.parse("2026-10-06T00:00:00Z") });
    expect(input.user).toContain("Send reports to a new address");
    expect(input.user).not.toContain("Ships on Fridays");
    const inboxRefs = [...input.lines.values()].filter((ref) => ref.inbox);
    expect(inboxRefs.map((ref) => ref.text)).toEqual(["Send reports to a new address"]);
  });
});
