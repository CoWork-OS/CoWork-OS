import type { PermissionSecurityContext, SensitiveSourceRef } from "./types";

function isUntrustedSource(source: SensitiveSourceRef): boolean {
  return source.trustLevel === "untrusted" || source.sourceKind !== "workspace_native";
}

export interface ExportRiskChain {
  source: string;
  data: string;
  sideEffect: string;
  destination: string;
  includesUntrustedSource: boolean;
}

/** Build a visible, secret-free explanation of the export risk path. */
export function buildExportRiskChain(
  context: PermissionSecurityContext | null | undefined,
): ExportRiskChain | null {
  const target = context?.exportTarget;
  if (!target) return null;

  const sources = [context?.directSource, ...(context?.recentSensitiveSources || [])].filter(
    (source): source is SensitiveSourceRef => Boolean(source),
  );
  const untrustedSource = sources.find(isUntrustedSource);
  const source = untrustedSource || sources[0];
  const method = target.method ? ` ${target.method}` : "";
  return {
    source: untrustedSource
      ? `untrusted source${untrustedSource.sourceLabel ? ` (${untrustedSource.sourceLabel})` : ""}`
      : source?.sourceLabel || source?.sourceKind || "local source",
    data: source?.path || "private/local data",
    sideEffect: `${target.toolName}${method} export`,
    destination: target.domain || target.provider || "external destination",
    includesUntrustedSource: Boolean(untrustedSource),
  };
}
