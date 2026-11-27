/**
 * Read a Cursor home (`~/.cursor`) and Cursor's User Rules into an import plan. Reads only.
 *
 * - User Rules (Cursor Settings > Rules, kept in Cursor's app state) → Response guidance
 * - `skills/` → skills (`skills-cursor/` ships with Cursor and is left behind)
 * - `mcp.json` → MCP servers, added switched off
 * - `permissions.allow` `Shell(...)` rules in `cli-config.json` → command rules
 * - the chosen workspace's always-on project rules (`.cursor/rules`, `.cursorrules`) →
 *   workspace instructions (a workspace's AGENTS.md is already read by CoWork)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../utils/logger";
import { customInstructionsItem, shellRuleItems, skillFolderItems } from "./coding-tool-items";
import type { ReadSourceOptions } from "./hermes-reader";
import { readCursorStateValue } from "./cursor-state-worker";
import { readMcpServers } from "./mcp-config";
import { MAX_WORKSPACE_INSTRUCTIONS_CHARS } from "./openclaw-reader";
import { readyItem, skippedItem, type ImportPlan, type PlannedImportItem } from "./plan";
import {
  isDirectory,
  isFile,
  readJsonObjectIfExists,
  readRegularTextFile,
  splitFrontmatter,
} from "./source-files";

const logger = createLogger("AgentImport");

/** Where Cursor keeps User Rules in its app state database. */
const USER_RULES_KEY = "aicontext.personalContext";
const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 4;

export interface CursorHomeOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
}

export function resolveCursorHome(options: CursorHomeOptions = {}): string {
  return path.join(options.homedir ?? os.homedir(), ".cursor");
}

/** Cursor's app state database (VS Code layout) on this platform. */
export function cursorStateDbPath(options: CursorHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const base =
    platform === "darwin"
      ? path.join(homedir, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA?.trim() || path.join(homedir, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME?.trim() || path.join(homedir, ".config");
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

export function cursorHomeExists(home: string, options: CursorHomeOptions = {}): boolean {
  return (
    (isDirectory(home) &&
      (isFile(path.join(home, "mcp.json")) ||
        isFile(path.join(home, "cli-config.json")) ||
        isDirectory(path.join(home, "skills")))) ||
    isFile(cursorStateDbPath(options))
  );
}

/**
 * User Rules from Cursor's state database, read off the application thread. Null when
 * there are none or the database can't be read (Cursor may hold a lock while it writes).
 */
export async function readCursorUserRules(dbPath: string): Promise<string | null> {
  if (!isFile(dbPath)) return null;
  try {
    const text = await readCursorStateValue(dbPath, USER_RULES_KEY);
    if (text === null) return null;
    if (text.startsWith('"')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        return typeof parsed === "string" ? parsed : null;
      } catch {
        return text;
      }
    }
    return text;
  } catch (error) {
    logger.warn(
      `Could not read Cursor's User Rules: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

interface ProjectRule {
  name: string;
  body: string;
  always: boolean;
}

function readRuleFiles(rulesDir: string, workspacePath: string): ProjectRule[] {
  const rules: ProjectRule[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_RULE_DEPTH || rules.length >= MAX_RULE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (rules.length >= MAX_RULE_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.mdc?$/i.test(entry.name)) continue;
      // Dirent entries are never followed: a linked rule file reads as absent.
      const raw = readRegularTextFile(full);
      if (raw === null) continue;
      const { data, body } = splitFrontmatter(raw);
      // A rule with no frontmatter is always on; otherwise only `alwaysApply: true` is.
      const hasFrontmatter = Object.keys(data).length > 0;
      const always = !hasFrontmatter || data.alwaysApply === true || data.alwaysApply === "true";
      if (!body.trim()) continue;
      rules.push({ name: path.relative(workspacePath, full), body: body.trim(), always });
    }
  };
  visit(rulesDir, 0);
  return rules;
}

/** The workspace's always-on Cursor rules as one workspace-instructions item. */
function projectRuleItems(workspacePath: string): PlannedImportItem[] {
  const rules = readRuleFiles(path.join(workspacePath, ".cursor", "rules"), workspacePath);
  const legacy = readRegularTextFile(path.join(workspacePath, ".cursorrules"))?.trim();
  if (legacy) rules.unshift({ name: ".cursorrules", body: legacy, always: true });
  const always = rules.filter((rule) => rule.always);
  const other = rules.length - always.length;
  const items: PlannedImportItem[] = [];
  if (always.length > 0) {
    const text = always.map((rule) => `### ${rule.name}\n\n${rule.body}`).join("\n\n");
    const label = "Project rules (.cursor/rules)";
    items.push(
      text.length > MAX_WORKSPACE_INSTRUCTIONS_CHARS
        ? skippedItem(
            "instructions:workspace",
            "workspace_instructions",
            label,
            `${text.length} characters; CoWork's limit is ${MAX_WORKSPACE_INSTRUCTIONS_CHARS}. Copy the parts you need.`,
          )
        : readyItem(
            "instructions:workspace",
            "workspace_instructions",
            label,
            { kind: "workspace_instructions", text },
            {
              detail: `${always.length} ${always.length === 1 ? "rule" : "rules"} to .cowork/AGENTS.md in the chosen workspace`,
            },
          ),
    );
  }
  if (other > 0) {
    items.push(
      skippedItem(
        "instructions:scoped",
        "workspace_instructions",
        `${other} project ${other === 1 ? "rule" : "rules"} for matching files or on request`,
        "Cursor applies these only to some files or when asked; copy the ones you need.",
      ),
    );
  }
  return items;
}

export function readCursorHome(
  home: string,
  options: ReadSourceOptions &
    CursorHomeOptions & {
      workspacePath?: string;
      /** User Rules, read beforehand with `readCursorUserRules` (it is asynchronous). */
      userRules?: string | null;
    },
): ImportPlan {
  const plan: ImportPlan = {
    source: "cursor",
    home,
    found: cursorHomeExists(home, options),
    withSecrets: options.withSecrets,
    items: [],
  };
  if (!plan.found) return plan;
  const items = plan.items;

  const instructions = customInstructionsItem(
    "instructions:global",
    "User Rules",
    options.userRules ?? null,
  );
  if (instructions) items.push(instructions);

  items.push(...skillFolderItems([path.join(home, "skills")], "~/.cursor/skills"));

  items.push(
    ...readMcpServers(readJsonObjectIfExists(path.join(home, "mcp.json"))?.mcpServers, {
      withSecrets: options.withSecrets,
      sourceLabel: "Cursor",
    }),
  );

  const cliConfig = readJsonObjectIfExists(path.join(home, "cli-config.json")) ?? {};
  const permissions = cliConfig.permissions;
  items.push(
    ...shellRuleItems(
      permissions && typeof permissions === "object" && !Array.isArray(permissions)
        ? (permissions as Record<string, unknown>).allow
        : undefined,
      "Shell",
    ),
  );

  if (options.workspacePath) items.push(...projectRuleItems(options.workspacePath));
  return plan;
}
