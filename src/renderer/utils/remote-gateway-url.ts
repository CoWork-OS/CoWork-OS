const GATEWAY_PROTOCOLS = new Set(["ws:", "wss:", "http:", "https:"]);

/** Why a remote gateway URL cannot be used, or null when it can. */
export function remoteGatewayUrlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "Enter the device's gateway URL.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full gateway URL, such as wss://your-remote-host:18789.";
  }
  if (!GATEWAY_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    return "The gateway URL must start with ws:// or wss://.";
  }
  return null;
}
