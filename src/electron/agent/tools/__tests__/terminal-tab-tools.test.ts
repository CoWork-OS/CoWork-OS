import { describe, expect, it, vi } from "vitest";
import type { ShellSessionInfo, Workspace } from "../../../../shared/types";
import { isToolAllowedQuick } from "../../../security/policy-manager";
import {
  redactTerminalText,
  TerminalTabTools,
  type TerminalTabSource,
} from "../terminal-tab-tools";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "CoWork",
    path: "/Users/almarion/code/cowork",
    createdAt: 0,
    permissions: { read: true, write: true, delete: false, network: false, shell: true },
    ...overrides,
  } as Workspace;
}

function shellTab(overrides: Partial<ShellSessionInfo> = {}): ShellSessionInfo {
  return {
    id: "tab:ws-1:tab-1",
    taskId: "tab-1",
    workspaceId: "ws-1",
    scope: "tab",
    cwd: "/Users/almarion/code/cowork",
    status: "active",
    retained: true,
    commandCount: 0,
    aliases: [],
    envKeys: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const NONCE = "5f0c1d2e3a4b5c6d7e8f9a0b";

/**
 * A terminal dock with the given tabs and the raw output each has buffered. Like
 * TerminalPtyManager, listTabs without a workspace id lists every workspace's tabs.
 */
function dock(
  tabs: ShellSessionInfo[],
  outputs: Record<string, string | { output: string; startOffset: number }> = {},
  codeBlockTabs: Record<string, string> = {},
): TerminalTabSource {
  return {
    listTabs: (workspaceId?: string) =>
      tabs.filter((tab) => !workspaceId || tab.workspaceId === workspaceId),
    getRecentOutput: (tabId: string) => {
      const entry = outputs[tabId] ?? "";
      return typeof entry === "string" ? { output: entry, startOffset: 0 } : entry;
    },
    getShellMarkNonce: () => NONCE,
    getCodeBlockTaskId: (tabId: string) => codeBlockTabs[tabId],
  };
}

/** A daemon whose user allows every request, under one unchanging task authority. */
function consentDaemon() {
  return {
    requestApproval: vi.fn(async () => true),
    getTaskConsentAuthority: vi.fn(async () => "authority-1"),
  };
}

function makeTools(
  ws: Workspace,
  source: TerminalTabSource,
  daemon: ReturnType<typeof consentDaemon> = consentDaemon(),
  taskId = "task-1",
): TerminalTabTools {
  return new TerminalTabTools(ws, daemon as Any, taskId, source);
}

/** read_terminal's output for a tab that printed `raw`. */
async function readOutput(raw: string, input: Record<string, unknown> = {}): Promise<string> {
  const tools = makeTools(workspace(), dock([shellTab()], { "tab:ws-1:tab-1": raw }));
  return (await tools.readTerminal({ tab_id: "tab:ws-1:tab-1", ...input })).output as string;
}

describe("list_terminal_tabs", () => {
  it("lists the workspace's shell tabs with a label, link and last command", () => {
    const tools = makeTools(
      workspace(),
      dock([
        shellTab({
          lastCommand: "npm test",
          lastCommandAt: 5,
          status: "running",
        }),
        shellTab({
          id: "tab:ws-1:tab-2",
          cwd: "/Users/almarion/code/cowork/web",
          // A tab opened with a title keeps it in lastCommand without running anything.
          lastCommand: "Code blocks",
        }),
        shellTab({ id: "tab:ws-2:tab-3", workspaceId: "ws-2", cwd: "/elsewhere" }),
      ]),
    );

    expect(tools.listTerminalTabs()).toEqual({
      success: true,
      tabs: [
        {
          id: "tab:ws-1:tab-1",
          label: "cowork",
          link: "[cowork](#terminal/tab%3Aws-1%3Atab-1)",
          cwd: "/Users/almarion/code/cowork",
          status: "running",
          last_command: "npm test",
        },
        {
          id: "tab:ws-1:tab-2",
          label: "web",
          link: "[web](#terminal/tab%3Aws-1%3Atab-2)",
          cwd: "/Users/almarion/code/cowork/web",
          status: "active",
        },
      ],
    });
  });

  it("shortens a long last command", () => {
    const tools = makeTools(
      workspace(),
      dock([shellTab({ lastCommand: `echo ${"x".repeat(1000)}`, lastCommandAt: 5 })]),
    );
    const [tab] = tools.listTerminalTabs().tabs as Array<Record<string, unknown>>;
    expect((tab.last_command as string).length).toBe(301);
    expect(tab.last_command).toMatch(/…$/);
  });

  it("lists nothing for a workspace without an id, never every workspace's tabs", async () => {
    const tools = makeTools(workspace({ id: "" }), dock([shellTab()], {}));
    expect(tools.listTerminalTabs().tabs).toEqual([]);
    await expect(tools.readTerminal({ tab_id: "tab:ws-1:tab-1" })).rejects.toThrow(
      /no terminal tab/,
    );
  });

  it("redacts secrets in the last command", () => {
    const tools = makeTools(
      workspace(),
      dock([
        shellTab({
          lastCommand: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list",
          lastCommandAt: 5,
        }),
      ]),
    );
    const [tab] = tools.listTerminalTabs().tabs as Array<Record<string, unknown>>;
    expect(tab.last_command).toBe("GITHUB_TOKEN=[REDACTED] gh pr list");
  });

  it("says when the user has no tabs open", () => {
    expect(makeTools(workspace(), dock([])).listTerminalTabs()).toEqual({
      success: true,
      tabs: [],
      message: "The user has no terminal tabs open in this workspace.",
    });
  });
});

describe("read_terminal", () => {
  const tabId = "tab:ws-1:tab-1";

  it("returns the tab's output as plain text", async () => {
    const raw = `${ESC}]7;file://host/Users/almarion/code/cowork${BEL}cowork % npm test\r\n${ESC}[31m1 failed${ESC}[0m\r\ncowork % `;
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: raw }));

    expect(await tools.readTerminal({ tab_id: tabId })).toEqual({
      success: true,
      id: tabId,
      label: "cowork",
      link: "[cowork](#terminal/tab%3Aws-1%3Atab-1)",
      cwd: "/Users/almarion/code/cowork",
      status: "active",
      output: "cowork % npm test\n1 failed\ncowork %",
      truncated: false,
    });
  });

  it("redacts secrets like run_command output and typed secret assignments", async () => {
    const raw = [
      "cowork % export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "cowork % export DB_PASSWORD='hunter2 hunter2'",
      'cowork % curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" api',
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "-----END PRIVATE KEY-----",
      "PATH=/usr/bin:/bin",
    ].join("\r\n");
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: raw }));

    const { output } = (await tools.readTerminal({ tab_id: tabId })) as { output: string };
    expect(output).not.toMatch(/sk-abc|hunter2|abcdefghijklmnopqrstuvwxyz0123|MIIEvQ/);
    expect(output).toContain("export OPENAI_API_KEY=[REDACTED]");
    expect(output).toContain("export DB_PASSWORD=[REDACTED]");
    expect(output).toContain("Authorization: Bearer [REDACTED]");
    expect(output).toContain("[REDACTED_PRIVATE_KEY]");
    expect(output).toContain("PATH=/usr/bin:/bin");
  });

  it.each([
    ["a bare secret name", "TOKEN=abc123def", "TOKEN=[REDACTED]"],
    ["a lower-case name", "password=hunter2", "password=[REDACTED]"],
    ["a flag", "mysql --password=hunter2 db", "mysql --password=[REDACTED] db"],
    [
      "spaces around =",
      "aws_secret_access_key = wJalrXUtnFEMI",
      "aws_secret_access_key = [REDACTED]",
    ],
    ["a YAML field", "  password: hunter2", "  password: [REDACTED]"],
    ["a header", "X-Api-Key: abc123", "X-Api-Key: [REDACTED]"],
    ["a _KEY name", "STRIPE_KEY=whsec_123", "STRIPE_KEY=[REDACTED]"],
    ["a _PWD name", "MYSQL_PWD=hunter2 mysql", "MYSQL_PWD=[REDACTED] mysql"],
    ["an escaped quote", 'API_TOKEN="a\\"b c"', "API_TOKEN=[REDACTED]"],
    [
      "a URL password",
      "postgres://app:hunter2@db:5432/app",
      "postgres://app:[REDACTED]@db:5432/app",
    ],
    ["basic auth", "Authorization: Basic YWxhZGRpbjpvcGVu", "Authorization: Basic [REDACTED]"],
    ["a short bearer token", "Authorization: Bearer abc", "Authorization: Bearer [REDACTED]"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "[REDACTED_SLACK_TOKEN]"],
    ["a Stripe key", "sk_live_abcdefghijklmnop1234", "[REDACTED_API_KEY]"],
    ["the tab's mark nonce", `COWORK_MARK=${NONCE}`, "COWORK_MARK=[REDACTED]"],
  ])("redacts %s", async (_name, line, expected) => {
    expect(await readOutput(`${line}\r\n`)).toBe(expected);
  });

  it.each([
    ["the working directory", "PWD=/Users/almarion/code"],
    ["a count of tokens", "tokens: 42"],
    ["an ordinary variable", "NODE_ENV=production npm start"],
  ])("leaves %s alone", async (_name, line) => {
    expect(await readOutput(`${line}\r\n`)).toBe(line);
  });

  it("hides a private key whose END line is not there yet", async () => {
    const output = await readOutput(
      "cowork % head -3 id_rsa\r\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\n",
    );
    expect(output).toBe("cowork % head -3 id_rsa\n[REDACTED_PRIVATE_KEY]");
  });

  it("hides the end of a private key whose BEGIN line dropped out", async () => {
    const tools = makeTools(
      workspace(),
      dock([shellTab()], {
        "tab:ws-1:tab-1": {
          output: "zz\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\n-----END OPENSSH PRIVATE KEY-----\r\nok\r\n",
          startOffset: 100,
        },
      }),
    );
    expect((await tools.readTerminal({ tab_id: "tab:ws-1:tab-1" })).output).toBe(
      "[REDACTED_PRIVATE_KEY]\nok",
    );
  });

  it("does not show text the user erased at the prompt or cleared away", async () => {
    const erased = `cowork % hunter2${"\b".repeat(7)}${ESC}[Kls\r\nREADME.md\r\n`;
    expect(await readOutput(erased)).toBe("cowork % ls\nREADME.md");
    const cleared = `cowork % cat notes\r\nprivate notes\r\ncowork % clear\r\n${ESC}[H${ESC}[2J${ESC}[3Jcowork % `;
    expect(await readOutput(cleared)).toBe("cowork %");
  });

  it("treats null and empty optional arguments as left out", async () => {
    const raw = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\r\n");
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: raw }));
    const result = await tools.readTerminal({ tab_id: tabId, tail_lines: null, max_chars: "" });
    expect((result.output as string).split("\n")).toHaveLength(200);
    await expect(tools.readTerminal(null)).rejects.toThrow(/needs tab_id/);
  });

  it("keeps the last redraw of one long line once older output was dropped", async () => {
    const tools = makeTools(
      workspace(),
      dock([shellTab()], {
        [tabId]: { output: "ownloading  40%\rDownloading  80%", startOffset: 300_000 },
      }),
    );
    expect((await tools.readTerminal({ tab_id: tabId })).output).toBe("Downloading  80%");
    const noRedraw = makeTools(
      workspace(),
      dock([shellTab()], { [tabId]: { output: "x".repeat(50), startOffset: 300_000 } }),
    );
    expect(await noRedraw.readTerminal({ tab_id: tabId })).toMatchObject({
      output: "",
      message: "The tab has no complete line of recent output to show.",
    });
  });

  it("keeps the last lines and the end of long output", async () => {
    const raw = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\r\n");
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: raw }));

    expect(await tools.readTerminal({ tab_id: tabId, tail_lines: 3 })).toMatchObject({
      output: "line 198\nline 199\nline 200",
      truncated: true,
    });
    const long = await tools.readTerminal({ tab_id: tabId, tail_lines: 2000, max_chars: 1 });
    // max_chars has a floor, and the cut starts at a whole line.
    expect(long.output).toMatch(/^line \d+\n[\s\S]*line 200$/);
    expect((long.output as string).length).toBeLessThanOrEqual(500);
    expect(long.truncated).toBe(true);
  });

  it("drops the cut-off first line once older output was dropped", async () => {
    const tools = makeTools(
      workspace(),
      dock([shellTab()], {
        [tabId]: { output: "ijklmnopqrstuvwxyz0123456789\r\ndone\r\n", startOffset: 4096 },
      }),
    );
    expect(await tools.readTerminal({ tab_id: tabId })).toMatchObject({
      output: "done",
      truncated: true,
    });
  });

  it("accepts the tab's link or its encoded id", async () => {
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: "ok\r\n" }));
    expect((await tools.readTerminal({ tab_id: "#terminal/tab%3Aws-1%3Atab-1" })).output).toBe(
      "ok",
    );
    expect((await tools.readTerminal({ tab_id: "tab%3Aws-1%3Atab-1" })).output).toBe("ok");
  });

  it("says when the tab printed nothing", async () => {
    const tools = makeTools(workspace(), dock([shellTab()]));
    expect(await tools.readTerminal({ tab_id: tabId })).toMatchObject({
      output: "",
      truncated: false,
      message: "The tab has printed nothing yet.",
    });
  });

  it("refuses tabs that are missing or belong to another workspace", async () => {
    const tools = makeTools(
      workspace(),
      dock([shellTab({ id: "tab:ws-2:tab-9", workspaceId: "ws-2" })], {
        "tab:ws-2:tab-9": "other workspace secret plans",
      }),
    );
    await expect(tools.readTerminal({})).rejects.toThrow(/needs tab_id/);
    await expect(tools.readTerminal({ tab_id: "tab:ws-2:tab-9" })).rejects.toThrow(
      /no terminal tab tab:ws-2:tab-9 in this workspace/,
    );
    await expect(tools.readTerminal({ tab_id: "tab:ws-1:closed" })).rejects.toThrow(
      /list_terminal_tabs/,
    );
  });
});

