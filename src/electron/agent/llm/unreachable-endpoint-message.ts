/**
 * A readable reason for a request that never reached the model server.
 *
 * Node's fetch rejects with a TypeError whose whole message is "fetch failed" and keeps the
 * reason in `cause.code`, so a wrong port or host showed only "fetch failed" in Settings.
 */
const REASONS: Record<string, string> = {
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was reset",
  ENOTFOUND: "the host name was not found",
  EAI_AGAIN: "the host name could not be looked up",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  EHOSTUNREACH: "the host is unreachable",
  ENETUNREACH: "the network is unreachable",
  CERT_HAS_EXPIRED: "its TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "its TLS certificate is not trusted",
  SELF_SIGNED_CERT_IN_CHAIN: "its TLS certificate is not trusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its TLS certificate is not trusted",
};

/** The message for a network failure reaching `url`, or undefined for any other error. */
export function unreachableEndpointMessage(error: unknown, url: string): string | undefined {
  const failure = error as { message?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = String(failure?.cause?.code || failure?.code || "");
  const reason = REASONS[code];
  const fetchFailed = /^fetch failed$/i.test(String(failure?.message ?? "").trim());
  if (!reason && !fetchFailed) return undefined;
  let where = url;
  try {
    // The host alone: no path, query or credentials from the configured URL.
    where = new URL(url).host || url;
  } catch {
    // Keep the configured text when it is not a URL.
  }
  return `Couldn't reach ${where}${reason ? `: ${reason}` : ""}. Check that the server is running and the base URL is correct.`;
}
