import type { PermissionSecurityContext, SensitiveSourceRef } from "./types";

function isUntrustedSource(source: SensitiveSourceRef): boolean {
  return source.trustLevel === "untrusted" || source.sourceKind !== "workspace_native";
}

function text(value: unknown, limit = 2048): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit)
    : "";
}

function sourceRef(value: unknown): SensitiveSourceRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as SensitiveSourceRef;
  if (!text(source.path) || !text(source.sourceKind)) return null;
  return source;
}

function hostname(value: unknown, bare = false): string {
  const candidate = text(value);
  if (!candidate) return "";
  try {
    return new URL(bare ? `https://${candidate}` : candidate).hostname;
  } catch {
    return "";
  }
}

const SOURCE_LABELS: Record<string, string> = {
  workspace_native: "Workspace file",
  user_imported_external: "Imported file",
  clipboard_or_drag_data: "Pasted or dropped content",
  channel_attachment: "Incoming attachment",
  unknown: "Source not identified",
};

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
  if (!target || !text(target.toolName, 120)) return null;

  const directSource = sourceRef(context?.directSource);
  const recent = Array.isArray(context?.recentSensitiveSources)
    ? context.recentSensitiveSources.map(sourceRef).filter((source) => source !== null)
    : [];
  const sources = [directSource, ...recent].filter((source) => source !== null);
  const untrustedSource = sources.find(isUntrustedSource);
  const source = untrustedSource || sources[0];
  const methodText = text(target.method, 16).toUpperCase();
  const method = /^[A-Z]+$/.test(methodText) ? ` ${methodText}` : "";
  const label = text(source?.sourceLabel, 160) || SOURCE_LABELS[source?.sourceKind ?? ""];
  const provider = text(target.provider, 120);
  // Never display URL credentials, query parameters, fragments, or arbitrary metadata.
  const destination =
    hostname(target.url) ||
    hostname(target.domain, true) ||
    hostname(provider) ||
    (/^[\p{L}\p{N}_. -]+$/u.test(provider) ? provider : "") ||
    "Destination not identified";
  return {
    source: untrustedSource
      ? `${untrustedSource === directSource ? "untrusted source" : "recent untrusted source"}${label ? ` (${label})` : ""}`
      : label || "Source not recorded",
    // A recent untrusted read is context, not proof that it is the outgoing file.
    data: text(directSource?.path) || "Data not identified",
    sideEffect: `${text(target.toolName, 120)}${method} export`,
    destination,
    includesUntrustedSource: Boolean(untrustedSource),
  };
}
