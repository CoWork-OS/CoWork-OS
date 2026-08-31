import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliProfile {
  url: string;
  token?: string;
}

export interface CliConfig {
  defaultProfile: string;
  profiles: Record<string, CliProfile>;
}

export interface ResolvedConnection {
  profileName: string;
  url: string;
  token: string;
}

export const DEFAULT_CONTROL_PLANE_URL = "ws://127.0.0.1:18789";

export function getConfigPath(): string {
  const root = process.env.COWORK_CLI_CONFIG_DIR || path.join(os.homedir(), ".cowork-os", "cli");
  return path.join(root, "config.json");
}

export function createDefaultConfig(): CliConfig {
  return {
    defaultProfile: "local",
    profiles: {
      local: {
        url: DEFAULT_CONTROL_PLANE_URL,
      },
    },
  };
}

export function loadCliConfig(configPath = getConfigPath()): CliConfig {
  if (!fs.existsSync(configPath)) return createDefaultConfig();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return createDefaultConfig();
  }
}

export function saveCliConfig(config: CliConfig, configPath = getConfigPath()): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort only, especially on Windows.
  }
}

export function resolveConnection(options: {
  config?: CliConfig;
  profile?: string;
  url?: string;
  token?: string;
}): ResolvedConnection {
  const config = options.config ?? loadCliConfig();
  const profileName = options.profile || config.defaultProfile || "local";
  const profile = config.profiles[profileName] ||
    config.profiles.local || { url: DEFAULT_CONTROL_PLANE_URL };
  const url =
    options.url || process.env.COWORK_CONTROL_PLANE_URL || profile.url || DEFAULT_CONTROL_PLANE_URL;
  const token = options.token || process.env.COWORK_CONTROL_PLANE_TOKEN || profile.token || "";
  return { profileName, url, token };
}

export function upsertProfile(
  config: CliConfig,
  profileName: string,
  updates: Partial<CliProfile>,
  makeDefault: boolean,
): CliConfig {
  const name = profileName.trim() || "local";
  const current = config.profiles[name] || { url: DEFAULT_CONTROL_PLANE_URL };
  const next: CliConfig = {
    defaultProfile: makeDefault ? name : config.defaultProfile || name,
    profiles: {
      ...config.profiles,
      [name]: {
        ...current,
        ...updates,
        url: updates.url || current.url || DEFAULT_CONTROL_PLANE_URL,
      },
    },
  };
  return normalizeConfig(next);
}

export function removeProfileToken(config: CliConfig, profileName: string): CliConfig {
  const name = profileName.trim() || config.defaultProfile || "local";
  const profile = config.profiles[name];
  if (!profile) return normalizeConfig(config);
  const { token: _token, ...rest } = profile;
  return normalizeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [name]: rest,
    },
  });
}

function normalizeConfig(input: unknown): CliConfig {
  const raw = input && typeof input === "object" ? (input as Partial<CliConfig>) : {};
  const profilesRaw = raw.profiles && typeof raw.profiles === "object" ? raw.profiles : {};
  const profiles: Record<string, CliProfile> = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!value || typeof value !== "object") continue;
    const profile = value as Partial<CliProfile>;
    profiles[name] = {
      url:
        typeof profile.url === "string" && profile.url.trim()
          ? profile.url.trim()
          : DEFAULT_CONTROL_PLANE_URL,
      ...(typeof profile.token === "string" && profile.token.trim()
        ? { token: profile.token.trim() }
        : {}),
    };
  }
  if (!profiles.local) profiles.local = { url: DEFAULT_CONTROL_PLANE_URL };
  const defaultProfile =
    typeof raw.defaultProfile === "string" && profiles[raw.defaultProfile]
      ? raw.defaultProfile
      : "local";
  return { defaultProfile, profiles };
}
