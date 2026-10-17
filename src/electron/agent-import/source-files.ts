/**
 * File helpers shared by the Hermes and OpenClaw readers. Reads only; every helper fails
 * soft (a missing or unreadable file reads as absent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatterBlock } from "../utils/skill-frontmatter";
import type { ImportProviderId } from "./plan";

/** Larger files are not memory or persona text; they are skipped, not truncated. */
export const MAX_IMPORT_TEXT_BYTES = 512 * 1024;
const MAX_SKILL_SCAN_DEPTH = 4;
const MAX_SKILLS = 500;

export function readTextIfExists(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_IMPORT_TEXT_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Keys whose values are credentials. Values of other keys (allowed user ids) are kept. */
export function isSecretEnvKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIALS?|NSEC|JSON)$/i.test(key);
}

/** Stands in for a credential that was set but not read in (secrets not opted in). */
export const WITHHELD_SECRET = "\u0000withheld";

/**
 * Parse a dotenv file. Secret values are kept only when `keepSecrets` is true; otherwise a
 * set credential reads as WITHHELD_SECRET so callers can still list it by name. Keys with
 * an empty value are left out.
 */
export function parseEnvText(text: string, keepSecrets: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (!value) continue;
    out.set(key, isSecretEnvKey(key) && !keepSecrets ? WITHHELD_SECRET : value);
  }
  return out;
}

/** A credential value, or undefined when it was withheld or is missing. */
export function secretValue(value: string | undefined): string | undefined {
  return value && value !== WITHHELD_SECRET ? value : undefined;
}

/** Env names Hermes and OpenClaw use for provider keys CoWork can take. */
export const PROVIDER_KEY_ENV: ReadonlyArray<{ env: string; provider: ImportProviderId }> = [
  { env: "OPENROUTER_API_KEY", provider: "openrouter" },
  { env: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { env: "OPENAI_API_KEY", provider: "openai" },
  { env: "GEMINI_API_KEY", provider: "gemini" },
  { env: "GOOGLE_API_KEY", provider: "gemini" },
  { env: "DEEPSEEK_API_KEY", provider: "deepseek" },
  { env: "GROQ_API_KEY", provider: "groq" },
  { env: "XAI_API_KEY", provider: "xai" },
  { env: "KIMI_API_KEY", provider: "kimi" },
];

/** Map a provider name or base URL from the source config to a CoWork provider. */
export function providerFromName(name: string, baseUrl = ""): ImportProviderId | null {
  const hay = `${name} ${baseUrl}`.toLowerCase();
  if (hay.includes("openrouter")) return "openrouter";
  if (hay.includes("anthropic") || hay.includes("claude")) return "anthropic";
  if (hay.includes("deepseek")) return "deepseek";
  if (hay.includes("groq")) return "groq";
  if (hay.includes("x.ai") || /\bxai\b/.test(hay) || hay.includes("grok")) return "xai";
  if (hay.includes("gemini") || hay.includes("generativelanguage") || /\bgoogle\b/.test(hay)) {
    return "gemini";
  }
  if (hay.includes("moonshot") || /\bkimi\b/.test(hay)) return "kimi";
  if (hay.includes("openai")) return "openai";
  return null;
}

export interface FoundSkillBundle {
  dir: string;
  name: string;
  description?: string;
}

function readSkillFrontmatter(skillMdPath: string): Record<string, unknown> {
  const raw = readTextIfExists(skillMdPath);
  if (!raw) return {};
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};
  try {
    return parseFrontmatterBlock(normalized.slice(4, end));
  } catch {
    return {};
  }
}

/**
 * Every directory under `root` that holds a SKILL.md, without descending into a skill
 * once found. Dot-directories (`.hub`, `.archive`) and symbolic links are skipped.
 */
export function findSkillBundles(root: string): FoundSkillBundle[] {
  const found: FoundSkillBundle[] = [];
  const visit = (dir: string, depth: number) => {
    if (found.length >= MAX_SKILLS || depth > MAX_SKILL_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const frontmatter = readSkillFrontmatter(path.join(dir, "SKILL.md"));
      const name =
        typeof frontmatter.name === "string" && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : path.basename(dir);
      const description =
        typeof frontmatter.description === "string" && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : undefined;
      found.push({ dir, name, ...(description ? { description } : {}) });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

export function shortDescription(text: string | undefined, max = 90): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Programs an imported allowlist entry must never turn into a standing "allow": shells,
 * interpreters and wrappers run arbitrary code, so allowing them would allow everything.
 */
const UNSAFE_ALLOWLIST_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "env",
  "sudo",
  "doas",
  "su",
  "xargs",
  "exec",
  "eval",
  "nohup",
  "time",
  "timeout",
  "nice",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "open",
  "ssh",
  "scp",
  "rm",
  "dd",
]);

/**
 * Turn one OpenClaw exec allowlist pattern into a CoWork command prefix, or explain why
 * not. Only an exact program path or name is accepted; globs are too broad to carry over.
 */
export function commandPrefixFromAllowlistPattern(
  pattern: string,
): { prefix: string } | { reason: string } {
  const trimmed = pattern.trim();
  if (!trimmed) return { reason: "Empty pattern." };
  if (/[*?[\]{}]/.test(trimmed)) {
    return {
      reason: "Wildcard patterns are too broad to allow; approve commands as they come up.",
    };
  }
  if (/\s/.test(trimmed)) return { reason: "Not a single program path." };
  const program = trimmed.split(/[\\/]/).pop() || "";
  const base = program.replace(/\.(exe|cmd|bat)$/i, "");
  if (!/^[A-Za-z0-9._+-]+$/.test(base)) return { reason: "Not a program name CoWork can match." };
  const versionless = base.toLowerCase().replace(/[\d.]+$/, "");
  if (
    UNSAFE_ALLOWLIST_PROGRAMS.has(base.toLowerCase()) ||
    UNSAFE_ALLOWLIST_PROGRAMS.has(versionless)
  ) {
    return { reason: `${base} can run any command, so it stays approval-gated.` };
  }
  return { prefix: base };
}

/** Split free-form markdown into memory entries: list items and paragraphs, no headings. */
export function splitMarkdownEntries(text: string): string[] {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const entries: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (joined) entries.push(joined);
    paragraph = [];
  };
  for (const rawLine of withoutComments.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      // A list item starts an entry; indented continuation lines join it.
      flush();
      paragraph.push(bullet[1]);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return entries;
}
