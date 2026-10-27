import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPtyManager, buildZshPromptSetup } from "../TerminalPtyManager";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

// Escapes are built from code points: the formatter rewrites \u escapes as invisible characters.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ST = `${ESC}\\`;

const commandMark = (nonce: string, encoded: string, end = BEL) =>
  `${ESC}]133;E;${nonce};${encoded}${end}`;

describe("TerminalPtyManager command marks", () => {
  let emitOutput: (output: string) => void;
  let manager: TerminalPtyManager;

  beforeEach(() => {
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

  const openTab = (workspaceId = "workspace-1") => {
    const tab = manager.createTab({ workspaceId, workspacePath: "/tmp", title: "My tab" });
    return { id: tab.id, nonce: manager.getShellMarkNonce(tab.id) };
  };
  const tabInfo = (id: string) => manager.listTabs().find((tab) => tab.id === id);

  it("records the command line a command mark reports and passes the output on unchanged", () => {
    const { id, nonce } = openTab();
    const listener = vi.fn();
    manager.attachTerminalTabOutput(id, "window", listener);
    expect(tabInfo(id)?.lastCommandAt).toBeUndefined();

    const output = `${commandMark(nonce, "git%20commit%20-m%20%22fix%3A%20a%20b%22")}output\r\n`;
    emitOutput(output);

    expect(tabInfo(id)).toMatchObject({
      lastCommand: 'git commit -m "fix: a b"',
      lastCommandAt: expect.any(Number),
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ output }));
  });

  it("decodes UTF-8 and several lines, and drops control characters", () => {
    const { id, nonce } = openTab();
    const decoded = (encoded: string) => {
      emitOutput(commandMark(nonce, encoded));
      return tabInfo(id)?.lastCommand;
    };
    expect(decoded("ls%20~/%C3%9Cn%C3%AF%20%F0%9F%98%80")).toBe("ls ~/Ünï 😀");
    expect(decoded("echo%20a%0Aecho%09b")).toBe("echo a\necho\tb");
    expect(decoded("x%1B%5B31my%07%7F")).toBe("x[31my");
    expect(decoded("50%25%zz%4")).toBe("50%%zz%4");
    // A line zsh cut inside a multi-byte character still decodes.
    expect(decoded("abc%F0%9F")).toMatch(/^abc�/);
  });

  it("ignores marks without the tab's nonce, so command output cannot set the last command", () => {
    const other = openTab("workspace-2");
    // Output now reaches the newest tab only.
    const { id, nonce } = openTab();
    emitOutput(commandMark(other.nonce, "rm%20-rf%20x"));
    emitOutput(commandMark("", "rm%20-rf%20x"));
    emitOutput(commandMark(`${nonce}0`, "rm%20-rf%20x"));
    emitOutput(commandMark(nonce.slice(1), "rm%20-rf%20x"));
    expect(tabInfo(id)?.lastCommandAt).toBeUndefined();
    expect(tabInfo(id)?.lastCommand).toBe("My tab");
    expect(tabInfo(other.id)?.lastCommandAt).toBeUndefined();
  });

  it("finds a mark split anywhere across two chunks, with either terminator", () => {
    for (const end of [BEL, ST]) {
      for (let split = 1; split < 40; split += 1) {
        manager = new TerminalPtyManager();
        const { id, nonce } = openTab();
        const output = `out${commandMark(nonce, "npm%20test", end)}more`;
        emitOutput(output.slice(0, split));
        emitOutput(output.slice(split));
        expect(tabInfo(id)?.lastCommand, `split at ${split}`).toBe("npm test");
      }
    }
  });

  it("finds a long mark split across chunks, past the working-directory parser's window", () => {
    const { id, nonce } = openTab();
    const output = commandMark(nonce, "%41".repeat(2048));
    emitOutput(output.slice(0, 1000));
    emitOutput(output.slice(1000, 5000));
    expect(tabInfo(id)?.lastCommandAt).toBeUndefined();
    emitOutput(output.slice(5000));
    expect(tabInfo(id)?.lastCommand).toBe("A".repeat(2048));
  });

  it("drops an unfinished mark once it is longer than any real mark", () => {
    const { id, nonce } = openTab();
    emitOutput(`${ESC}]133;E;${nonce};${"%41".repeat(3000)}`);
    emitOutput(BEL);
    expect(tabInfo(id)?.lastCommandAt).toBeUndefined();

    emitOutput(commandMark(nonce, "ls"));
    expect(tabInfo(id)?.lastCommand).toBe("ls");
  });

  it("keeps the last of several marks and reports an empty line as no command", () => {
    const { id, nonce } = openTab();
    emitOutput(`${commandMark(nonce, "ls")}x\r\n${commandMark(nonce, "pwd")}`);
    expect(tabInfo(id)?.lastCommand).toBe("pwd");

    emitOutput(commandMark(nonce, ""));
    expect(tabInfo(id)?.lastCommand).toBeUndefined();
    expect(tabInfo(id)?.lastCommandAt).toEqual(expect.any(Number));
  });
});

const ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) => fs.existsSync(candidate));

