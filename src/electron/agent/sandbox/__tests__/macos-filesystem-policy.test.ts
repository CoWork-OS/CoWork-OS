import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";
import { SandboxRunner } from "../runner";
import { setMemoryRepoRoot, setTeamMemoryRepoRoots } from "../../../security/memory-repo-access";

// Exercise the real kernel boundary; a generated string assertion cannot show
// whether Seatbelt permits rename, replacement, or a broad grant over a deny.
describe.skipIf(process.platform !== "darwin")("macOS filesystem policy execution", () => {
  let base: string;
  let workspace: Workspace;
  const sandboxes: Array<MacOSSandbox | SandboxRunner> = [];
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-policy-regression-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    workspace = {
      id: "policy-test",
      name: "Policy test",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const execute = async (code: string, legacy = false) => {
    const sandbox = legacy ? new SandboxRunner(workspace) : new MacOSSandbox(workspace);
    sandboxes.push(sandbox);
    return sandbox.execute(process.execPath, ["-e", code], { cwd: workspace.path });
  };
  const write = (target: string, legacy = false) =>
    execute(`require('fs').writeFileSync(${JSON.stringify(target)}, 'changed')`, legacy);

  it.each([false, true])(
    "blocks read-child mutation and permits an ordinary write (legacy=%s)",
    async (legacy) => {
      const readRoot = path.join(workspace.path, "inputs");
      fs.mkdirSync(readRoot);
      const input = path.join(readRoot, "input.txt");
      fs.writeFileSync(input, "original");
      workspace.permissions.accessFilesystemRules = [{ path: readRoot, access: "read" }];
      const denied = await write(input, legacy);
      expect(denied.exitCode, denied.stderr).not.toBe(0);
      expect(fs.readFileSync(input, "utf8")).toBe("original");
      const allowed = await write(path.join(workspace.path, "output.txt"), legacy);
      expect(allowed.exitCode, allowed.stderr).toBe(0);
    },
  );

  it("preserves the explicit write union for both parent and child write rules", async () => {
    const readRoot = path.join(workspace.path, "inputs");
    const writable = path.join(readRoot, "generated");
    fs.mkdirSync(writable, { recursive: true });
    workspace.permissions.accessFilesystemRules = [
      { path: readRoot, access: "read" },
      { path: writable, access: "write" },
    ];
    expect((await write(path.join(readRoot, "blocked.txt"))).exitCode).not.toBe(0);
    const childWrite = await write(path.join(writable, "output.txt"));
    expect(childWrite.exitCode, childWrite.stderr).toBe(0);
    workspace.permissions.accessFilesystemRules.push({ path: workspace.path, access: "write" });
    const parentWrite = await write(path.join(readRoot, "allowed.txt"));
    expect(parentWrite.exitCode, parentWrite.stderr).toBe(0);
  });

  it.each(
    (["read", "deny"] as const).flatMap((access) =>
      [
        "root",
        "intermediate",
        "missing",
        "chain",
        "rename",
        "rename-existing",
        "missing-case",
        "existing-case",
      ].map((kind) => ({ access, kind })),
    ),
  )("keeps the $kind symlink namespace stable for a $access rule", async ({ access, kind }) => {
    const a = path.join(workspace.path, "a");
    const b = path.join(workspace.path, "b");
    fs.mkdirSync(path.join(a, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(b, "inputs"), { recursive: true });
    const link = path.join(workspace.path, "named");
    const target = kind === "root" ? path.join(b, "file") : path.join(b, "inputs", "file");
    fs.writeFileSync(target, "original");
    let replace = link;
    if (kind === "chain") {
      replace = path.join(workspace.path, "second-link");
      fs.symlinkSync(a, replace);
      fs.symlinkSync(replace, link);
    } else if (!kind.startsWith("missing") && kind !== "rename") {
      fs.symlinkSync(a, link);
    }
    if (kind.endsWith("-case")) replace = path.join(workspace.path, "NaMeD");
    const rulePath = kind === "root" ? link : path.join(link, "inputs");
    workspace.permissions.accessFilesystemRules = [{ path: rulePath, access }];
    const mutation = kind.startsWith("rename")
      ? `fs.symlinkSync(${JSON.stringify(b)},${JSON.stringify(link + "-temporary")});fs.renameSync(${JSON.stringify(link + "-temporary")},${JSON.stringify(link)});`
      : `${kind.startsWith("missing") ? "" : `fs.unlinkSync(${JSON.stringify(replace)});`}fs.symlinkSync(${JSON.stringify(b)},${JSON.stringify(replace)});`;
    const result = await execute(
      `const fs=require('fs');${mutation}fs.writeFileSync(${JSON.stringify(path.join(rulePath, "file"))},'changed')`,
    );
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    const control = await write(path.join(workspace.path, "ordinary-output"));
    expect(control.exitCode, control.stderr).toBe(0);
  });

  it("permits real directories at missing policy prefixes and unrelated symlinks", async () => {
    const parent = path.join(workspace.path, "missing");
    workspace.permissions.accessFilesystemRules = [
      { path: path.join(parent, "inputs"), access: "read" },
    ];
    const result = await execute(
      `const fs=require('fs');fs.mkdirSync(${JSON.stringify(parent)});fs.writeFileSync(${JSON.stringify(path.join(parent, "output"))},'ok');fs.symlinkSync(${JSON.stringify(path.join(parent, "output"))},${JSON.stringify(path.join(parent, "unrelated-link"))})`,
    );
    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("preserves allowed writes through an existing named symlink", async () => {
    const target = path.join(workspace.path, "target");
    fs.mkdirSync(target);
    const link = path.join(workspace.path, "link");
    fs.symlinkSync(target, link);
    workspace.permissions.accessFilesystemRules = [
      { path: link, access: "read" },
      { path: workspace.path, access: "write" },
    ];
    const result = await write(path.join(link, "output"));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(target, "output"), "utf8")).toBe("changed");
  });

  it.each(["var", "tmp"] as const)(
    "preserves writes through the immutable /%s system alias",
    async (alias) => {
      const canonical = fs.realpathSync(workspace.path);
      expect(canonical.startsWith("/private/var/")).toBe(true);
      // Both spellings resolve into the managed fixture tree. /tmp/../var also
      // exercises traversal through /tmp without leaving test files in /tmp.
      workspace.path =
        alias === "var"
          ? canonical.slice(8)
          : `/tmp/../var/${canonical.slice("/private/var/".length)}`;
      workspace.permissions.accessWorkspaceRoots = [`/${alias}`];
      const output = path.join(canonical, "alias-output");
      const spelledOutput = `${workspace.path}/alias-output`;
      const result = await write(spelledOutput);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toBe("changed");
    },
  );

  it.each([
    "nested/.git/config",
    "new/.GiT/hooks/pre-commit",
    "nested/.CoWoRk/PoLiCy/permissions.json",
  ])("blocks existing and future protected path %s", async (relative) => {
    const target = path.join(workspace.path, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await write(target);
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("blocks protected directory creation after launch and symlink aliases", async () => {
    const target = path.join(workspace.path, "new", ".git");
    fs.mkdirSync(path.dirname(target));
    expect((await execute(`require('fs').mkdirSync(${JSON.stringify(target)})`)).exitCode).not.toBe(
      0,
    );
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(workspace.path, "alias"));
    expect((await write(path.join(workspace.path, "alias", "config"))).exitCode).not.toBe(0);
  });

  it("blocks directory relocation around a deny boundary and keeps scratch cleanup usable", async () => {
    const parent = path.join(workspace.path, "parent");
    const denied = path.join(parent, "secret");
    fs.mkdirSync(denied, { recursive: true });
    workspace.permissions.accessFilesystemRules = [{ path: denied, access: "deny" }];
    const result = await execute(
      `require('fs').renameSync(${JSON.stringify(parent)}, ${JSON.stringify(path.join(workspace.path, "moved"))})`,
    );
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(fs.existsSync(denied)).toBe(true);
    const cleanup = await execute(
      "const fs=require('fs'),os=require('os'),path=require('path');const d=fs.mkdtempSync(path.join(os.tmpdir(),'child-'));fs.writeFileSync(path.join(d,'file'),'ok');fs.unlinkSync(path.join(d,'file'));fs.rmdirSync(d)",
    );
    expect(cleanup.exitCode, cleanup.stderr).toBe(0);
  });

  it("keeps a nested repository immutable when its parent moves, and blocks protected names in scratch", async () => {
    const parent = path.join(workspace.path, "parent");
    fs.mkdirSync(path.join(parent, ".git", "hooks"), { recursive: true });
    const moved = path.join(workspace.path, "moved");
    const result = await execute(
      `const fs=require('fs');fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(moved)});` +
        `try{fs.writeFileSync(${JSON.stringify(path.join(moved, ".git", "hooks", "pre-commit"))},'x');process.exit(3)}catch{}` +
        `try{fs.renameSync(${JSON.stringify(path.join(moved, ".git"))}, ${JSON.stringify(path.join(moved, "plain"))});process.exit(4)}catch{}`,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(moved, ".git", "hooks"))).toBe(true);
    expect(fs.existsSync(path.join(moved, ".git", "hooks", "pre-commit"))).toBe(false);
    const scratch = await execute(
      "require('fs').mkdirSync(require('path').join(require('os').tmpdir(),'.git'))",
    );
    expect(scratch.exitCode).not.toBe(0);
  });

  it("keeps a nested repository moved into private scratch when scratch is cleaned up", async () => {
    const nested = path.join(workspace.path, "vendor");
    fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
    fs.writeFileSync(path.join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");
    const sandbox = new MacOSSandbox(workspace);
    const result = await sandbox.execute(
      process.execPath,
      [
        "-e",
        `const fs=require('fs'),os=require('os'),path=require('path');fs.renameSync(${JSON.stringify(nested)}, path.join(os.tmpdir(),'vendor'));console.log(os.tmpdir())`,
      ],
      { cwd: workspace.path },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const scratchDir = result.stdout.trim();
    sandbox.cleanup();
    const head = path.join(scratchDir, "vendor", ".git", "HEAD");
    expect(fs.readFileSync(head, "utf8")).toContain("main");
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("permits directory removal, moves and rename-into-place inside the workspace", async () => {
    const dist = path.join(workspace.path, "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "old");
    fs.mkdirSync(path.join(workspace.path, "src"));
    const result = await execute(
      [
        "const fs=require('fs'),path=require('path'),ws=process.cwd();",
        // vite/next style: clean the output directory
        "fs.rmSync(path.join(ws,'dist'),{recursive:true});",
        // build under a temporary name, rename into place (cargo target, uv)
        "fs.mkdirSync(path.join(ws,'targetTmp1/debug'),{recursive:true});",
        "fs.renameSync(path.join(ws,'targetTmp1'),path.join(ws,'target'));",
        // mv src lib; rmdir an empty directory
        "fs.renameSync(path.join(ws,'src'),path.join(ws,'lib'));",
        "fs.mkdirSync(path.join(ws,'empty'));fs.rmdirSync(path.join(ws,'empty'));",
        // atomic file replace
        "fs.writeFileSync(path.join(ws,'config.json'),'{}');",
        "fs.writeFileSync(path.join(ws,'config.json.tmp'),'{\"v\":2}');",
        "fs.renameSync(path.join(ws,'config.json.tmp'),path.join(ws,'config.json'));",
      ].join(""),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fs.existsSync(dist)).toBe(false);
    expect(fs.existsSync(path.join(workspace.path, "target", "debug"))).toBe(true);
    expect(fs.existsSync(path.join(workspace.path, "lib"))).toBe(true);
    expect(fs.readFileSync(path.join(workspace.path, "config.json"), "utf8")).toBe('{"v":2}');
  });

  it("keeps the workspace root and directories outside the workspace from moving", async () => {
    const outside = path.join(base, "outside-root");
    fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
    workspace.permissions.accessWorkspaceRoots = [workspace.path, outside];
    const moveRoot = await execute(
      `require('fs').renameSync(process.cwd(), require('path').join(require('os').tmpdir(),'ws'))`,
    );
    expect(moveRoot.exitCode).not.toBe(0);
    expect(fs.existsSync(workspace.path)).toBe(true);
    const moveOutside = await execute(
      `require('fs').renameSync(${JSON.stringify(path.join(outside, "dir"))}, ${JSON.stringify(path.join(outside, "moved"))})`,
    );
    expect(moveOutside.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(outside, "dir"))).toBe(true);
    const removeOutside = await execute(
      `require('fs').rmdirSync(${JSON.stringify(path.join(outside, "dir"))})`,
    );
    expect(removeOutside.exitCode).not.toBe(0);
  });

  it("keeps a read-only subtree's ancestors fixed so the rule cannot be shed", async () => {
    const parent = path.join(workspace.path, "parent");
    const inputs = path.join(parent, "inputs");
    fs.mkdirSync(inputs, { recursive: true });
    fs.writeFileSync(path.join(inputs, "data.txt"), "original");
    workspace.permissions.accessFilesystemRules = [{ path: inputs, access: "read" }];
    const result = await execute(
      `const fs=require('fs');fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(path.join(workspace.path, "elsewhere"))});fs.writeFileSync(${JSON.stringify(path.join(workspace.path, "elsewhere", "inputs", "data.txt"))},'changed')`,
    );
    expect(result.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(inputs, "data.txt"), "utf8")).toBe("original");
    const sibling = path.join(workspace.path, "sibling");
    fs.mkdirSync(sibling);
    const unrelated = await execute(
      `require('fs').renameSync(${JSON.stringify(sibling)}, ${JSON.stringify(sibling + "-moved")})`,
    );
    expect(unrelated.exitCode, unrelated.stderr).toBe(0);
  });

  it.each([false, true])(
    "enforces delete capability through unlink and rename (legacy=%s)",
    async (legacy) => {
      workspace.permissions.delete = false;
      const input = path.join(workspace.path, "input.txt");
      fs.writeFileSync(input, "original");
      const unlink = await execute(`require('fs').unlinkSync(${JSON.stringify(input)})`, legacy);
      expect(unlink.exitCode, unlink.stderr).not.toBe(0);
      const rename = await execute(
        `require('fs').renameSync(${JSON.stringify(input)}, ${JSON.stringify(path.join(workspace.path, "moved.txt"))})`,
        legacy,
      );
      expect(rename.exitCode, rename.stderr).not.toBe(0);
      expect(fs.readFileSync(input, "utf8")).toBe("original");
      const update = await write(input, legacy);
      expect(update.exitCode, update.stderr).toBe(0);
    },
  );

  it("permits regular file rename/delete when granted and denies delete under a write rule", async () => {
    const input = path.join(workspace.path, "input.txt");
    fs.writeFileSync(input, "original");
    const allowed = await execute(
      `const fs=require('fs');fs.renameSync(${JSON.stringify(input)}, ${JSON.stringify(input + ".moved")});fs.unlinkSync(${JSON.stringify(input + ".moved")})`,
    );
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    fs.writeFileSync(input, "original");
    workspace.permissions.accessFilesystemRules = [{ path: input, access: "write" }];
    const denied = await execute(`require('fs').unlinkSync(${JSON.stringify(input)})`);
    expect(denied.exitCode, denied.stderr).not.toBe(0);
  });

  it.each([false, true])(
    "keeps run_command out of the memory repo, even inside a home-like workspace (legacy=%s)",
    async (legacy) => {
      const outside = path.join(base, "memory");
      const inside = path.join(workspace.path, ".cowork-memory");
      for (const root of [outside, inside]) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "MEMORY.md"), "- secret fact");
      }
      workspace.permissions.allowedPaths = [base];
      try {
        for (const root of [outside, inside]) {
          setMemoryRepoRoot(root);
          const file = path.join(root, "MEMORY.md");
          const read = await execute(
            `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'))`,
            legacy,
          );
          expect(read.exitCode).not.toBe(0);
          expect(read.stdout).not.toContain("secret fact");
          const written = await write(file, legacy);
          expect(written.exitCode).not.toBe(0);
          expect((await write(path.join(root, "new.md"), legacy)).exitCode).not.toBe(0);
          expect(fs.readFileSync(file, "utf8")).toBe("- secret fact");
          expect(fs.existsSync(path.join(root, "new.md"))).toBe(false);
        }
        const ordinary = await write(path.join(workspace.path, "output.txt"), legacy);
        expect(ordinary.exitCode, ordinary.stderr).toBe(0);
      } finally {
        setMemoryRepoRoot(null);
      }
    },
  );

  it.each([false, true])(
    "keeps run_command out of team memory repos too (legacy=%s)",
    async (legacy) => {
      const team = path.join(base, "team-memory");
      const personal = path.join(base, "memory");
      for (const root of [team, personal]) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "MEMORY.md"), "- team fact");
      }
      workspace.permissions.allowedPaths = [base];
      try {
        setMemoryRepoRoot(personal);
        setTeamMemoryRepoRoots([team]);
        const file = path.join(team, "MEMORY.md");
        const read = await execute(
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}, 'utf8'))`,
          legacy,
        );
        expect(read.exitCode).not.toBe(0);
        expect(read.stdout).not.toContain("team fact");
        expect((await write(file, legacy)).exitCode).not.toBe(0);
        expect((await write(path.join(team, "new.md"), legacy)).exitCode).not.toBe(0);
        expect(fs.readFileSync(file, "utf8")).toBe("- team fact");
        expect(fs.existsSync(path.join(team, "new.md"))).toBe(false);
        // A team repo alone (no personal folder) is still denied.
        setMemoryRepoRoot(null);
        expect((await write(path.join(team, "other.md"), legacy)).exitCode).not.toBe(0);
        expect(fs.existsSync(path.join(team, "other.md"))).toBe(false);
        const ordinary = await write(path.join(workspace.path, "output.txt"), legacy);
        expect(ordinary.exitCode, ordinary.stderr).toBe(0);
      } finally {
        setMemoryRepoRoot(null);
        setTeamMemoryRepoRoots([]);
      }
    },
  );
});
