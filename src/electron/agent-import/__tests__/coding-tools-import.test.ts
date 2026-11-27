/**
 * Importing from Claude Code and Cursor: the readers against homes written at runtime
 * (fake data only), the preview never holding a credential, and the applier's checks for
 * response guidance and MCP servers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentImportSource } from "../../../cli/agent-import-command";
import { applyImportPlan, type AgentImportTargets } from "../apply";
import {
  claudeCodeProjectKey,
  readClaudeCodeHome,
  resolveClaudeCodeHome,
} from "../claude-code-reader";
import { cursorStateDbPath, readCursorHome } from "../cursor-reader";
import { detectAgentImports } from "../index";
import { looksLikeSecret, readMcpServers } from "../mcp-config";
import { toPreview, type PlannedImportItem } from "../plan";
import { shellRuleItems } from "../coding-tool-items";
import { commandPrefixFromShellRule } from "../source-files";
import { mcpServerExists } from "../targets";

// Fake credentials only.
const BEARER = "Bearer fixture-remote-token-0001";
const ENV_KEY = "fixture-env-api-key-0002";
const ARG_KEY = "fixtureArgKey0003abcdefghijkl";
const URL_KEY = "zapFixture0004abcdefghijklmn";
const ANTHROPIC_KEY = "sk-ant-fixture-0005";
const SECRETS = [BEARER, ENV_KEY, ARG_KEY, URL_KEY, ANTHROPIC_KEY];

let base: string;

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir: string, name: string, description: string) {
  write(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

const MCP_SERVERS = {
  files: { command: "npx", args: ["-y", "@fixture/files-server", "/tmp"] },
  remote: { type: "http", url: "https://mcp.fixture.test/mcp", headers: { Authorization: BEARER } },
  keyed: { command: "node", args: ["server.js"], env: { FIXTURE_API_KEY: ENV_KEY, MODE: "dev" } },
  flagged: { command: "fixture-mcp", args: ["--api-key", ARG_KEY] },
  pathkey: { type: "sse", url: `https://actions.fixture.test/mcp/${URL_KEY}/sse` },
  templated: { url: "https://mcp.fixture.test/${TEAM}" },
  embedded: { type: "sdk" },
  off: { command: "npx", args: ["off-server"], disabled: true },
};

function byId(items: readonly PlannedImportItem[]) {
  return new Map(items.map((item) => [item.id, item]));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-coding-import-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function claudeHome(): { home: string; workspace: string } {
  const home = path.join(base, ".claude");
  const workspace = path.join(base, "work", "garden.app");
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(home, "CLAUDE.md"), "Answer briefly. Prefer pnpm.\n");
  skill(path.join(home, "skills", "release-notes"), "release-notes", "Write release notes");
  fs.mkdirSync(path.join(base, "elsewhere", "linked-skill"), { recursive: true });
  fs.symlinkSync(path.join(base, "elsewhere", "linked-skill"), path.join(home, "skills", "linked"));
  write(
    path.join(base, ".claude.json"),
    JSON.stringify({ numStartups: 3, mcpServers: MCP_SERVERS }),
  );
  write(
    path.join(home, "settings.json"),
    JSON.stringify({
      permissions: {
        allow: [
          "Bash(npm run test:*)",
          "Bash(git status)",
          "Bash(npm run test *)",
          "Bash(python3 -m pytest:*)",
          "Bash(npx:*)",
          "Bash(git log | head)",
          "Bash(git push*origin)",
          "Bash",
          "Read(**)",
          "WebFetch(domain:example.com)",
        ],
        deny: ["Bash(curl:*)"],
      },
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OTHER: "x" },
    }),
  );
  const memory = path.join(home, "projects", claudeCodeProjectKey(workspace), "memory");
  write(path.join(memory, "MEMORY.md"), "- [Index](a.md)\n");
  write(
    path.join(memory, "prefers-tabs.md"),
    "---\nname: prefers-tabs\ndescription: Uses tabs\n---\n\nThe user indents with tabs.\n",
  );
  write(path.join(memory, "empty.md"), "---\nname: empty\n---\n");
  return { home, workspace };
}

describe("Claude Code reader", () => {
  it("finds the home in ~/.claude or CLAUDE_CONFIG_DIR, and names projects like Claude Code", () => {
    expect(resolveClaudeCodeHome({ env: {}, homedir: base })).toBe(path.join(base, ".claude"));
    expect(resolveClaudeCodeHome({ env: { CLAUDE_CONFIG_DIR: "/x/conf" }, homedir: base })).toBe(
      "/x/conf",
    );
    expect(claudeCodeProjectKey("/Users/sam/Code/my_app/.claude/worktrees/a")).toBe(
      "-Users-sam-Code-my-app--claude-worktrees-a",
    );
  });

  it("reads instructions, skills, MCP servers, command rules and memory without credentials", () => {
    const { home, workspace } = claudeHome();
    const plan = readClaudeCodeHome(home, {
      withSecrets: false,
      env: {},
      homedir: base,
      workspacePath: workspace,
    });
    expect(plan.found).toBe(true);
    const items = byId(plan.items);

    expect(items.get("instructions:global")).toMatchObject({
      status: "ready",
      category: "custom_instructions",
      payload: { kind: "custom_instructions", text: "Answer briefly. Prefer pnpm." },
    });
    expect(items.get("skill:release-notes")?.status).toBe("ready");
    expect(items.get("skill:linked")).toMatchObject({
      status: "skipped",
      label: expect.stringContaining("1 linked skill"),
    });

    expect(items.get("mcp:files")).toMatchObject({
      status: "ready",
      secret: false,
      detail: "npx @fixture/files-server /tmp",
      payload: { kind: "mcp_server", server: { transport: "stdio", command: "npx" } },
    });
    for (const id of ["mcp:remote", "mcp:keyed", "mcp:flagged", "mcp:pathkey"]) {
      expect(items.get(id)).toMatchObject({ status: "skipped", secret: true });
    }
    expect(items.get("mcp:templated")?.reason).toMatch(/placeholders/);
    expect(items.get("mcp:embedded")?.reason).toMatch(/sdk server CoWork can't run/);
    expect(items.get("mcp:off")?.reason).toMatch(/Turned off in Claude Code/);

    const rules = plan.items.filter((item) => item.category === "command_rule");
    expect(rules.filter((item) => item.status === "ready").map((item) => item.payload)).toEqual([
      { kind: "command_rule", prefix: "npm run test" },
      { kind: "command_rule", prefix: "git status" },
    ]);
    const reasons = Object.fromEntries(
      rules.filter((item) => item.status === "skipped").map((item) => [item.label, item.reason]),
    );
    expect(reasons["Always allow: python3 -m pytest:*"]).toMatch(/python3 can run any command/);
    expect(reasons["Always allow: npx:*"]).toMatch(/npx can run any command/);
    expect(reasons["Always allow: git log | head"]).toBe("Not a plain command.");
    expect(reasons["Always allow: git push*origin"]).toMatch(/Wildcard/);
    expect(reasons["Always allow: every command"]).toMatch(/every command/);
    expect(rules.some((item) => item.label.includes("curl"))).toBe(false);

    expect(items.get("key:anthropic")).toMatchObject({ status: "skipped", secret: true });
    expect(items.get("memory:project")).toMatchObject({
      status: "ready",
      payload: {
        kind: "memory_inbox",
        entries: [{ text: "The user indents with tabs.", added: expect.any(String) }],
      },
    });

    expect(JSON.stringify(plan)).not.toContain(ANTHROPIC_KEY);
    const preview = JSON.stringify(toPreview(plan));
    for (const secret of SECRETS) expect(preview).not.toContain(secret);
  });

  it("brings credentials over only when opted in, and still never shows them", () => {
    const { home } = claudeHome();
    const plan = readClaudeCodeHome(home, { withSecrets: true, env: {}, homedir: base });
    const items = byId(plan.items);
    for (const id of ["mcp:remote", "mcp:keyed", "mcp:flagged", "mcp:pathkey", "key:anthropic"]) {
      expect(items.get(id)).toMatchObject({ status: "ready", secret: true });
    }
    expect(items.get("mcp:remote")?.payload).toMatchObject({
      server: { transport: "streamable-http", headers: { Authorization: BEARER } },
    });
    expect(items.get("mcp:pathkey")?.payload).toMatchObject({ server: { transport: "sse" } });
    expect(items.get("mcp:flagged")?.detail).toBe("fixture-mcp");
    expect(items.get("mcp:pathkey")?.detail).toBe("https://actions.fixture.test");
    expect(items.has("memory:project")).toBe(false);
    const preview = JSON.stringify(toPreview(plan));
    for (const secret of SECRETS) expect(preview).not.toContain(secret);
  });

  it("reads ~/.claude.json from inside CLAUDE_CONFIG_DIR when it is set", () => {
    const home = path.join(base, "conf");
    write(path.join(home, "settings.json"), "{}");
    write(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { files: MCP_SERVERS.files } }),
    );
    const plan = readClaudeCodeHome(home, {
      withSecrets: false,
      env: { CLAUDE_CONFIG_DIR: home },
      homedir: base,
    });
    expect(plan.items.map((item) => item.id)).toEqual(["mcp:files"]);
  });
});

describe("Cursor reader", () => {
  function cursorHome(): { home: string; workspace: string } {
    const home = path.join(base, ".cursor");
    const workspace = path.join(base, "repo");
    write(
      path.join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { files: MCP_SERVERS.files, remote: MCP_SERVERS.remote } }),
    );
    skill(path.join(home, "skills", "triage"), "triage", "Triage issues");
    skill(path.join(home, "skills-cursor", "builtin"), "builtin", "Ships with Cursor");
    write(
      path.join(home, "cli-config.json"),
      JSON.stringify({ permissions: { allow: ["Shell(git)", "Shell(bash)", "Read(**)"] } }),
    );
    write(path.join(workspace, ".cursorrules"), "Use strict TypeScript.\n");
    write(
      path.join(workspace, ".cursor", "rules", "style.mdc"),
      "---\ndescription: Style\nalwaysApply: true\n---\n\nTwo-space indent.\n",
    );
    write(path.join(workspace, ".cursor", "rules", "nested", "plain.md"), "No default exports.\n");
    write(
      path.join(workspace, ".cursor", "rules", "tests.mdc"),
      '---\nglobs: "**/*.test.ts"\nalwaysApply: false\n---\n\nUse vitest.\n',
    );
    return { home, workspace };
  }

  it("reads User Rules, skills, MCP servers, shell rules and always-on project rules", () => {
    const { home, workspace } = cursorHome();
    const plan = readCursorHome(home, {
      withSecrets: false,
      homedir: base,
      platform: "darwin",
      workspacePath: workspace,
      userRules: "Reply in British English.",
    });
    expect(cursorStateDbPath({ homedir: base, platform: "darwin" })).toBe(
      path.join(
        base,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    );
    const items = byId(plan.items);
    expect(items.get("instructions:global")).toMatchObject({
      label: "User Rules",
      payload: { kind: "custom_instructions", text: "Reply in British English." },
    });
    expect(items.get("skill:triage")?.status).toBe("ready");
    expect(items.has("skill:builtin")).toBe(false);
    expect(items.get("mcp:files")?.status).toBe("ready");
    expect(items.get("mcp:remote")).toMatchObject({ status: "skipped", secret: true });
    expect(items.get("command:Shell(git)")?.payload).toEqual({
      kind: "command_rule",
      prefix: "git",
    });
    expect(items.get("command:Shell(bash)")?.reason).toMatch(/bash can run any command/);

    const rules = items.get("instructions:workspace");
    expect(rules?.status).toBe("ready");
    expect(rules?.payload).toEqual({
      kind: "workspace_instructions",
      text: [
        "### .cursorrules\n\nUse strict TypeScript.",
        `### ${path.join(".cursor", "rules", "nested", "plain.md")}\n\nNo default exports.`,
        `### ${path.join(".cursor", "rules", "style.mdc")}\n\nTwo-space indent.`,
      ].join("\n\n"),
    });
    expect(items.get("instructions:scoped")).toMatchObject({
      status: "skipped",
      label: "1 project rule for matching files or on request",
    });
    expect(JSON.stringify(toPreview(plan))).not.toContain(BEARER);
  });

  it("never follows a linked .cursorrules out of the workspace", () => {
    const workspace = path.join(base, "cloned");
    write(path.join(base, "private.txt"), "PRIVATE-NOTES");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(base, "private.txt"), path.join(workspace, ".cursorrules"));
    write(path.join(base, ".cursor", "mcp.json"), "{}");
    const plan = readCursorHome(path.join(base, ".cursor"), {
      withSecrets: false,
      homedir: base,
      platform: "darwin",
      workspacePath: workspace,
      userRules: null,
    });
    expect(JSON.stringify(plan)).not.toContain("PRIVATE-NOTES");
  });

  it("finds Cursor's state database on each platform and detects both tools", () => {
    expect(cursorStateDbPath({ homedir: "/h", platform: "linux", env: {} })).toBe(
      path.join("/h", ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
    expect(
      cursorStateDbPath({ homedir: "/h", platform: "win32", env: { APPDATA: "/h/roam" } }),
    ).toBe(path.join("/h/roam", "Cursor", "User", "globalStorage", "state.vscdb"));
    claudeHome();
    write(cursorStateDbPath({ homedir: base, platform: "darwin" }), "");
    const found = detectAgentImports({ env: {}, homedir: base, platform: "darwin" });
    expect(found.filter((entry) => entry.found).map((entry) => entry.source)).toEqual([
      "claude-code",
      "cursor",
    ]);
  });
});

