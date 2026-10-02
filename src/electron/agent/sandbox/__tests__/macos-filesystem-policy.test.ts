import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";
import { SandboxRunner } from "../runner";

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

  it("blocks moving a protected ancestor or importing protected names from private scratch", async () => {
    const parent = path.join(workspace.path, "parent");
    fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
    expect(
      (
        await execute(
          `require('fs').renameSync(${JSON.stringify(parent)}, ${JSON.stringify(path.join(workspace.path, "moved"))})`,
        )
      ).exitCode,
    ).not.toBe(0);
    const scratch = await execute(
      "require('fs').mkdirSync(require('path').join(require('os').tmpdir(),'.git'))",
    );
    expect(scratch.exitCode).not.toBe(0);
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
});
