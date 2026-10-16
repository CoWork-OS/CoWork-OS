import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import {
  decodeSpaceOutputs,
  publishSpaceOutputs,
  snapshotSpaceInputs,
  spaceRelativePath,
  validateSpaceOutputs,
} from "../space-files";

describe("SPACE file boundary", () => {
  let base: string;
  let workspace: Workspace;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "space-files-"));
    workspace = {
      id: "test",
      name: "test",
      path: path.join(base, "workspace"),
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, shell: true, network: false },
    };
    fs.mkdirSync(workspace.path);
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it.each([
    "../secret",
    ".git /config",
    ".git./config",
    ".env.",
    "folder /out",
    "CON",
    "a/nul.txt",
    "Lpt9.log",
    "a?.csv",
    "a\x7fb",
    "/etc/passwd",
    "a/../../secret",
    "a\\..\\secret",
    "C:/secret",
    "a//b",
    "a/./b",
    ".git/config",
    ".cowork/policy/a",
    ".env",
    ".env.production",
    ".ssh/id_rsa",
    "x\0y",
  ])("rejects traversal and private path %s", (value) =>
    expect(() => spaceRelativePath(value)).toThrow(),
  );
  it("rejects file and parent symlinks even into an otherwise readable workspace", () => {
    fs.writeFileSync(path.join(base, "secret"), "secret");
    fs.symlinkSync(path.join(base, "secret"), path.join(workspace.path, "link"));
    fs.symlinkSync(base, path.join(workspace.path, "linked-dir"));
    expect(() => snapshotSpaceInputs(workspace, ["link"])).toThrow();
    expect(() => snapshotSpaceInputs(workspace, ["linked-dir/secret"])).toThrow();
    expect(() => validateSpaceOutputs(workspace, ["linked-dir/output"])).toThrow();
  });
  it("honors read, write, and deny-rule boundaries with no delete authority", () => {
    fs.writeFileSync(path.join(workspace.path, "input"), "ok");
    workspace.permissions.read = false;
    expect(() => snapshotSpaceInputs(workspace, ["input"])).toThrow("denied");
    workspace.permissions.read = true;
    workspace.permissions.accessFilesystemRules = [
      { path: path.join(workspace.path, "input"), access: "deny" },
    ];
    expect(() => snapshotSpaceInputs(workspace, ["input"])).toThrow("denied");
    workspace.permissions.write = false;
    expect(() => validateSpaceOutputs(workspace, ["output"])).toThrow("denied");
  });
  it("refuses directories, oversized files, duplicate paths, and existing destinations", () => {
    fs.mkdirSync(path.join(workspace.path, "directory"));
    fs.writeFileSync(path.join(workspace.path, "big"), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => snapshotSpaceInputs(workspace, ["directory"])).toThrow();
    expect(() => snapshotSpaceInputs(workspace, ["big"])).toThrow("limits");
    expect(() => snapshotSpaceInputs(workspace, ["big", "big"])).toThrow("selection");
    expect(() => validateSpaceOutputs(workspace, ["big"])).toThrow("new files");
  });
  it("validates every artifact's identity and hash before publication", () => {
    const data = Buffer.from("artifact");
    const manifest = [
      {
        path: "output",
        data: data.toString("base64"),
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ];
    expect(decodeSpaceOutputs(JSON.stringify(manifest), ["output"])[0].data).toEqual(data);
    expect(() => decodeSpaceOutputs(JSON.stringify(manifest), ["other"])).toThrow("path");
    expect(() =>
      decodeSpaceOutputs(JSON.stringify([{ ...manifest[0], sha256: "bad" }]), ["output"]),
    ).toThrow("digest");
    expect(() =>
      decodeSpaceOutputs(JSON.stringify([{ ...manifest[0], data: "!!" }]), ["output"]),
    ).toThrow("base64");
  });
  it.each(["parent", "workspace"])(
    "rejects replacement of the selected %s directory during a run",
    (replacement) => {
      fs.mkdirSync(path.join(workspace.path, "out"));
      const bindings = validateSpaceOutputs(workspace, ["out/result.txt"]);
      const original = replacement === "parent" ? path.join(workspace.path, "out") : workspace.path;
      fs.renameSync(original, original + "-old");
      fs.mkdirSync(original);
      if (replacement === "workspace") fs.mkdirSync(path.join(original, "out"));
      expect(() =>
        publishSpaceOutputs(
          workspace,
          [{ path: "out/result.txt", data: Buffer.from("remote") }],
          () => {},
          bindings,
        ),
      ).toThrow("destination changed");
      expect(fs.existsSync(path.join(workspace.path, "out/result.txt"))).toBe(false);
    },
  );

  it("never overwrites user content and records partial publication without deleting it", () => {
    fs.writeFileSync(path.join(workspace.path, "second"), "user");
    const published: string[] = [];
    expect(() =>
      publishSpaceOutputs(
        workspace,
        [
          { path: "first", data: Buffer.from("remote") },
          { path: "second", data: Buffer.from("bad") },
        ],
        (relative) => published.push(relative),
      ),
    ).toThrow();
    expect(published).toEqual(["first"]);
    expect(fs.readFileSync(path.join(workspace.path, "first"), "utf8")).toBe("remote");
    expect(fs.readFileSync(path.join(workspace.path, "second"), "utf8")).toBe("user");
  });
});
