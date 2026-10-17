import * as tls from "node:tls";

interface NodeTlsTrustApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certificates: readonly string[]) => void;
}

interface NodeTlsTrustOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  tlsApi?: NodeTlsTrustApi;
}

export type NodeTlsTrustResult =
  | { status: "configured"; addedCertificates: number }
  | { status: "unchanged" }
  | { status: "unavailable" };

function hasExplicitTrustConfiguration(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
): boolean {
  const options = [...execArgv, env.NODE_OPTIONS || ""].join(" ");
  // Preserve the caller's CA selection, including an explicit system-store opt-out.
  if (/(?:^|[\s"'])--(?:no-)?use-(?:system|bundled|openssl)-ca(?:[\s="']|$)/.test(options)) {
    return true;
  }
  return [
    env.NODE_EXTRA_CA_CERTS,
    env.SSL_CERT_FILE,
    env.SSL_CERT_DIR,
    env.NODE_USE_SYSTEM_CA,
  ].some((value) => Boolean(value?.trim()));
}

/**
 * Electron's Chromium certificate switches do not configure Node fetch/HTTPS.
 * Add macOS-trusted roots before loading providers, without replacing existing
 * roots, changing environment variables, or relaxing certificate verification.
 * Node's default CA list is thread-local; call this in each network entrypoint.
 */
export function configureNodeTlsTrust({
  platform = process.platform,
  env = process.env,
  execArgv = process.execArgv,
  tlsApi = tls,
}: NodeTlsTrustOptions = {}): NodeTlsTrustResult {
  if (
    platform !== "darwin" ||
    env.COWORK_DEV_USE_SYSTEM_CA?.trim() === "0" ||
    hasExplicitTrustConfiguration(env, execArgv)
  ) {
    return { status: "unchanged" };
  }

  const { getCACertificates, setDefaultCACertificates } = tlsApi;
  if (!getCACertificates || !setDefaultCACertificates) {
    return { status: "unavailable" };
  }

  try {
    const current = getCACertificates("default");
    const combined = new Set([...current, ...getCACertificates("system")]);
    const addedCertificates = combined.size - new Set(current).size;
    if (addedCertificates === 0) return { status: "unchanged" };
    setDefaultCACertificates([...combined]);
    return { status: "configured", addedCertificates };
  } catch {
    // Older/unsupported runtimes keep their existing trust behavior. Never use an
    // unverified connection as a fallback, or leak certificate data into logs.
    return { status: "unavailable" };
  }
}
