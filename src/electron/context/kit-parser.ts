import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { InputSanitizer } from "../agent/security/input-sanitizer";
import { redactSensitiveMarkdownContent } from "../memory/MarkdownMemoryIndexService";
import type { KitContract } from "./kit-contracts";

export interface ParsedKitDoc {
  file: string;
  relPath?: string;
  body: string;
  rawBody: string;
  meta: Record<string, string>;
  warnings: string[];
  sha256: string;
  truncated: boolean;
}

export function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();
  if (!trimmed.startsWith("---\n")) {
    return { meta: {}, body: raw };
  }

  const end = trimmed.indexOf("\n---\n", 4);
  if (end === -1) {
    return { meta: {}, body: raw };
  }

  const fm = trimmed.slice(4, end).trim();
  const body = trimmed.slice(end + 5);
  const meta: Record<string, string> = {};

  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  return { meta, body };
}

export function sanitizeKitMarkdown(raw: string): string {
  const redacted = redactSensitiveMarkdownContent(raw || "");
  return InputSanitizer.sanitizeMemoryContent(redacted).trim();
}

export function truncateKitText(
  text: string,
  maxChars: number,
): {
  value: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return { value: text, truncated: false };
  }
  return {
    value: text.slice(0, maxChars) + "\n[...truncated]",
    truncated: true,
  };
}

export function parseKitDocumentFromString(
  raw: string,
  contract: KitContract,
  file = contract.file,
  relPath?: string,
): ParsedKitDoc | null {
  if (!raw.trim()) return null;

  const { meta, body } = splitFrontmatter(raw);
  const warnings: string[] = [];

  // DESIGN.md uses its YAML frontmatter as the token source of truth, so unlike
  // normal kit docs we keep the full document available for agent context.
  const sourceBody = contract.parser === "design-system" ? raw : body;
  const sanitized = sanitizeKitMarkdown(sourceBody);
  const truncated = truncateKitText(sanitized, contract.maxChars);
  if (!truncated.value.trim()) return null;

  if (contract.freshnessDays && !meta.updated) {
    warnings.push(`Missing updated date in ${path.basename(file)}`);
  }

  const sha256 = createHash("sha256").update(raw).digest("hex");

  return {
    file: path.basename(file),
    relPath,
    body: truncated.value,
    rawBody: body.trim(),
    meta,
    warnings,
    sha256,
    truncated: truncated.truncated,
  };
}

export function parseKitDocument(
  absPath: string,
  contract: KitContract,
  relPath?: string,
): ParsedKitDoc | null {
  if (!fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return null;

  const raw = fs.readFileSync(absPath, "utf8");
  return parseKitDocumentFromString(raw, contract, path.basename(absPath), relPath);
}
