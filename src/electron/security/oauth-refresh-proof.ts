import { createHash } from "node:crypto";
import type { MCPAuthConfig } from "../mcp/types";
const MAX_PROOFS = 128;
const MAX_CHAIN = 16;
const TTL_MS = 5 * 60_000;
const proofs: Array<{ from: string; to: string; expiresAt: number }> = [];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function credentialFingerprint(auth: MCPAuthConfig | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(auth ?? null)))
    .digest("hex");
}
function prune() {
  const now = Date.now();
  for (let i = proofs.length - 1; i >= 0; i--) if (proofs[i].expiresAt <= now) proofs.splice(i, 1);
}
/** Only successful trusted OAuth refresh adapters call this. No token/secret text is retained. */
export function recordOAuthRefresh(before: MCPAuthConfig, after: MCPAuthConfig): void {
  const required = (auth: MCPAuthConfig) =>
    [auth.refreshToken, auth.clientId, auth.tokenUrl].every(
      (value) => typeof value === "string" && Boolean(value.trim()),
    );
  if (!required(before) || !required(after)) return;
  if (
    before.type !== "bearer" ||
    after.type !== "bearer" ||
    (before.token !== undefined && (typeof before.token !== "string" || !before.token.trim())) ||
    typeof after.token !== "string" ||
    !after.token.trim() ||
    !before.refreshToken ||
    !after.refreshToken ||
    !before.clientId ||
    !before.tokenUrl ||
    before.clientId !== after.clientId ||
    before.clientSecret !== after.clientSecret ||
    before.tokenUrl !== after.tokenUrl
  )
    return;
  const rotating = new Set(["token", "refreshToken", "expiresAt"]);
  const fixed = (auth: MCPAuthConfig) =>
    Object.fromEntries(Object.entries(auth).filter(([key]) => !rotating.has(key)));
  if (JSON.stringify(canonical(fixed(before))) !== JSON.stringify(canonical(fixed(after)))) return;
  const from = credentialFingerprint(before),
    to = credentialFingerprint(after);
  if (from === to) return;
  prune();
  proofs.push({ from, to, expiresAt: Date.now() + TTL_MS });
  if (proofs.length > MAX_PROOFS) proofs.splice(0, proofs.length - MAX_PROOFS);
}
/** Directed, bounded proof chain. Manual edits, reverse rotations and old process receipts fail closed. */
export function isProvenOAuthRefresh(
  before: MCPAuthConfig | undefined,
  after: MCPAuthConfig | undefined,
): boolean {
  if (!before || !after) return false;
  const from = credentialFingerprint(before),
    target = credentialFingerprint(after);
  if (from === target) return true;
  prune();
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 0; depth < MAX_CHAIN && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier)
      for (const proof of proofs) {
        if (proof.from !== node || seen.has(proof.to)) continue;
        if (proof.to === target) return true;
        seen.add(proof.to);
        next.push(proof.to);
      }
    frontier = next;
  }
  return false;
}
