import { looksLikeSecretReference } from "../../../shared/secret-references";
import { redactResolvedSecrets } from "../../security/secret-references/known-secret-values";
import {
  getSecretReferenceResolver,
  type SecretReferenceResolver,
} from "../../security/secret-references/resolver";
import type { MCPCallResult, MCPServerConfig } from "../types";

function hasReference(record: Record<string, string> | undefined): boolean {
  return Object.values(record || {}).some((value) => looksLikeSecretReference(value));
}

/**
 * The config a transport connects with: `env` and `headers` values written as vault references
 * replaced by what they point to. The stored config keeps the references.
 */
export async function resolveMcpServerSecrets(
  config: MCPServerConfig,
  resolver: Pick<SecretReferenceResolver, "resolveRecord"> = getSecretReferenceResolver(),
): Promise<MCPServerConfig> {
  if (!hasReference(config.env) && !hasReference(config.headers)) return config;
  const [env, headers] = await Promise.all([
    resolver.resolveRecord(config.env),
    resolver.resolveRecord(config.headers),
  ]);
  return { ...config, env, headers };
}

/** Mask resolved vault values a server echoes back (for example by printing its environment). */
export function redactMcpCallResult(result: MCPCallResult): MCPCallResult {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((item) => {
    if (item?.type !== "text" || typeof item.text !== "string") return item;
    const text = redactResolvedSecrets(item.text);
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });
  let structuredContent = result.structuredContent;
  if (structuredContent !== undefined) {
    const serialized = JSON.stringify(structuredContent);
    const redacted =
      typeof serialized === "string" ? redactResolvedSecrets(serialized) : serialized;
    if (redacted !== serialized) {
      changed = true;
      structuredContent = JSON.parse(redacted);
    }
  }
  return changed ? { ...result, content, structuredContent } : result;
}
