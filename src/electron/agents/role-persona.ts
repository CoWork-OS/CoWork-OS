import * as fs from "fs";
import * as path from "path";

import { InputSanitizer } from "../agent/security/input-sanitizer";
import { redactSensitiveMarkdownContent } from "../memory/MarkdownMemoryIndexService";

const KIT_DIRNAME = ".cowork";
const ROLE_PROFILE_DIR = "agents";
const ROLE_PROFILE_FILES: Array<{ file: string; title: string }> = [
  { file: "VIBES.md", title: "Role Vibes" },
  { file: "SOUL.md", title: "Role Persona" },
  { file: "IDENTITY.md", title: "Role Identity" },
  { file: "RULES.md", title: "Role Rules" },
];

const MAX_FILE_BYTES = 96 * 1024;
const MAX_FILE_CHARS = 4000;
const TOTAL_ROLE_PROFILE_FILES = ROLE_PROFILE_FILES.length;

interface RolePersonaOptions {
  workspacePath?: string | null;
  includeDbFallback?: boolean;
}

export interface RolePersonaInput {
  id?: string;
  name?: string;
  displayName?: string;
  soul?: string | null;
}

function clampSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[... truncated ...]";
}

function sanitizePersonaText(text: string): string {
  const redacted = redactSensitiveMarkdownContent(text || "");
  return InputSanitizer.sanitizeMemoryContent(redacted).trim();
}

function safeResolveWithinWorkspace(workspacePath: string, relPath: string): string | null {
  const root = path.resolve(workspacePath);
  const candidate = path.resolve(workspacePath, relPath);
  const relative = path.relative(root, candidate);
  const isInsideWorkspace =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (isInsideWorkspace) {
    return candidate;
  }
  return null;
}

function readFilePrefix(absPath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;

    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function slugifyRoleName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "-");
  return slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeRoleFolderName(input: string): string {
  const lowered = input.trim().toLowerCase();
  return lowered
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRoleFolderCandidates(role: RolePersonaInput): string[] {
  const candidates = new Set<string>();

  if (role.name) {
    const preserved = normalizeRoleFolderName(role.name);
    if (preserved) candidates.add(preserved);

    const slug = slugifyRoleName(role.name);
    if (slug) candidates.add(slug);
  }

  if (role.displayName) {
    const preserved = normalizeRoleFolderName(role.displayName);
    if (preserved) candidates.add(preserved);

    const slug = slugifyRoleName(role.displayName);
    if (slug) candidates.add(slug);
  }

  if (role.id) {
    const preserved = normalizeRoleFolderName(role.id);
    if (preserved) candidates.add(preserved);

    const slug = slugifyRoleName(role.id);
    if (slug) candidates.add(slug);
  }

  candidates.add("default");
  return Array.from(candidates);
}

function summarizeSoulFromDb(soul?: string | null): string | null {
  const trimmed = typeof soul === "string" ? soul.trim() : "";
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const parts: string[] = [];

    const add = (label: string, value: unknown) => {
      if (typeof value === "string" && value.trim().length > 0) {
        parts.push(`${label}: ${value.trim()}`);
      }
    };

    add("Name", parsed.name);
    add("Role", parsed.role);
    add("Personality", parsed.personality);
    add("Communication style", parsed.communicationStyle);

    if (Array.isArray(parsed.focusAreas) && parsed.focusAreas.length > 0) {
      parts.push(`Focus areas: ${parsed.focusAreas.map(String).join(", ")}`);
    }

    if (Array.isArray(parsed.strengths) && parsed.strengths.length > 0) {
      parts.push(`Strengths: ${parsed.strengths.map(String).join(", ")}`);
    }

    const summary = parts.length > 0 ? parts.join("\n") : trimmed;
    return sanitizePersonaText(clampSection(summary, MAX_FILE_CHARS));
  } catch {
    return sanitizePersonaText(clampSection(trimmed, MAX_FILE_CHARS));
  }
}

function buildRoleProfileFromFiles(role: RolePersonaInput, workspacePath?: string | null): string {
  if (!workspacePath) return "";

  const profileByFile = new Map<string, string>();
  const dirs = getRoleFolderCandidates(role);

  for (const roleDir of dirs) {
    for (const fileSpec of ROLE_PROFILE_FILES) {
      if (profileByFile.has(fileSpec.file)) {
        continue;
      }

      const relPath = path.join(KIT_DIRNAME, ROLE_PROFILE_DIR, roleDir, fileSpec.file);
      const absPath = safeResolveWithinWorkspace(workspacePath, relPath);
      if (!absPath) continue;

      const raw = readFilePrefix(absPath, MAX_FILE_BYTES);
      if (!raw) continue;
      if (raw.trim().length < 2) continue;

      const content = sanitizePersonaText(clampSection(raw, MAX_FILE_CHARS));
      if (!content) continue;

      profileByFile.set(
        fileSpec.file,
        `### ${fileSpec.title} (${relPath.replace(/\\/g, "/")})\n${content}`,
      );
    }

    if (profileByFile.size >= TOTAL_ROLE_PROFILE_FILES) {
      break;
    }
  }

  if (profileByFile.size === 0) {
    return "";
  }

  const sections: string[] = [];
  for (const fileSpec of ROLE_PROFILE_FILES) {
    const section = profileByFile.get(fileSpec.file);
    if (!section) continue;

    sections.push(section);
    sections.push("");
  }

  return sections.join("\n").trim();
}

export function buildRolePersonaPrompt(
  role: RolePersonaInput,
  workspacePath?: string | null,
  options: RolePersonaOptions = {},
): string {
  const includeDbFallback = options.includeDbFallback ?? true;
  const fromFiles = buildRoleProfileFromFiles(role, workspacePath);

  if (fromFiles) {
    return `ROLE PROFILE\n${fromFiles}`;
  }

  if (!includeDbFallback) {
    return "";
  }

  const fromDb = summarizeSoulFromDb(role.soul);
  if (!fromDb) return "";

  return `ROLE NOTES\n${fromDb}`;
}
