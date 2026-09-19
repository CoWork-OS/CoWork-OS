/**
 * Detached release-artifact signatures.
 *
 * Why this exists: the desktop build is not code-signed on either shipped
 * platform (macOS packages ad-hoc via COWORK_MAC_UNSIGNED=1, and Windows has no
 * `publisherName`, which makes electron-updater's own `verifySignature` return
 * early without checking anything). That leaves the `sha512` in `latest.yml` as
 * the only integrity control — and that file is uploaded to the same GitHub
 * release as the artifact it describes, so anyone able to replace one can
 * replace both.
 *
 * This module verifies an Ed25519 signature over the downloaded artifact using
 * a public key embedded in the app, so tampering requires the private key
 * rather than release-asset write access. It uses only Node's crypto — no
 * external signing tool to install.
 *
 * Enforcement is conditional on a public key being configured: see
 * RELEASE_SIGNING_PUBLIC_KEY. Until a key is generated (scripts/release/
 * generate-signing-key.mjs) this is inert and the updater behaves as before,
 * logging a warning. Once the key is set, an artifact whose signature is
 * missing or invalid is refused.
 */
import { createHash, verify as cryptoVerify } from "crypto";
import { readFile } from "fs/promises";
import { createLogger } from "../utils/logger";
import { RELEASE_SIGNING_PUBLIC_KEY } from "./release-signing-key";

const log = createLogger("ReleaseSignature");

export function isReleaseSignatureEnforced(): boolean {
  return RELEASE_SIGNING_PUBLIC_KEY.trim().length > 0;
}

/**
 * Three distinct outcomes, deliberately not collapsed into a boolean:
 *
 * - `verified`  — a signature was checked and it matched.
 * - `unverified` — nothing was checked (no key embedded in this build).
 * - `failed`    — a check ran and the artifact did not pass.
 *
 * `unverified` must never read as success. A boolean `verified: true` for the
 * no-key case let every caller treat "we did not look" as "it is fine".
 */
export type ReleaseSignatureStatus = "verified" | "unverified" | "failed";

export interface ReleaseSignatureResult {
  status: ReleaseSignatureStatus;
  reason?: string;
}

/**
 * Verify `signatureBase64` against the bytes of `artifactPath`.
 *
 * Returns `status: "unverified"` when enforcement is off, so callers can log
 * the gap explicitly rather than inferring it from a success value.
 */
export async function verifyReleaseArtifact(
  artifactPath: string,
  signatureBase64: string | undefined,
): Promise<ReleaseSignatureResult> {
  if (!isReleaseSignatureEnforced()) {
    return { status: "unverified", reason: "no_public_key_configured" };
  }

  if (!signatureBase64 || signatureBase64.trim().length === 0) {
    return { status: "failed", reason: "signature_missing" };
  }

  let artifact: Buffer;
  try {
    artifact = await readFile(artifactPath);
  } catch (error) {
    return {
      status: "failed",
      reason: `artifact_unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const ok = cryptoVerify(
      null,
      artifact,
      RELEASE_SIGNING_PUBLIC_KEY,
      Buffer.from(signatureBase64.trim(), "base64"),
    );
    if (!ok) {
      log.warn(
        `Release signature did not verify for ${artifactPath} (sha256 ${createHash("sha256")
          .update(artifact)
          .digest("hex")
          .slice(0, 16)})`,
      );
      return { status: "failed", reason: "signature_invalid" };
    }
    return { status: "verified" };
  } catch (error) {
    return {
      status: "failed",
      reason: `verify_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Fetch the detached signature published alongside an artifact.
 * Returns undefined when the release has no `.sig` asset.
 */
export async function fetchArtifactSignature(artifactUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${artifactUrl}.sig`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    return (await response.text()).trim();
  } catch {
    return undefined;
  }
}
