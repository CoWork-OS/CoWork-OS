import type { TaskDomain } from "./types";

const SUPPORTED_COMMANDS = new Set(["simplify", "batch", "llm-wiki"]);
const SUPPORTED_DOMAINS = new Set(["auto", "code", "research", "operations", "writing", "general"]);
const SUPPORTED_SIMPLIFY_SCOPES = new Set(["current", "workspace", "path"]);
const SUPPORTED_EXTERNAL_MODES = new Set(["confirm", "execute", "none"]);
const SUPPORTED_LLM_WIKI_MODES = new Set(["auto", "init", "ingest", "query", "lint", "refresh"]);
const SUPPORTED_LLM_WIKI_OBSIDIAN_MODES = new Set(["auto", "on", "off"]);
const LLM_WIKI_OPTIONAL_OBJECTIVE_MODES = new Set(["init", "lint", "refresh"]);

export type SkillSlashCommandName = "simplify" | "batch" | "llm-wiki";
export type SkillSlashExternalMode = "confirm" | "execute" | "none";
export type SkillSlashScope = "current" | "workspace" | "path";
export type SkillSlashLlmWikiMode = "auto" | "init" | "ingest" | "query" | "lint" | "refresh";
export type SkillSlashLlmWikiObsidianMode = "auto" | "on" | "off";

export interface ParsedSkillSlashCommand {
  command: SkillSlashCommandName;
  objective: string;
  flags: {
    domain?: TaskDomain;
    scope?: SkillSlashScope;
    parallel?: number;
    external?: SkillSlashExternalMode;
    mode?: SkillSlashLlmWikiMode;
    path?: string;
    obsidian?: SkillSlashLlmWikiObsidianMode;
  };
  raw: string;
}

export interface SkillSlashParseResult {
  matched: boolean;
  parsed?: ParsedSkillSlashCommand;
  error?: string;
}

export interface InlineSkillSlashParseResult extends SkillSlashParseResult {
  baseText?: string;
}