describe("shell allow rules", () => {
  it("keeps exact commands and plain prefixes, and gates the rest", () => {
    expect(commandPrefixFromShellRule("npm run build:*")).toEqual({ prefix: "npm run build" });
    expect(commandPrefixFromShellRule("  git   diff  ")).toEqual({ prefix: "git diff" });
    expect(commandPrefixFromShellRule("ls*")).toEqual({ prefix: "ls" });
    expect(commandPrefixFromShellRule("npx tsc:*")).toEqual({ prefix: "npx tsc" });
    for (const rule of [
      "",
      "*",
      "echo $HOME",
      "a && b",
      "FOO=1 make",
      "cat `x`",
      "sudo ls",
      "npx -y cowsay",
      "npx",
      "python3 x.py",
    ]) {
      expect(commandPrefixFromShellRule(rule)).toHaveProperty("reason");
    }
  });
});

describe("rule labels", () => {
  it("hide quoted text and token-looking words", () => {
    const [item] = shellRuleItems(
      [`Bash(curl -H "Authorization: Bearer abc" https://x.test/${ARG_KEY}:*)`],
      "Bash",
    );
    expect(item.label).not.toContain("Bearer abc");
    expect(item.label).not.toContain(ARG_KEY);
    expect(item.status).toBe("skipped");
  });
});

