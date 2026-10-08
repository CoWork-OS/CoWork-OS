/**
 * Receipt verification (plan §10).
 *
 * Upstream checks the signature, claims/envelope equality and optional grantId/user/pa/brand.
 * CoWork adds what upstream does not: `scopesUsed` must be within the grant used for the turn,
 * `ts` must be within a bounded skew of the local send window, and the result is associated with
 * the local turn (receipts carry no messageId or contextId). Cryptographic validity is kept apart
 * from whether the reported actions satisfy the task.
 */
import { createHash } from "node:crypto";
import type { PactEvidenceStatus } from "../../shared/pact";
import { JwsError, verifyCompactJws } from "./jws";
import type { PactJwksCache } from "./jwks-cache";
import type { PactTransport } from "./transport";
import {
  checkVerifiedReceiptPayload,
  ReceiptVerificationError,
} from "./upstream/client-delegation";
import type { Receipt, ReceiptClaims } from "./upstream/delegation";

export const RECEIPT_TIMESTAMP_SKEW_MS = 5 * 60_000;

export interface ReceiptExpectation {
  jwksUri: string;
  grantId: string | null;
  /** Business account the grant acts as, when CoWork knows it from an earlier receipt. */
  user: string | null;
  /** CoWork's issuer (the `pa` claim). */
  pa: string;
  /** The business's interface URL (the `brand` claim). */
  brand: string;
  grantScopes: readonly string[];
  sentAt: number;
  receivedAt: number;
}

export type ReceiptVerification =
  | {
      status: Extract<PactEvidenceStatus, "verified" | "needs_review">;
      claims: ReceiptClaims;
      issues: string[];
      digest: string;
    }
  | {
      status: Extract<PactEvidenceStatus, "invalid" | "unverifiable">;
      reason: string;
      claims?: ReceiptClaims;
      digest: string;
    };

export function receiptDigest(receipt: Receipt): string {
  return createHash("sha256").update(receipt.jws).digest("hex");
}

export async function verifyPactReceipt(
  receipt: Receipt,
  expected: ReceiptExpectation,
  jwks: PactJwksCache,
  transport: PactTransport,
): Promise<ReceiptVerification> {
  const digest = receiptDigest(receipt);
  let payload: unknown;
  try {
    const verified = await verifyCompactJws(receipt.jws, jwks.resolver(expected.jwksUri, transport));
    payload = JSON.parse(verified.payload.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof JwsError && error.code !== "unknown_key" && error.code !== "invalid_key") {
      return { status: "invalid", reason: `signature_${error.code}`, digest };
    }
    if (error instanceof JwsError) {
      return { status: "invalid", reason: "signing_key_unknown", digest };
    }
    // The key set could not be fetched: the receipt is not disproven, only unverifiable.
    return { status: "unverifiable", reason: "jwks_unavailable", digest };
  }

  let claims: ReceiptClaims;
  try {
    claims = checkVerifiedReceiptPayload(receipt, payload, {
      ...(expected.grantId ? { grantId: expected.grantId } : {}),
      ...(expected.user ? { user: expected.user } : {}),
      pa: expected.pa,
      brand: expected.brand,
    });
  } catch (error) {
    return {
      status: "invalid",
      reason:
        error instanceof ReceiptVerificationError
          ? error.message.replace(/^Receipt /, "").replace(/\s+/g, "_").toLowerCase()
          : "claims_invalid",
      digest,
    };
  }

  const issues: string[] = [];
  const allowed = new Set(expected.grantScopes);
  const outside = claims.scopesUsed.filter((scope) => !allowed.has(scope));
  if (outside.length > 0) issues.push(`scopes_outside_grant:${outside.join(",")}`);
  const ts = Date.parse(claims.ts);
  if (
    !Number.isFinite(ts) ||
    ts < expected.sentAt - RECEIPT_TIMESTAMP_SKEW_MS ||
    ts > expected.receivedAt + RECEIPT_TIMESTAMP_SKEW_MS
  ) {
    issues.push("timestamp_outside_send_window");
  }
  // A signed receipt with out-of-grant scopes or a stale timestamp is real evidence of
  // something unexpected: keep it, and block further effectful turns until reviewed.
  return {
    status: issues.length > 0 ? "needs_review" : "verified",
    claims,
    issues,
    digest,
  };
}