function tokenizeArgs(input: string): string[] {
  const text = String(input || "").trim();
  if (!text) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === "\\") {
      const next = text[i + 1];
      if (quote && next) {
        current += next;
        i += 1;
        continue;
      }
      if (!quote && next && /[\s"'`\\]/.test(next)) {
        current += next;
        i += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function splitLongFlagToken(token: string): { key: string; inlineValue: string | null } | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const body = token.slice(2);
  if (!body) {
    return null;
  }
  const equalsIndex = body.indexOf("=");
  if (equalsIndex === -1) {
    return { key: body.toLowerCase(), inlineValue: null };
  }
  return {
    key: body.slice(0, equalsIndex).toLowerCase(),
    inlineValue: body.slice(equalsIndex + 1),
  };
}

function parseCommandTail(commandName: string, tail: string, raw: string): SkillSlashParseResult {
  const lowerName = commandName.toLowerCase();
  if (!SUPPORTED_COMMANDS.has(lowerName)) {
    return { matched: false };
  }

  const command = lowerName as SkillSlashCommandName;
  const tokens = tokenizeArgs(tail);
  const objectiveTokens: string[] = [];
  const flags: ParsedSkillSlashCommand["flags"] = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      objectiveTokens.push(token);
      continue;
    }

    const parsedFlag = splitLongFlagToken(token);
    if (!parsedFlag) {
      objectiveTokens.push(token);
      continue;
    }

    const { key, inlineValue } = parsedFlag;
    const nextValue = tokens[i + 1];

    const consumeFlagValue = (): string | null => {
      if (inlineValue !== null) {
        return inlineValue.length > 0 ? inlineValue : null;
      }
      if (!nextValue || nextValue.startsWith("--")) {
        return null;
      }
      i += 1;
      return nextValue;
    };

    if (key === "domain") {
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      if (!SUPPORTED_DOMAINS.has(value)) {
        return {
          matched: true,
          error: `Invalid domain "${value}". Use auto|code|research|operations|writing|general.`,
        };
      }
      flags.domain = value as TaskDomain;
      continue;
    }

    if (key === "scope") {
      if (command !== "simplify") {
        return { matched: true, error: "--scope is only supported for /simplify." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      if (!SUPPORTED_SIMPLIFY_SCOPES.has(value)) {
        return {
          matched: true,
          error: `Invalid scope "${value}". Use current|workspace|path.`,
        };
      }
      flags.scope = value as SkillSlashScope;
      continue;
    }

    if (key === "parallel") {
      if (command !== "batch") {
        return { matched: true, error: "--parallel is only supported for /batch." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 8) {
        return { matched: true, error: "Invalid --parallel value. Use an integer from 1 to 8." };
      }
      flags.parallel = parsed;
      continue;
    }

    if (key === "external") {
      if (command !== "batch") {
        return { matched: true, error: "--external is only supported for /batch." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      if (!SUPPORTED_EXTERNAL_MODES.has(value)) {
        return {
          matched: true,
          error: `Invalid --external value "${value}". Use confirm|execute|none.`,
        };
      }
      flags.external = value as SkillSlashExternalMode;
      continue;
    }

    if (key === "mode") {
      if (command !== "llm-wiki") {
        return { matched: true, error: "--mode is only supported for /llm-wiki." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      if (!SUPPORTED_LLM_WIKI_MODES.has(value)) {
        return {
          matched: true,
          error: `Invalid mode "${value}". Use auto|init|ingest|query|lint|refresh.`,
        };
      }
      flags.mode = value as SkillSlashLlmWikiMode;
      continue;
    }

    if (key === "path") {
      if (command !== "llm-wiki") {
        return { matched: true, error: "--path is only supported for /llm-wiki." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      flags.path = value;
      continue;
    }

    if (key === "obsidian") {
      if (command !== "llm-wiki") {
        return { matched: true, error: "--obsidian is only supported for /llm-wiki." };
      }
      const value = consumeFlagValue();
      if (!value) {
        return { matched: true, error: `Missing value for --${key}.` };
      }
      if (!SUPPORTED_LLM_WIKI_OBSIDIAN_MODES.has(value)) {
        return {
          matched: true,
          error: `Invalid --obsidian value "${value}". Use auto|on|off.`,
        };
      }
      flags.obsidian = value as SkillSlashLlmWikiObsidianMode;
      continue;
    }

    // Keep freeform objectives truly freeform, even when they contain "--tokens".
    objectiveTokens.push(token);
  }

  const objective = objectiveTokens.join(" ").trim();
  if (command === "batch" && !objective) {
    return {
      matched: true,
      error:
        "Missing objective for /batch. Usage: /batch <objective> [--parallel 1-8] [--domain auto|code|research|operations|writing|general] [--external confirm|execute|none].",
    };
  }
  if (command === "llm-wiki" && !objective) {
    if (flags.mode && LLM_WIKI_OPTIONAL_OBJECTIVE_MODES.has(flags.mode)) {
      return {
        matched: true,
        parsed: {
          command,
          objective,
          flags,
          raw: raw.trim(),
        },
      };
    }
    return {
      matched: true,
      error:
        "Missing objective for /llm-wiki. Usage: /llm-wiki <objective> [--mode auto|init|ingest|query|lint|refresh] [--path <workspace-relative-or-absolute-path>] [--obsidian auto|on|off].",
    };
  }

  return {
    matched: true,
    parsed: {
      command,
      objective,
      flags,
      raw: raw.trim(),
    },
  };
}

export function parseLeadingSkillSlashCommand(input: string): SkillSlashParseResult {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/^\/(simplify|batch|llm-wiki)(?=\s|$)([\s\S]*)$/i);
  if (!match) {
    return { matched: false };
  }
  return parseCommandTail(match[1], match[2], trimmed);
}

export function parseInlineSkillSlashChain(input: string): InlineSkillSlashParseResult {
  const text = String(input || "");
  const re = /\bthen\s+run\s+\/(simplify|batch|llm-wiki)(?=$|[\s.,!?;:)\]"'])/gi;
  const matches = Array.from(text.matchAll(re)) as RegExpExecArray[];
  if (matches.length === 0) {
    return { matched: false };
  }
  if (matches.length > 1) {
    return {
      matched: true,
      error: "Multiple inline slash commands found. Use one `then run /...` chain per message.",
    };
  }

  const selected = matches[0];
  if (typeof selected.index !== "number") {
    return { matched: false };
  }

  const fullMatch = selected[0];
  const commandName = selected[1];
  const baseText = text.slice(0, selected.index).trim();
  const tail = text
    .slice(selected.index + fullMatch.length)
    .replace(/^[\s.,!?;:)\]"']+/, "")
    .trim();
  const raw = `/${commandName}${tail ? ` ${tail}` : ""}`;
  let parsed = parseCommandTail(commandName, tail, raw);
  if (
    commandName.toLowerCase() === "llm-wiki" &&
    parsed.matched &&
    parsed.error &&
    parsed.error.startsWith("Missing objective for /llm-wiki") &&
    baseText
  ) {
    const inferredTail = `${baseText}${tail ? ` ${tail}` : ""}`.trim();
    parsed = parseCommandTail(commandName, inferredTail, `/${commandName} ${inferredTail}`.trim());
  }
  return {
    ...parsed,
    baseText,
  };
}
