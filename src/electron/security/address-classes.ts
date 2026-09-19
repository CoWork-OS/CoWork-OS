/**
 * Address-class classification for outbound request policy.
 *
 * Extracted from ipc/handlers.ts, where these were module-private. That is why
 * the agent's fetch path (`web_fetch`, `http_request`, scraping, browser tools)
 * grew its own hostname-string-only policy with no address check at all, and
 * could reach cloud metadata and internal ranges. Single implementation now —
 * do not add a third.
 *
 * "Internal" here means link-local (including the 169.254.169.254 cloud
 * metadata endpoint), private RFC-1918 ranges, carrier-grade NAT, unique-local
 * IPv6, and the unspecified address. Loopback is classified separately: it is
 * genuinely useful for the agent (fetching a dev server it just started) and
 * the app's own loopback services all require bearer tokens, so callers decide
 * whether to permit it.
 */
import { isIP } from "net";

/** Hostnames that resolve to internal addresses by convention. */
const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

export function normalizeHostname(hostname: string): string {
  const trimmed = String(hostname || "")
    .trim()
    .toLowerCase();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

/**
 * Expand an IPv6 literal to its 16 bytes, or null when it is not parseable.
 *
 * Text matching is not sufficient for the IPv4-mapped forms: `new URL()`
 * canonicalizes `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so the hex
 * spelling is what actually reaches this module from a parsed URL, and a
 * dotted-quad-only check classifies the cloud metadata endpoint as public.
 */
function ipv6ToBytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;

  let text = address;
  // A trailing dotted quad (::ffff:10.0.0.1) is equivalent to two hex groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const quad = dotted[2].split(".").map((part) => Number(part));
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${dotted[1]}${((quad[0] << 8) | quad[1]).toString(16)}:${(
      (quad[2] << 8) |
      quad[3]
    ).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  // Without "::" the address must already be complete; with it, at least one
  // group must be elided.
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;

  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return bytes;
}

/**
 * Return the dotted quad embedded in an IPv4-mapped address (::ffff:a.b.c.d in
 * any spelling), or null when `address` is not one. The caller classifies the
 * result with the IPv4 rules so mapped and bare forms cannot disagree.
 */
function mappedIpv4Address(address: string): string | null {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return null;
  if (bytes.slice(0, 10).some((byte) => byte !== 0)) return null;
  if (((bytes[10] << 8) | bytes[11]) !== 0xffff) return null;
  return bytes.slice(12).join(".");
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  if (family === 6) {
    if (normalized === "::1") return true;
    // ::ffff:127.0.0.1 is loopback too, and reaches us as ::ffff:7f00:1.
    const mapped = mappedIpv4Address(normalized);
    return mapped !== null && mapped.split(".")[0] === "127";
  }
  return false;
}

export function isPrivateIpv4Address(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export function isPrivateIpv6Address(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (!normalized || normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  // IPv4-compatible (::10.0.0.1) text form.
  const compatible = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (compatible) return isPrivateIpv4Address(compatible[1]);
  // IPv4-mapped (::ffff:10.0.0.1), in either the dotted-quad or the hex
  // spelling a parsed URL produces.
  const mapped = mappedIpv4Address(normalized);
  if (mapped) return isPrivateIpv4Address(mapped);
  return false;
}

export function isPrivateOrLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4Address(normalized);
  if (family === 6) return isPrivateIpv6Address(normalized);
  return false;
}

/**
 * True when `host` is an internal target that outbound agent requests must not
 * reach. Set `allowLoopback` when a loopback destination is acceptable (the
 * default for agent fetches, so a local dev server stays reachable).
 *
 * This only inspects the literal host. A DNS name pointing at an internal
 * address is caught by resolving first — see `assertResolvedHostAllowed`.
 */
export function isBlockedInternalHost(host: string, allowLoopback = false): boolean {
  const normalized = normalizeHostname(host);
  if (!normalized) return true;

  if (isLoopbackAddress(normalized)) return !allowLoopback;
  if (INTERNAL_HOSTNAMES.has(normalized)) return true;
  if (normalized.endsWith(".internal")) return true;

  return isPrivateOrLoopbackAddress(normalized);
}

/**
 * Resolve `host` and reject when any resulting address is internal.
 *
 * The synchronous host check cannot see where a DNS name points, so an
 * attacker-supplied `evil.test` with an A record of 169.254.169.254 would pass
 * it. Call this immediately before connecting, and again for every redirect
 * hop. Loopback is permitted, matching isBlockedInternalHost's default for
 * agent fetches.
 *
 * A name that genuinely does not resolve is not treated as a policy denial —
 * the connection will fail on its own, and failing closed there would block
 * hosts that only resolve through the system resolver's search domains. Every
 * other resolver failure does fail closed: a caller that swallowed them would
 * skip the only check that can see where a name points, which is trivially
 * forced by making this lookup fail while the connection's own lookup (served
 * from the OS cache) succeeds.
 */
export async function assertResolvedHostAllowed(host: string): Promise<void> {
  const normalized = normalizeHostname(host);
  if (!normalized) throw new Error("Refusing to connect: empty host");

  // Literal addresses are already covered by the synchronous check.
  if (isIP(normalized)) {
    if (isBlockedInternalHost(normalized, true)) {
      throw new Error(`Refusing to connect to internal address ${normalized}`);
    }
    return;
  }

  if (isBlockedInternalHost(normalized, true)) {
    throw new Error(`Refusing to connect to internal host ${normalized}`);
  }

  let addresses: string[];
  try {
    const { promises: dns } = await import("dns");
    const resolved = await dns.lookup(normalized, { all: true, verbatim: true });
    addresses = resolved.map((entry) => entry.address);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return;
    throw new Error(
      `Refusing to connect to ${normalized}: address resolution failed (${code || "unknown error"})`,
    );
  }

  for (const address of addresses) {
    if (isBlockedInternalHost(address, true)) {
      throw new Error(
        `Refusing to connect to ${normalized}: it resolves to internal address ${address}`,
      );
    }
  }
}
