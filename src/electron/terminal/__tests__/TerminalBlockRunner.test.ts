import * as pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalBlockRunner, toShellInput } from "../TerminalBlockRunner";
import { TerminalPtyManager } from "../TerminalPtyManager";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const PROMPT = "cowork % ";

describe("TerminalBlockRunner", () => {
  let emitOutput: (output: string) => void;
  let writes: string[];
  let manager: TerminalPtyManager;
  /** Marks carry the newest tab's nonce, as its shell would print them. */
  const nonce = () => {
    const tabs = manager.listTabs("workspace-1");
    return manager.getShellMarkNonce(tabs[tabs.length - 1].id);
  };
  const start = () => `${ESC}]133;C;${nonce()}${BEL}`;
  const done = (status: number) => `${ESC}]133;D;${nonce()};${status}${BEL}`;

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    manager = new TerminalPtyManager();
    vi.mocked(pty.spawn).mockImplementation(
      () =>
        ({
          onData: (listener: (output: string) => void) => {
            emitOutput = listener;
            return { dispose: vi.fn() };
          },
          onExit: () => ({ dispose: vi.fn() }),
          write: (input: string) => writes.push(input),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  const params = (overrides: Partial<Parameters<TerminalBlockRunner["run"]>[0]> = {}) => ({
    runId: "run-1",
    workspaceId: "workspace-1",
    workspacePath: "/tmp",
    taskId: "task-1",
    command: "git status",
    onOutput: vi.fn(),
    ...overrides,
  });

  it("waits for a new tab's prompt, then captures output between the start and done marks", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const onOutput = vi.fn();
    const result = runner.run(params({ onOutput }));

    expect(writes).toEqual([]);
    emitOutput(`Last login: today\r\n${done(0)}${PROMPT}`);
    expect(writes).toEqual(["git status\r"]);

    emitOutput(`git status\r\n${start()}On branch main\r\n`);
    emitOutput(`nothing to commit\r\n${done(0)}${PROMPT}`);

    await expect(result).resolves.toMatchObject({
      runId: "run-1",
      output: "On branch main\r\nnothing to commit\r\n",
      exitCode: 0,
      terminationReason: "normal",
      truncated: false,
    });
    expect(onOutput.mock.calls.map(([chunk]) => chunk).join("")).toBe(
      "On branch main\r\nnothing to commit\r\n",
    );
  });

  it("reuses the task's tab, ignores its earlier output, and finds marks split across chunks", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const first = runner.run(params());
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`git status\r\n${start()}clean\r\n${done(0)}${PROMPT}`);
    const firstResult = await first;

    const second = runner.run(params({ runId: "run-2", command: "git push" }));
    // The reused tab gets the command right away; no new prompt wait.
    expect(writes.at(-1)).toBe("git push\r");
    emitOutput(`git push\r\n${ESC}]13`);
    emitOutput(`3;C;${nonce()}${BEL}${ESC}[31merror: rejected${ESC}[0m\r\n${ESC}]133;D;${nonce()}`);
    emitOutput(`;1${BEL}${PROMPT}`);

    const secondResult = await second;
    expect(secondResult.tabId).toBe(firstResult.tabId);
    expect(secondResult.output).toBe(`${ESC}[31merror: rejected${ESC}[0m\r\n`);
    expect(secondResult.exitCode).toBe(1);
  });

  it("drops zsh's partial-line marker before the prompt", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const result = runner.run(params({ command: "printf abc" }));
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`printf abc\r\n${start()}abc${ESC}[1m${ESC}[7m%${ESC}[27m${ESC}[1m${ESC}[0m   `);
    emitOutput(`   \r \r${done(0)}${PROMPT}`);
    await expect(result).resolves.toMatchObject({ output: "abc" });
  });

  it("finishes when the prompt returns without a start mark", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const result = runner.run(params({ command: "echo 'oops" }));
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`echo 'oops\r\nzsh: unmatched '\r\n${done(1)}${PROMPT}`);
    await expect(result).resolves.toMatchObject({
      output: "zsh: unmatched '\r\n",
      exitCode: 1,
    });
  });

  it("skips the echoed command in bash, which has no start mark", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "bash" });
    const result = runner.run(params({ command: "ls" }));
    emitOutput(`${done(0)}$ `);
    emitOutput("ls\r\nREADME.md\r\n");
    emitOutput(`${done(0)}$ `);
    await expect(result).resolves.toMatchObject({ output: "README.md\r\n", exitCode: 0 });
  });

  it("stops with Ctrl-C and reports the run as stopped", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const result = runner.run(params({ command: "npm run dev" }));
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`npm run dev\r\n${start()}ready on :3000\r\n`);

    expect(runner.stop("run-1")).toBe(true);
    expect(writes.at(-1)).toBe(String.fromCodePoint(3));
    emitOutput(`^C\r\n${done(130)}${PROMPT}`);

    await expect(result).resolves.toMatchObject({
      output: "ready on :3000\r\n^C\r\n",
      exitCode: 130,
      terminationReason: "user_stopped",
    });
    expect(runner.stop("run-1")).toBe(false);
  });

  it("gives up waiting for the prompt after Stop when the shell never reports one", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh", stopGraceMs: 500 });
    const result = runner.run(params());
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`git status\r\n${start()}working`);
    runner.stop("run-1");
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({
      output: "working",
      exitCode: null,
      terminationReason: "user_stopped",
    });
  });

  it("sends the command anyway when a new tab never shows a prompt mark", async () => {
    const runner = new TerminalBlockRunner(manager, {
      shellIntegration: "zsh",
      firstPromptTimeoutMs: 1_000,
    });
    void runner.run(params());
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["git status\r"]);
  });

  it("uses a second tab while the task's tab is busy", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    void runner.run(params());
    void runner.run(params({ runId: "run-2" }));
    expect(manager.listTabs("workspace-1")).toHaveLength(2);
  });

  it("keeps only the tail of very long output", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh", outputLimit: 10 });
    const result = runner.run(params());
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`git status\r\n${start()}0123456789abcdef`);
    emitOutput(`${done(0)}${PROMPT}`);
    await expect(result).resolves.toMatchObject({ output: "6789abcdef", truncated: true });
  });

  it("ignores marks without the tab's nonce, so output cannot end the run", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    const result = runner.run(params({ command: "cat notes.txt" }));
    emitOutput(`${done(0)}${PROMPT}`);
    const forged = `${ESC}]133;D;0${BEL}${ESC}]133;D;deadbeef;0${BEL}`;
    emitOutput(`cat notes.txt\r\n${start()}before${forged}after\r\n`);
    emitOutput(`${done(2)}${PROMPT}`);
    const finished = await result;
    expect(finished.exitCode).toBe(2);
    expect(finished.output).toBe(`before${forged}after\r\n`);
  });

  it("lets only the window that started a run stop it", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    void runner.run(params({ ownerId: "7" }));
    expect(runner.stop("run-1", "8")).toBe(false);
    expect(runner.stop("run-1")).toBe(false);
    expect(runner.stop("run-1", "7")).toBe(true);
  });

  it("interrupts a run that goes past the time limit", async () => {
    const runner = new TerminalBlockRunner(manager, {
      shellIntegration: "zsh",
      maxDurationMs: 5_000,
    });
    const result = runner.run(params({ command: "sleep 999" }));
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`sleep 999\r\n${start()}`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes.at(-1)).toBe(String.fromCodePoint(3));
    emitOutput(`^C\r\n${done(130)}${PROMPT}`);
    await expect(result).resolves.toMatchObject({ terminationReason: "timeout", exitCode: 130 });
  });

  it("does not reuse a tab whose command ignored Ctrl-C", async () => {
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh", stopGraceMs: 100 });
    const first = runner.run(params());
    emitOutput(`${done(0)}${PROMPT}`);
    emitOutput(`git status\r\n${start()}`);
    runner.stop("run-1");
    await vi.advanceTimersByTimeAsync(100);
    const stuckTab = (await first).tabId;
    void runner.run(params({ runId: "run-2" }));
    const tabs = manager.listTabs("workspace-1");
    expect(tabs).toHaveLength(2);
    expect(tabs[1].id).not.toBe(stuckTab);
  });

  it("refuses shells without integration marks and duplicate run ids", async () => {
    await expect(
      new TerminalBlockRunner(manager, { shellIntegration: "none" }).run(params()),
    ).rejects.toThrow(/zsh or bash/);
    const runner = new TerminalBlockRunner(manager, { shellIntegration: "zsh" });
    void runner.run(params());
    await expect(runner.run(params())).rejects.toThrow(/already running/);
  });
});

describe("toShellInput", () => {
  it("sends one line as is and groups several lines into one command", () => {
    expect(toShellInput("  git status  ", "zsh")).toEqual({ input: "git status", echoLines: 1 });
    expect(toShellInput("cd app\n\nnpm test\n", "bash")).toEqual({
      input: "{\ncd app\nnpm test\n}",
      echoLines: 4,
    });
  });

  it("pastes several lines or tabs into zsh so the line editor keeps them literal", () => {
    expect(toShellInput("cd app\nnpm test", "zsh")).toEqual({
      input: `${ESC}[200~cd app\nnpm test${ESC}[201~`,
      echoLines: 2,
    });
    expect(toShellInput("printf 'a\tb'", "zsh").input).toBe(`${ESC}[200~printf 'a\tb'${ESC}[201~`);
  });
});
