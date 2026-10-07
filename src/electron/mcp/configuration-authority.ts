import type { MCPServerConfig } from "./types";
import { isProvenOAuthRefresh } from "../security/oauth-refresh-proof";
/** All noncredential configuration remains exact; only trusted OAuth receipt chains vary auth. */
export function mcpConfigurationCurrent(
  admitted: MCPServerConfig | undefined,
  current: MCPServerConfig | undefined,
): boolean {
  if (JSON.stringify(admitted ?? null) === JSON.stringify(current ?? null)) return true;
  if (!admitted || !current) return false;
  const { auth: before, ...fixedBefore } = admitted;
  const { auth: after, ...fixedAfter } = current;
  return (
    JSON.stringify(fixedBefore) === JSON.stringify(fixedAfter) &&
    isProvenOAuthRefresh(before, after)
  );
}
