import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/test-cowork" },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { MessageRouter } from "../router";

describe("gateway attachment destination boundary", () => {
  let root: string;
  let workspace: Any;
  let router: MessageRouter;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-attachment-boundary-"));
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath);
    fs.mkdirSync(path.join(root, "outside"));
    workspace = {
      path: workspacePath,
      permissions: { read: true, write: true, unrestrictedFileAccess: true },
    };
    const statement = { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
    const db = {
      prepare: () => statement,
      transaction: (fn: Any) => Object.assign(fn, { deferred: fn, immediate: fn }),
    };
    router = new MessageRouter(db as Any, {}, undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const persist = (router: MessageRouter, workspace: Any, attachments: Any[], ids = {}) =>
    (router as Any).persistInboundAttachments(
      "telegram",
      { chatId: "chat", messageId: "message", attachments, ...ids },
      workspace,
    );

  it.each(["buffer", "local", "remote"])(
    "rejects an ancestor symlink for %s attachments",
    async (source) => {
      fs.symlinkSync(path.join(root, "outside"), path.join(workspace.path, ".cowork"));
      const local = path.join(root, "adapter-download.bin");
      fs.writeFileSync(local, "attachment");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("attachment")));
      const att =
        source === "buffer"
          ? { data: Buffer.from("attachment") }
          : { url: source === "local" ? local : "https://cdn.example/attachment" };
      expect(
        await persist(router, workspace, [{ type: "file", fileName: "report.bin", ...att }]),
      ).toEqual([]);
      expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
    },
  );
  it("honors a workspace with writes disabled", async () => {
    workspace.permissions.write = false;
    expect(
      await persist(router, workspace, [{ data: Buffer.from("data"), fileName: "report.txt" }]),
    ).toEqual([]);
    expect(fs.existsSync(path.join(workspace.path, ".cowork"))).toBe(false);
  });
  it.each([".", ".."])("rejects a parent/dot chat segment: %s", async (chatId) => {
    expect(
      await persist(router, workspace, [{ data: Buffer.from("data"), fileName: "report.bin" }], {
        chatId,
      }),
    ).toEqual([]);
    expect(fs.existsSync(path.join(workspace.path, ".cowork"))).toBe(false);
  });
  it("rechecks containment after a download awaits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        fs.rmSync(path.join(workspace.path, ".cowork"), { recursive: true });
        fs.symlinkSync(path.join(root, "outside"), path.join(workspace.path, ".cowork"));
        return new Response("data");
      }),
    );
    expect(
      await persist(router, workspace, [
        { url: "https://cdn.example/file", fileName: "report.bin" },
      ]),
    ).toEqual([]);
    expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
  });
  it("preserves buffer, local download, remote download and duplicate filename intake", async () => {
    const local = path.join(root, "adapter-download.bin");
    fs.writeFileSync(local, "local");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("remote")));
    const saved = await persist(router, workspace, [
      { data: Buffer.from("buffer"), fileName: "report.bin" },
      { url: local, fileName: "report.bin" },
      { url: "https://cdn.example/file", fileName: "remote.bin" },
    ]);
    expect(saved).toHaveLength(3);
    expect(saved.map((a: Any) => fs.readFileSync(a.absPath, "utf8"))).toEqual([
      "buffer",
      "local",
      "remote",
    ]);
    expect(new Set(saved.map((a: Any) => a.absPath)).size).toBe(3);
  });
  it.each([false, true])(
    "rejects a final symlink, including the collision suffix (%s)",
    async (collision) => {
      vi.spyOn(Date, "now").mockReturnValue(12345);
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const dir = path.join(
        workspace.path,
        ".cowork/inbox/attachments",
        stamp,
        "telegram/chat/message",
      );
      fs.mkdirSync(dir, { recursive: true });
      const outsideFile = path.join(root, "outside", "victim");
      fs.writeFileSync(outsideFile, "untouched");
      if (collision) fs.writeFileSync(path.join(dir, "report.bin"), "original");
      fs.symlinkSync(outsideFile, path.join(dir, collision ? "report-12345-1.bin" : "report.bin"));
      const saved = await persist(router, workspace, [
        { data: Buffer.from("attack"), fileName: "report.bin" },
      ]);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("untouched");
      if (collision) expect(saved).toEqual([]);
      else expect(saved).toHaveLength(1); // An existing name selects a fresh, safe suffix.
    },
  );
  it("rejects dangling destination symlinks", async () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dir = path.join(
      workspace.path,
      ".cowork/inbox/attachments",
      stamp,
      "telegram/chat/message",
    );
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(root, "outside", "new-file");
    fs.symlinkSync(target, path.join(dir, "report.bin"));
    expect(
      await persist(router, workspace, [{ data: Buffer.from("attack"), fileName: "report.bin" }]),
    ).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
  it("denies a planted symlink into a protected directory inside the workspace", async () => {
    fs.mkdirSync(path.join(workspace.path, ".git"));
    fs.symlinkSync(path.join(workspace.path, ".git"), path.join(workspace.path, ".cowork"));
    expect(
      await persist(router, workspace, [{ data: Buffer.from("attack"), fileName: "report.bin" }]),
    ).toEqual([]);
    expect(fs.readdirSync(path.join(workspace.path, ".git"))).toEqual([]);
  });
  it("preserves a registered workspace root alias", async () => {
    const alias = path.join(root, "alias");
    fs.symlinkSync(workspace.path, alias);
    workspace.path = alias;
    expect(
      await persist(router, workspace, [{ data: Buffer.from("data"), fileName: "report.bin" }]),
    ).toHaveLength(1);
  });
  it("rejects a workspace root alias retargeted during download", async () => {
    const alias = path.join(root, "alias");
    fs.symlinkSync(workspace.path, alias);
    workspace.path = alias;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        fs.mkdirSync(
          path.join(root, "outside", ".cowork/inbox/attachments", stamp, "telegram/chat/message"),
          { recursive: true },
        );
        fs.unlinkSync(alias);
        fs.symlinkSync(path.join(root, "outside"), alias);
        return new Response("attack");
      }),
    );
    expect(
      await persist(router, workspace, [
        { url: "https://cdn.example/file", fileName: "report.bin" },
      ]),
    ).toEqual([]);
  });
});