describe.skipIf(!ZSH)("zsh integration command marks", () => {
  let dir = "";
  let manager: TerminalPtyManager;
  let emitOutput: (output: string) => void;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-command-marks-"));
    fs.writeFileSync(path.join(dir, "setup.zsh"), buildZshPromptSetup());
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
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
        }) as unknown as pty.IPty,
    );
    process.env.SHELL = "/bin/sh";
  });

  /** An interactive zsh without the user's rc files, fed lines as if they were typed. */
  const runZsh = (lines: string[], nonce?: string): string => {
    const result = spawnSync(ZSH as string, ["-f", "-i"], {
      input: [`source '${path.join(dir, "setup.zsh")}'`, ...lines, ""].join("\n"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        TERM: "dumb",
        ...(nonce ? { COWORK_TERMINAL_MARK_NONCE: nonce } : {}),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    return `${result.stdout}${result.stderr}`;
  };
  const openTab = () => {
    const tab = manager.createTab({ workspaceId: "workspace-1", workspacePath: "/tmp" });
    return { id: tab.id, nonce: manager.getShellMarkNonce(tab.id) };
  };
  const commandMarks = (output: string) =>
    output
      .split(`${ESC}]133;E;`)
      .slice(1)
      .map((part) => part.split(BEL)[0]);

  it("reports each typed line before the start mark, and keeps the done mark", () => {
    const { id, nonce } = openTab();
    const typed = `print -r -- "50% done" 'ünï 😀' $'tab\\there' | tr a-z A-Z`;
    const output = runZsh(["true", typed], nonce);

    const markAt = output.lastIndexOf(`${ESC}]133;E;${nonce};`);
    const startAt = output.indexOf(`${ESC}]133;C;${nonce}${BEL}`, markAt);
    expect(markAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(markAt);
    expect(output.indexOf(`${ESC}]133;D;${nonce};0${BEL}`, startAt)).toBeGreaterThan(startAt);
    // Only unreserved ASCII travels as is.
    for (const mark of commandMarks(output)) {
      expect(mark.slice(nonce.length + 1)).toMatch(/^[A-Za-z0-9._~/%-]*$/);
    }

    emitOutput(output);
    expect(tabInfo(manager, id)).toMatchObject({ lastCommand: typed });
  });

  it("reports a line HIST_IGNORE_SPACE keeps out of history as no command", () => {
    const { id, nonce } = openTab();
    const output = runZsh(
      ["setopt hist_ignore_space", "echo visible", " echo SECRET_VALUE=hunter2"],
      nonce,
    );
    expect(commandMarks(output).join("\n")).not.toContain("hunter2");

    emitOutput(output);
    expect(tabInfo(manager, id)?.lastCommand).toBeUndefined();
    expect(tabInfo(manager, id)?.lastCommandAt).toEqual(expect.any(Number));
  });

  it("cuts a line longer than 2048 bytes", () => {
    const { id, nonce } = openTab();
    emitOutput(runZsh([`: ${"a".repeat(3000)}`], nonce));
    expect(tabInfo(manager, id)?.lastCommand).toBe(`: ${"a".repeat(2046)}`);
  });

  it("sends no command mark from a shell that has no nonce", () => {
    expect(runZsh(["echo hi"])).not.toContain(`${ESC}]133;E;`);
  });
});

function tabInfo(manager: TerminalPtyManager, id: string) {
  return manager.listTabs().find((tab) => tab.id === id);
}
