import { InputSanitizer } from "../agent/security/input-sanitizer";
import { buildRoleKitSection } from "../context/kit-injection";
import { redactSensitiveMarkdownContent } from "../memory/MarkdownMemoryIndexService";

const ROLE_FILE_ORDER = ["IDENTITY.md", "RULES.md", "SOUL.md", "MEMORY.md", "VIBES.md"] as const;
const TOTAL_ROLE_PROFILE_FILES = ROLE_FILE_ORDER.length;
const MAX_FILE_CHARS = 4000;

interface RolePersonaOptions {
  workspacePath?: string | null;
  includeDbFallback?: boolean;
  readGuard?: (candidatePath: string) => boolean;
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

function buildRoleProfileFromFiles(
  role: RolePersonaInput,
  workspacePath?: string | null,
  readGuard?: RolePersonaOptions["readGuard"],
): string {
  if (!workspacePath) return "";

  const profileByFile = new Map<string, string>();
  const dirs = getRoleFolderCandidates(role);

  for (const roleDir of dirs) {
    for (const file of ROLE_FILE_ORDER) {
      if (profileByFile.has(file)) continue;

      const section = buildRoleKitSection(workspacePath, roleDir, file, readGuard);
      if (!section) continue;
      profileByFile.set(file, section.rendered);
    }

    if (profileByFile.size >= TOTAL_ROLE_PROFILE_FILES) {
      break;
    }
  }

  if (profileByFile.size === 0) {
    return "";
  }

  return ROLE_FILE_ORDER.map((file) => profileByFile.get(file))
    .filter((section): section is string => Boolean(section))
    .join("\n\n")
    .trim();
}

export function buildRolePersonaPrompt(
  role: RolePersonaInput,
  workspacePath?: string | null,
  options: RolePersonaOptions = {},
): string {
  const includeDbFallback = options.includeDbFallback ?? true;
  const fromFiles = buildRoleProfileFromFiles(role, workspacePath, options.readGuard);

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
