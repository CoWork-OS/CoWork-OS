import type { TaskDomain } from "./types";

const SUPPORTED_COMMANDS = new Set(["simplify", "batch"]);
const SUPPORTED_DOMAINS = new Set([
  "auto",
  "code",
  "research",
  "operations",
  "writing",
  "general",
]);
const SUPPORTED_SIMPLIFY_SCOPES = new Set(["current", "workspace", "path"]);
const SUPPORTED_EXTERNAL_MODES = new Set(["confirm", "execute", "none"]);

export type SkillSlashCommandName = "simplify" | "batch";
export type SkillSlashExternalMode = "confirm" | "execute" | "none";
export type SkillSlashScope = "current" | "workspace" | "path";

export interface ParsedSkillSlashCommand {
  command: SkillSlashCommandName;
  objective: string;
  flags: {
    domain?: TaskDomain;
    scope?: SkillSlashScope;
    parallel?: number;
    external?: SkillSlashExternalMode;
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
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|(\S+)/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const bare = match[4];
    const value = String(quoted ?? bare ?? "").replace(/\\(["'`\\])/g, "$1");
    if (value.length > 0) {
      tokens.push(value);
    }
  }
  return tokens;
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

    const key = token.slice(2).toLowerCase();
    const nextValue = tokens[i + 1];

    const consumeFlagValue = (): string | null => {
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
  const match = trimmed.match(/^\/(simplify|batch)(?=\s|$)([\s\S]*)$/i);
  if (!match) {
    return { matched: false };
  }
  return parseCommandTail(match[1], match[2], trimmed);
}

export function parseInlineSkillSlashChain(input: string): InlineSkillSlashParseResult {
  const text = String(input || "");
  const re = /\bthen\s+run\s+\/(simplify|batch)(?=$|[\s.,!?;:)\]"'])/gi;
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
  const parsed = parseCommandTail(commandName, tail, raw);
  return {
    ...parsed,
    baseText,
  };
}
