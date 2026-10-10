import { z } from "zod";

/**
 * Actions an answer surface can ask for: send a message to the agent, or open a web link.
 * Nothing happens on the request alone. The app shows the exact message or the full link
 * in a confirmation it draws itself, outside the surface, and acts only when the user
 * approves it there. A sent message then goes through the agent like anything the user
 * types, so every tool it leads to still meets the normal tool policies and approvals.
 */

/** Short enough that the whole message is always on screen in the confirmation. */
export const SURFACE_ACTION_MAX_PROMPT_CHARS = 600;
export const SURFACE_ACTION_MAX_PROMPT_LINES = 8;
export const SURFACE_ACTION_MAX_URL_CHARS = 2000;

export type SurfaceAction = { prompt: string } | { open: string };

/** Where a request came from: a native answer block, or page code in an HTML frame. */
export type SurfaceActionOrigin = "answer" | "page";

/** A request after checks: the exact text to send, or the normalized link to open. */
export type SurfaceActionRequest =
  | { kind: "prompt"; text: string }
  | {
      kind: "open";
      url: string;
      /** Host and port, as shown. */
      host: string;
      /** Characters after the path (query and hash), which can carry data out. */
      extra: number;
    };

/**
 * Characters that show as nothing (or as blank space) but are still read by a model:
 * format and control characters, tag characters, variation selectors, private use,
 * unassigned code points, and the blank "filler" letters. Dropped so that what the
 * confirmation shows is exactly what is sent.
 */
// Built from escaped strings: written as literals, the formatter turns the escapes into
// the invisible characters themselves. Combining marks are listed outside the class.
const INVISIBLE_CHARS = new RegExp(
  [
    "[\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}\\p{Zl}\\p{Zp}\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f" +
      "\\u115f\\u1160\\u17b4\\u17b5\\u2800\\u3164\\uffa0\\u{e0000}-\\u{e007f}]",
    "\\u034f",
    "[\\u180b-\\u180d\\u180f]",
    "[\\ufe00-\\ufe0f]",
    "[\\u{e0100}-\\u{e01ef}]",
  ].join("|"),
  "gu",
);
const SPACE_RUNS = new RegExp("[ \\t\\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000]+", "g");

/** Visible text only, single-spaced, for labels and links the app shows. */
export function visibleSurfaceText(text: string): string {
  return text.replace(INVISIBLE_CHARS, "").replace(SPACE_RUNS, " ").trim();
}

/** A message as it will be shown and sent: visible characters, at most one blank line in a row. */
function cleanPrompt(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(visibleSurfaceText)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** This machine and private networks: a page must not get the user to poke local services. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host === "::" ||
      /^(?:fc|fd|fe[89ab])/.test(host) ||
      host.startsWith("::ffff:")
    );
  }
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = octets.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * The link as it will be opened, or null when it is not a plain https link to a public
 * host. Credentials in the link are refused because `https://bank.com@evil.test` reads as
 * one site and goes to another.
 */
export function normalizeSurfaceActionUrl(
  raw: string,
): { url: string; host: string; extra: number } | null {
  if (typeof raw !== "string" || raw.length > SURFACE_ACTION_MAX_URL_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (isLocalHost(parsed.hostname)) return null;
  if (parsed.href.length > SURFACE_ACTION_MAX_URL_CHARS) return null;
  return { url: parsed.href, host: parsed.host, extra: parsed.search.length + parsed.hash.length };
}

/** Checks an action and returns what the confirmation will show, or null if it is unusable. */
export function toSurfaceActionRequest(action: unknown): SurfaceActionRequest | null {
  if (!action || typeof action !== "object") return null;
  const value = action as Record<string, unknown>;
  if (typeof value.prompt === "string" && value.open === undefined) {
    const text = cleanPrompt(value.prompt);
    if (!text || text.length > SURFACE_ACTION_MAX_PROMPT_CHARS) return null;
    if (text.split("\n").length > SURFACE_ACTION_MAX_PROMPT_LINES) return null;
    return { kind: "prompt", text };
  }
  if (typeof value.open === "string" && value.prompt === undefined) {
    const link = normalizeSurfaceActionUrl(value.open);
    return link ? { kind: "open", ...link } : null;
  }
  return null;
}

/** The schema for an action in a ```cowork-ui block. */
export const SurfaceActionSchema = z.union([
  z.object({ prompt: z.string().trim().min(1).max(SURFACE_ACTION_MAX_PROMPT_CHARS) }).strict(),
  z
    .object({
      open: z
        .string()
        .trim()
        .max(SURFACE_ACTION_MAX_URL_CHARS)
        .refine(
          (url) => normalizeSurfaceActionUrl(url) !== null,
          "Links must be public https URLs",
        ),
    })
    .strict(),
]) as z.ZodType<SurfaceAction>;
