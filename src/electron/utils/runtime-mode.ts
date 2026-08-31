const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function getEnvFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

export function hasArgFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return next;
  }

  // Support `--flag=value` as well.
  const prefix = flag + "=";
  const raw = process.argv.find((a) => typeof a === "string" && a.startsWith(prefix));
  if (!raw) return undefined;
  const v = raw.slice(prefix.length);
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

export function isHeadlessMode(): boolean {
  return hasArgFlag("--headless") || hasArgFlag("--no-ui") || getEnvFlag("COWORK_HEADLESS");
}

export function shouldEnableControlPlaneFromArgsOrEnv(): boolean {
  return hasArgFlag("--enable-control-plane") || getEnvFlag("COWORK_CONTROL_PLANE_ENABLE");
}

export function shouldPrintControlPlaneTokenFromArgsOrEnv(): boolean {
  return (
    hasArgFlag("--print-control-plane-token") || getEnvFlag("COWORK_PRINT_CONTROL_PLANE_TOKEN")
  );
}

export function shouldImportEnvSettingsFromArgsOrEnv(): boolean {
  return hasArgFlag("--import-env-settings") || getEnvFlag("COWORK_IMPORT_ENV_SETTINGS");
}

export function shouldUseManagedDeploymentModeFromEnv(): boolean {
  return getEnvFlag("COWORK_MANAGED_DEPLOYMENT");
}

export type ControlPlaneBindContext = "host" | "container";

export function getControlPlaneBindContextFromEnv(): ControlPlaneBindContext {
  const raw = String(process.env.COWORK_CONTROL_PLANE_BIND_CONTEXT || "")
    .trim()
    .toLowerCase();
  return raw === "container" ? "container" : "host";
}

export function shouldAllowInsecureControlPlanePublicBindFromEnv(): boolean {
  return getEnvFlag("COWORK_CONTROL_PLANE_ALLOW_INSECURE_PUBLIC_BIND");
}

export function shouldTrustControlPlaneProxyFromEnv(): boolean {
  return getEnvFlag("COWORK_CONTROL_PLANE_TRUST_PROXY");
}

export function getControlPlaneAllowedOriginsFromEnv(): string[] | undefined {
  const raw = process.env.COWORK_CONTROL_PLANE_ALLOWED_ORIGINS;
  if (typeof raw !== "string") return undefined;
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : [];
}

export type EnvSettingsImportMode = "merge" | "overwrite";

export function getEnvSettingsImportModeFromArgsOrEnv(): EnvSettingsImportMode {
  const raw = (
    getArgValue("--import-env-settings-mode") ||
    process.env.COWORK_IMPORT_ENV_SETTINGS_MODE ||
    ""
  )
    .trim()
    .toLowerCase();
  if (raw === "overwrite" || raw === "force" || raw === "replace") return "overwrite";
  return "merge";
}