describe("MCP servers", () => {
  it("spots token-shaped values without flagging package names or paths", () => {
    expect(looksLikeSecret("sk-proj-abc")).toBe(true);
    expect(looksLikeSecret("ghp_abc")).toBe(true);
    expect(looksLikeSecret(ARG_KEY)).toBe(true);
    expect(looksLikeSecret("@modelcontextprotocol/server-filesystem")).toBe(false);
    expect(looksLikeSecret("/Users/sam/projects/my-long-project-name-2024")).toBe(false);
  });

  it("matches an existing server by name, command line or address", () => {
    const existing = [
      { name: "Files", command: "npx", args: ["-y", "@fixture/files-server", "/tmp"] },
      { name: "Docs", url: "https://docs.fixture.test/mcp/" },
    ];
    const server = (extra: object) => ({ name: "new", transport: "stdio" as const, ...extra });
    expect(mcpServerExists(existing, server({ name: "files" }))).toBe(true);
    expect(
      mcpServerExists(
        existing,
        server({ command: "npx", args: ["-y", "@fixture/files-server", "/tmp"] }),
      ),
    ).toBe(true);
    expect(mcpServerExists(existing, server({ url: "https://docs.fixture.test/mcp" }))).toBe(true);
    expect(mcpServerExists(existing, server({ command: "npx", args: ["other"] }))).toBe(false);
  });

  it("holds back env credentials whatever their name, and keeps plain settings", () => {
    const items = byId(
      readMcpServers(
        {
          pat: { command: "gh-mcp", env: { GITHUB_PAT: "short" } },
          db: { command: "pg-mcp", env: { DATABASE_URL: "postgres://u:pw@db.local/app" } },
          plain: {
            command: "plain-mcp",
            env: { PATH: "/usr/bin", MODE: "dev", AUTHOR_NAME: "Sam" },
          },
          pass: { command: "mysql-mcp", args: ["-pHunter2", "app"] },
        },
        { withSecrets: false, sourceLabel: "Cursor" },
      ),
    );
    expect(items.get("mcp:pat")).toMatchObject({ status: "skipped", secret: true });
    expect(items.get("mcp:db")).toMatchObject({ status: "skipped", secret: true });
    expect(items.get("mcp:plain")).toMatchObject({ status: "ready", secret: false });
    expect(items.get("mcp:pass")?.detail).toBe("mysql-mcp app");
  });

  it("skips an address that isn't http(s)", () => {
    const [item] = readMcpServers(
      { odd: { url: "file:///etc/passwd" } },
      { withSecrets: true, sourceLabel: "Cursor" },
    );
    expect(item).toMatchObject({ status: "skipped", reason: "Not an http or https address." });
  });
});