describe("read_terminal consent", () => {
  const tabId = "tab:ws-1:tab-1";
  const otherTabId = "tab:ws-1:tab-2";
  const twoTabs = () => [
    shellTab(),
    shellTab({ id: otherTabId, cwd: "/Users/almarion/code/cowork/web" }),
  ];

  it("asks once per tab for the task, naming the tab", async () => {
    const daemon = consentDaemon();
    const tools = makeTools(
      workspace(),
      dock(twoTabs(), { [tabId]: "one\r\n", [otherTabId]: "two\r\n" }),
      daemon,
    );

    expect((await tools.readTerminal({ tab_id: tabId })).output).toBe("one");
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      "task-1",
      "data_export",
      'Let the agent read the recent output of your terminal tab "cowork" (/Users/almarion/code/cowork)?',
      expect.objectContaining({
        tool: "read_terminal",
        params: { tab_id: tabId },
        taskConsentLabel: "Allow for this task",
        taskConsentScope:
          'reading the recent output of your terminal tab "cowork" (/Users/almarion/code/cowork)',
      }),
      expect.objectContaining({ allowAutoApprove: false, requireExplicitApproval: true }),
    );

    await tools.readTerminal({ tab_id: tabId, tail_lines: 5 });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);

    expect((await tools.readTerminal({ tab_id: otherTabId })).output).toBe("two");
    expect(daemon.requestApproval).toHaveBeenCalledTimes(2);
    expect(daemon.requestApproval.mock.calls[1][2]).toContain('tab "web"');
  });

  it("returns no output when the user does not allow it, and asks again next time", async () => {
    const daemon = consentDaemon();
    daemon.requestApproval.mockResolvedValueOnce(false);
    const source = dock([shellTab()], { [tabId]: "secret stuff\r\n" });
    const getRecentOutput = vi.spyOn(source, "getRecentOutput");
    const tools = makeTools(workspace(), source, daemon);

    await expect(tools.readTerminal({ tab_id: tabId })).rejects.toThrow(
      'The user did not allow reading terminal tab "cowork", so its output was not read.',
    );
    expect(getRecentOutput).not.toHaveBeenCalled();

    expect((await tools.readTerminal({ tab_id: tabId })).output).toBe("secret stuff");
    expect(daemon.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("does not ask for a tab this task's code block run opened", async () => {
    const daemon = consentDaemon();
    const tools = makeTools(
      workspace(),
      dock(
        twoTabs(),
        { [tabId]: "ran\r\n", [otherTabId]: "other\r\n" },
        {
          [tabId]: "task-1",
          [otherTabId]: "task-2",
        },
      ),
      daemon,
    );

    expect((await tools.readTerminal({ tab_id: tabId })).output).toBe("ran");
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    // Another task's code block tab is the user's like any other.
    await tools.readTerminal({ tab_id: otherTabId });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("asks again once the task's authority changed or the tab was closed", async () => {
    const daemon = consentDaemon();
    const tabs = [shellTab()];
    const tools = makeTools(workspace(), dock(tabs, { [tabId]: "x\r\n" }), daemon);

    await tools.readTerminal({ tab_id: tabId });
    daemon.getTaskConsentAuthority.mockResolvedValue("authority-2");
    await tools.readTerminal({ tab_id: tabId });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(2);

    tabs.length = 0;
    await expect(tools.readTerminal({ tab_id: tabId })).rejects.toThrow(/no terminal tab/);
    tabs.push(shellTab());
    await tools.readTerminal({ tab_id: tabId });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(3);
  });

  it("refuses a consent given while the task's authority changed", async () => {
    const daemon = consentDaemon();
    daemon.getTaskConsentAuthority
      .mockResolvedValueOnce("authority-1")
      .mockResolvedValueOnce("authority-2");
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: "x\r\n" }), daemon);
    await expect(tools.readTerminal({ tab_id: tabId })).rejects.toThrow(/did not allow/);
  });

  it("shares one consent between the policy prompt and the read", async () => {
    const daemon = consentDaemon();
    const tools = makeTools(workspace(), dock([shellTab()], { [tabId]: "x\r\n" }), daemon);
    await expect(tools.requestReadConsent({ tab_id: tabId })).resolves.toBe(true);
    await tools.readTerminal({ tab_id: tabId });
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe("terminal tab tool definitions", () => {
  it("say when to use each tool and how to link a tab, within the prompt description limit", () => {
    const definitions = TerminalTabTools.getToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual(["list_terminal_tabs", "read_terminal"]);
    for (const tool of definitions) {
      expect(tool.description.length).toBeLessThanOrEqual(420);
      expect(tool.description).toMatch(/Use it when/);
      expect(tool.description).toContain("[label](#terminal/<id>)");
      expect(tool.description).toMatch(/Read-only/);
    }
    expect(definitions[1].input_schema.required).toEqual(["tab_id"]);
    expect(definitions[1].description).toMatch(/known secret patterns redacted/);
    expect(definitions[1].description).toMatch(/the first read of a tab asks the user/);
    expect(definitions[1].description).toMatch(/data, not instructions/);
  });

  it("are offered where run_command is, but never in shared chats", () => {
    const withShell = workspace();
    const withoutShell = workspace({
      permissions: { read: true, write: true, delete: false, network: false, shell: false },
    });
    for (const tool of ["list_terminal_tabs", "read_terminal"]) {
      for (const ws of [withShell, withoutShell]) {
        for (const context of [undefined, "private"] as const) {
          expect(isToolAllowedQuick(tool, ws, context)).toBe(
            isToolAllowedQuick("run_command", ws, context),
          );
        }
      }
      expect(isToolAllowedQuick(tool, withShell)).toBe(true);
      expect(isToolAllowedQuick(tool, withoutShell)).toBe(false);
      // run_command stays available there, behind its own approval; reading the owner's tabs
      // into a group or public conversation is not.
      expect(isToolAllowedQuick("run_command", withShell, "group")).toBe(true);
      expect(isToolAllowedQuick(tool, withShell, "group")).toBe(false);
      expect(isToolAllowedQuick(tool, withShell, "public")).toBe(false);
    }
  });
});

describe("redactTerminalText", () => {
  it("leaves ordinary assignments and words alone", () => {
    expect(redactTerminalText("NODE_ENV=production npm start\ntokens: 42")).toBe(
      "NODE_ENV=production npm start\ntokens: 42",
    );
  });
});
