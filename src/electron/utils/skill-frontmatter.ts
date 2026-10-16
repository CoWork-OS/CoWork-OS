/**
 * SKILL.md frontmatter parsing shared by the skill registry (imports), plugin-pack
 * directory-backed skills, and the CLI skill listing.
 *
 * Callers find the `---` fences themselves (their body handling differs) and pass the
 * text between them to parseFrontmatterBlock.
 */

import { FAILSAFE_SCHEMA, load as loadYaml } from "js-yaml";

const SCALAR_KEYWORDS = new Map<string, boolean | null>([
  ["true", true],
  ["false", false],
  ["null", null],
]);

/**
 * Parse a frontmatter block as YAML so folded/literal block scalars (`>`, `|`) and quoted
 * scalars with escapes come through intact. FAILSAFE_SCHEMA keeps scalars as strings (no
 * number/date coercion). Hand-written SKILL.md files are often not valid YAML (e.g.
 * `description: Use when: ...`), so invalid blocks fall back to a lenient line parser.
 * In both paths the bare scalars `true`, `false` and `null` map to their JS values.
 */
export function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const normalized = block.replace(/\r\n/g, "\n");
  return parseYamlBlock(normalized) ?? parseLines(normalized);
}

/** Trimmed, non-empty string value of a frontmatter field, or undefined. */
export function frontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(frontmatter, key)
    ? frontmatter[key]
    : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseYamlBlock(block: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = loadYaml(block, { schema: FAILSAFE_SCHEMA });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  // Object.fromEntries defines own properties, so a `__proto__` key can't swap the prototype.
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === "string" && SCALAR_KEYWORDS.has(value) ? SCALAR_KEYWORDS.get(value) : value,
    ]),
  );
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const normalized = stripQuotes(value);
  return SCALAR_KEYWORDS.has(normalized) ? SCALAR_KEYWORDS.get(normalized) : normalized;
}

function parseLines(block: string): Record<string, unknown> {
  const lines = block.split("\n");
  const entries: Array<[string, unknown]> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const [, key, rawValue = ""] = match;
    if (rawValue.trim().length > 0) {
      entries.push([key, parseScalar(rawValue)]);
      continue;
    }

    const items: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const itemMatch = lines[nextIndex]?.match(/^\s*-\s+(.+)$/);
      if (!itemMatch) break;
      items.push(stripQuotes(itemMatch[1] || ""));
      nextIndex += 1;
    }

    if (items.length > 0) {
      entries.push([key, items]);
      index = nextIndex - 1;
    } else {
      entries.push([key, ""]);
    }
  }

  return Object.fromEntries(entries);
}