describe("applying Claude Code and Cursor items", () => {
  function targets(existingGuidance = "", hasServer = false) {
    const calls: Array<[string, ...unknown[]]> = [];
    const fake = {
      workspace: null,
      customInstructions: {
        existing: () => existingGuidance,
        save: (text: string) => calls.push(["guidance", text]),
      },
      mcpServers: {
        exists: () => hasServer,
        add: async (server: { name: string }, source: string) => {
          calls.push(["mcp", server.name, source]);
          return {
            ok: true as const,
            note: "Added switched off; turn it on in Settings > MCP Servers.",
          };
        },
      },
      commandRules: { has: () => false, add: (prefix: string) => calls.push(["command", prefix]) },
      skills: { install: async () => ({ ok: true as const }) },
      memory: {
        available: () => true,
        remember: async () => ({ ok: true as const }),
        importToInbox: async (entries: unknown[]) => ({
          imported: entries.length,
          duplicates: 0,
          skipped: 0,
        }),
      },
      providers: {
        hasKey: () => false,
        saveKey: () => {},
        active: () => ({ provider: "anthropic", configured: true }),
        selectModel: () => {},
      },
    } as unknown as AgentImportTargets;
    return { targets: fake, calls };
  }

  it("writes response guidance and adds servers switched off, after a dry run that writes nothing", async () => {
    const { home } = claudeHome();
    const plan = readClaudeCodeHome(home, { withSecrets: false, env: {}, homedir: base });
    const dry = targets();
    const preview = await applyImportPlan(plan, dry.targets, { dryRun: true });
    expect(dry.calls).toEqual([]);
    expect(preview.items.find((item) => item.id === "mcp:files")?.status).toBe("ready");

    const real = targets();
    const result = await applyImportPlan(plan, real.targets, { dryRun: false });
    expect(real.calls).toContainEqual(["guidance", "Answer briefly. Prefer pnpm."]);
    expect(real.calls).toContainEqual(["mcp", "files", "claude-code"]);
    expect(result.items.find((item) => item.id === "mcp:files")?.reason).toMatch(/switched off/);
  });

  it("leaves existing response guidance and servers alone", async () => {
    const { home } = claudeHome();
    const plan = readClaudeCodeHome(home, { withSecrets: false, env: {}, homedir: base });
    const kept = targets("Be terse.", true);
    const result = await applyImportPlan(plan, kept.targets, { dryRun: false });
    expect(kept.calls.filter(([kind]) => kind === "guidance" || kind === "mcp")).toEqual([]);
    expect(result.items.find((item) => item.id === "instructions:global")?.reason).toMatch(
      /already has response guidance/,
    );
    expect(result.items.find((item) => item.id === "mcp:files")?.reason).toBe(
      "CoWork already has this server.",
    );

    const same = targets("Answer briefly. Prefer pnpm.");
    const again = await applyImportPlan(plan, same.targets, { dryRun: false });
    expect(again.items.find((item) => item.id === "instructions:global")?.reason).toBe(
      "Already imported.",
    );
  });
});

describe("CLI source names", () => {
  it("accepts the new sources and common spellings", () => {
    expect(parseAgentImportSource("cursor")).toBe("cursor");
    expect(parseAgentImportSource("Claude-Code")).toBe("claude-code");
    expect(parseAgentImportSource("claude")).toBe("claude-code");
    expect(parseAgentImportSource("vscode")).toBeNull();
  });
});
