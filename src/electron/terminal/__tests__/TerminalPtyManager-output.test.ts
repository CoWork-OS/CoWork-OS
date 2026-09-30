import * as pty from "node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPtyManager } from "../TerminalPtyManager";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const MAX_REPLAY_BUFFER_LENGTH = 256 * 1024;

describe("TerminalPtyManager output offsets", () => {
  let emitOutput: ((output: string) => void) | null;
  let manager: TerminalPtyManager;

  beforeEach(() => {
    emitOutput = null;
    manager = new TerminalPtyManager();
    vi.mocked(pty.spawn).mockImplementation(
      () =>
        ({
          onData: (listener: (output: string) => void) => {
            emitOutput = listener;
            return { dispose: vi.fn() };
          },
          onExit: () => ({ dispose: vi.fn() }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          pid: 1,
          process: "shell",
          cols: 80,
          rows: 24,
        }) as unknown as pty.IPty,
    );
    process.env.SHELL = "/bin/sh";
  });

  it("reports absolute UTF-16 code-unit offsets and detaches keyed listeners", () => {
    const tab = manager.createTab({ workspaceId: "workspace-1", workspacePath: "/tmp" });
    const listener = vi.fn();
    manager.attachTerminalTabOutput(tab.id, "browser-1", listener);

    emitOutput?.("a😀");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ output: "a😀", offset: 0, nextOffset: 3 }),
    );
    expect(manager.detachTerminalTabOutput(tab.id, "browser-1")).toBe(true);

    emitOutput?.("ignored");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.detachTerminalTabOutput(tab.id, "missing")).toBe(false);
  });

  it("replays the bounded tail with its absolute offset without splitting a surrogate pair", async () => {
    const tab = manager.createTab({ workspaceId: "workspace-2", workspacePath: "/tmp" });
    const liveListener = vi.fn();
    manager.attachTerminalTabOutput(tab.id, "first", liveListener);

    const output = `😀${"x".repeat(MAX_REPLAY_BUFFER_LENGTH - 1)}`;
    emitOutput?.(output);
    expect(output.length).toBe(MAX_REPLAY_BUFFER_LENGTH + 1);

    const replayListener = vi.fn();
    manager.attachTerminalTabOutput(tab.id, "second", replayListener);
    await Promise.resolve();

    const replay = replayListener.mock.calls[0]?.[0];
    expect(replay?.offset).toBe(2);
    expect(replay?.nextOffset).toBe(output.length);
    expect(replay?.output.length).toBe(MAX_REPLAY_BUFFER_LENGTH - 1);
    expect(replay?.output.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(replay?.output).not.toMatch(/^[\uDC00-\uDFFF]/);
  });

  it("suppresses a queued replay after its keyed listener is detached", async () => {
    const tab = manager.createTab({ workspaceId: "workspace-3", workspacePath: "/tmp" });
    manager.attachTerminalTabOutput(tab.id, "first", vi.fn());
    emitOutput?.("buffered output");

    const replayListener = vi.fn();
    manager.attachTerminalTabOutput(tab.id, "temporary", replayListener);
    expect(manager.detachTerminalTabOutput(tab.id, "temporary")).toBe(true);
    await Promise.resolve();

    expect(replayListener).not.toHaveBeenCalled();
  });
});
