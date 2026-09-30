import type { WebDeploymentPolicy } from "../web/WebApplication";

/** Browser routes stay off until explicitly enabled by the host operator. */
export function isBrowserWebEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COWORK_WEB_ENABLED === "1";
}

export function webDeploymentFromEnv(env: NodeJS.ProcessEnv = process.env): WebDeploymentPolicy {
  const publicOrigin = env.COWORK_WEB_PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) return { mode: "loopback" };
  const trustedProxyAddresses = (env.COWORK_WEB_TRUSTED_PROXY_ADDRESSES || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  return { mode: "https-proxy", publicOrigin, trustedProxyAddresses };
}
