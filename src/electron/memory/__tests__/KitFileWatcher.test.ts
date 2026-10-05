import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KIT_EDIT_DEBOUNCE_MS,
  KitFileWatcher,
  kitFilesInsideWorkspace,
  type KitFileWatcherDeps,
} from "../KitFileWatcher";

describe("KitFileWatcher", () => {
  let dir: string;
  let listeners: Map<string, (fileName: string | null) => void>;
  let closed: string[];
  let sync: ReturnType<typeof vi.fn>;
  let watcher: KitFileWatcher;

  const workspace = (name: string) => {
    const workspacePath = path.join(dir, name);
    fs.mkdirSync(path.join(workspacePath, ".cowork"), { recursive: true });
    return workspacePath;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-watch-"));
    listeners = new Map();
    closed = [];
    sync = vi.fn(async () => undefined);
    const deps: KitFileWatcherDeps = {
      watch: (directory, onChange) => {
        listeners.set(directory, onChange);
        return { close: () => closed.push(directory) };
      },
      sync,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (timer) => clearTimeout(timer),
      maxWorkspaces: 2,
    };
    watcher = new KitFileWatcher(deps);
  });

  afterEach(() => {
    watcher.close();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("debounces a burst of kit file edits into one sync", async () => {
    const workspacePath = workspace("a");
    watcher.watch("ws-a", workspacePath);
    const changed = listeners.get(path.join(workspacePath, ".cowork"));
    expect(changed).toBeDefined();

    changed?.("USER.md");
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS - 100);
    changed?.("MEMORY.md");
    changed?.("USER.md");
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS - 100);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("ws-a");

    // Other files in `.cowork` do not trigger a sync.
    changed?.("CONTEXT.md");
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS * 2);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("runs one more sync for an edit made while a sync is running", async () => {
    const workspacePath = workspace("a");
    let release: () => void = () => undefined;
    sync.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    watcher.watch("ws-a", workspacePath);
    const changed = listeners.get(path.join(workspacePath, ".cowork"));
    changed?.("USER.md");
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    changed?.("USER.md");
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("watches a bounded number of workspaces and never a symlinked .cowork", () => {
    const a = workspace("a");
    const b = workspace("b");
    const c = workspace("c");
    watcher.watch("ws-a", a);
    watcher.watch("ws-b", b);
    watcher.watch("ws-c", c);
    expect(watcher.size).toBe(2);
    expect(closed).toEqual([path.join(a, ".cowork")]);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-outside-"));
    const linked = path.join(dir, "linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(outside, path.join(linked, ".cowork"));
    watcher.watch("ws-linked", linked);
    expect(listeners.has(path.join(linked, ".cowork"))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("stops watching and drops pending syncs when closed", async () => {
    const workspacePath = workspace("a");
    watcher.watch("ws-a", workspacePath);
    listeners.get(path.join(workspacePath, ".cowork"))?.("USER.md");
    watcher.close();
    await vi.advanceTimersByTimeAsync(KIT_EDIT_DEBOUNCE_MS * 2);
    expect(sync).not.toHaveBeenCalled();
    expect(watcher.size).toBe(0);
  });

  it("is a no-op without an installed instance", () => {
    expect(() => KitFileWatcher.watchWorkspace({ id: "ws", path: dir })).not.toThrow();
  });
});

describe("kitFilesInsideWorkspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-inside-")));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts regular kit files and refuses symlinks", async () => {
    const workspacePath = path.join(dir, "ws");
    const kit = path.join(workspacePath, ".cowork");
    fs.mkdirSync(kit, { recursive: true });
    expect(await kitFilesInsideWorkspace(workspacePath)).toBe(true);
    fs.writeFileSync(path.join(kit, "USER.md"), "# User\n");
    expect(await kitFilesInsideWorkspace(workspacePath)).toBe(true);

    const secret = path.join(dir, "secret.md");
    fs.writeFileSync(secret, "outside");
    fs.symlinkSync(secret, path.join(kit, "MEMORY.md"));
    expect(await kitFilesInsideWorkspace(workspacePath)).toBe(false);
  });

  it("refuses a .cowork directory that is a symlink", async () => {
    const workspacePath = path.join(dir, "ws");
    fs.mkdirSync(workspacePath);
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspacePath, ".cowork"));
    expect(await kitFilesInsideWorkspace(workspacePath)).toBe(false);
  });
});
