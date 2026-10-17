/**
 * How CoWork identifies itself to model providers that list the client tools they
 * support (Z.ai and its mainland-China service, BigModel).
 */

const CLIENT_NAME = "CoWork-OS";

/** Providers whose requests carry the CoWork User-Agent. */
const IDENTIFIED_PROVIDERS = new Set<string>(["zai", "glm"]);

function getAppVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const version = electron?.app?.getVersion?.();
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // Not running inside Electron (tests, scripts).
  }
  const fromEnv = process.env.npm_package_version?.trim();
  return fromEnv || undefined;
}

/** `CoWork-OS/<version>`, or just `CoWork-OS` when the version is unknown. */
export function getCoworkUserAgent(version: string | undefined = getAppVersion()): string {
  return version ? `${CLIENT_NAME}/${version}` : CLIENT_NAME;
}

/** Extra request headers that identify CoWork to the given provider, if it asks for them. */
export function getClientIdentityHeaders(providerType: string): Record<string, string> | undefined {
  if (!IDENTIFIED_PROVIDERS.has(providerType)) return undefined;
  return { "User-Agent": getCoworkUserAgent() };
}
