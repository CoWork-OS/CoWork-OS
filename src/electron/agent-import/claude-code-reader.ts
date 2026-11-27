/**
 * Read a Claude Code home (`~/.claude`, or CLAUDE_CONFIG_DIR) into an import plan. Reads
 * only.
 *
 * - `CLAUDE.md` → Response guidance (a workspace's own CLAUDE.md is already read by CoWork)
 * - `skills/` → skills
 * - `mcpServers` in `~/.claude.json` (user scope) → MCP servers, added switched off
 * - `permissions.allow` `Bash(...)` rules in `settings.json` → command rules
 * - provider keys in `settings.json` `env` → provider keys (credentials opt-in)
 * - the chosen workspace's auto-memory (`projects/<path>/memory/`) → the memory inbox
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { customInstructionsItem, shellRuleItems, skillFolderItems } from "./coding-tool-items";
import type { ReadSourceOptions } from "./hermes-reader";
import { readMcpServers } from "./mcp-config";
import { readyItem, secretItem, type ImportPlan } from "./plan";
import {
  isDirectory,
  isFile,
  PROVIDER_KEY_ENV,
  readJsonObjectIfExists,
  readTextIfExists,
  splitFrontmatter,
} from "./source-files";

const MAX_MEMORY_NOTES = 300;

export interface ClaudeCodeHomeOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** CLAUDE_CONFIG_DIR, else `~/.claude`. */
export function resolveClaudeCodeHome(options: ClaudeCodeHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(options.homedir ?? os.homedir(), ".claude");
}

/**
 * `~/.claude.json` sits next to the home folder by default; with CLAUDE_CONFIG_DIR set it
 * moves inside it.
 */
export function claudeCodeUserConfigPath(
  home: string,
  options: ClaudeCodeHomeOptions = {},
): string {
  const env = options.env ?? process.env;
  return env.CLAUDE_CONFIG_DIR?.trim()
    ? path.join(home, ".claude.json")
    : path.join(options.homedir ?? os.homedir(), ".claude.json");
}

export function claudeCodeHomeExists(home: string): boolean {
  return (
    isDirectory(home) &&
    (isFile(path.join(home, "settings.json")) ||
      isFile(path.join(home, "CLAUDE.md")) ||
      isDirectory(path.join(home, "skills")) ||
      isDirectory(path.join(home, "projects")))
  );
}

/** How Claude Code names a project's folder under `projects/`: every non-alphanumeric → `-`. */
export function claudeCodeProjectKey(workspacePath: string): string {
  return path.resolve(workspacePath).replace(/[^A-Za-z0-9]/g, "-");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Claude Code's auto-memory notes for one workspace, one inbox entry per file. */
function readProjectMemory(
  home: string,
  workspacePath: string,
): Array<{ text: string; added?: string }> {
  const dir = path.join(home, "projects", claudeCodeProjectKey(workspacePath), "memory");
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".md") && name !== "MEMORY.md")
      .sort();
  } catch {
    return [];
  }
  const notes: Array<{ text: string; added?: string }> = [];
  for (const name of names) {
    if (notes.length >= MAX_MEMORY_NOTES) break;
    const raw = readTextIfExists(path.join(dir, name));
    if (!raw) continue;
    const { data, body } = splitFrontmatter(raw);
    const description = typeof data.description === "string" ? data.description.trim() : "";
    const text = body.trim() || description;
    if (!text) continue;
    let added: string | undefined;
    try {
      added = fs.statSync(path.join(dir, name)).mtime.toISOString().slice(0, 10);
    } catch {
      added = undefined;
    }
    notes.push({ text, ...(added ? { added } : {}) });
  }
  return notes;
}

export function readClaudeCodeHome(
  home: string,
  options: ReadSourceOptions & ClaudeCodeHomeOptions & { workspacePath?: string },
): ImportPlan {
  const plan: ImportPlan = {
    source: "claude-code",
    home,
    found: claudeCodeHomeExists(home),
    withSecrets: options.withSecrets,
    items: [],
  };
  if (!plan.found) return plan;
  const items = plan.items;

  const instructions = customInstructionsItem(
    "instructions:global",
    "Your instructions (CLAUDE.md)",
    readTextIfExists(path.join(home, "CLAUDE.md")),
  );
  if (instructions) items.push(instructions);

  items.push(...skillFolderItems([path.join(home, "skills")], "~/.claude/skills"));

  const userConfig = readJsonObjectIfExists(claudeCodeUserConfigPath(home, options));
  items.push(
    ...readMcpServers(userConfig?.mcpServers, {
      withSecrets: options.withSecrets,
      sourceLabel: "Claude Code",
    }),
  );

  const settings = readJsonObjectIfExists(path.join(home, "settings.json")) ?? {};
  items.push(...shellRuleItems(asRecord(settings.permissions).allow, "Bash"));

  const env = asRecord(settings.env);
  const providersSeen = new Set<string>();
  for (const { env: name, provider } of PROVIDER_KEY_ENV) {
    const value = typeof env[name] === "string" ? (env[name] as string).trim() : "";
    if (!value || providersSeen.has(provider)) continue;
    providersSeen.add(provider);
    items.push(
      secretItem(
        options.withSecrets,
        `key:${provider}`,
        "provider_key",
        `${name} (settings.json)`,
        () => ({ kind: "provider_key", provider, value }),
      ),
    );
  }

  if (options.workspacePath) {
    const notes = readProjectMemory(home, options.workspacePath);
    if (notes.length > 0) {
      items.push(
        readyItem(
          "memory:project",
          "memory",
          "Claude Code memory for this workspace",
          { kind: "memory_inbox", label: "Claude Code memory", entries: notes },
          {
            detail: `${notes.length} ${notes.length === 1 ? "note" : "notes"} to review in the memory inbox`,
          },
        ),
      );
    }
  }
  return plan;
}
