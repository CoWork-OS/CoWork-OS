import { randomBytes } from "crypto";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { createLogger } from "../../utils/logger";
import type { TeamsMeetingSettingsUpdate, TeamsMeetingSettingsView } from "../../../shared/types";

const logger = createLogger("TeamsMeetingSettings");

/**
 * Delegated scopes. The two *.Read.All scopes need tenant admin consent, and
 * a tenant admin must also allow Graph access to transcripts.
 */
export const TEAMS_MEETING_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.Read",
  "OnlineMeetings.Read",
  "OnlineMeetingTranscript.Read.All",
  "OnlineMeetingRecording.Read.All",
];

export interface TeamsMeetingSettings {
  enabled: boolean;
  clientId?: string;
  tenant?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  scopes?: string[];
  account?: string;
  userId?: string;
  pollIntervalMinutes: number;
  lookbackHours: number;
  notificationPublicUrl?: string;
  notificationPort: number;
  /** Secret echoed in every Graph notification; verified before acting on one. */
  clientState?: string;
}

export const TEAMS_MEETING_DEFAULTS: TeamsMeetingSettings = {
  enabled: false,
  pollIntervalMinutes: 15,
  lookbackHours: 48,
  notificationPort: 3984,
};

export function clampTeamsSettings(settings: TeamsMeetingSettings): TeamsMeetingSettings {
  return {
    ...settings,
    pollIntervalMinutes: Math.min(Math.max(Math.round(settings.pollIntervalMinutes || 15), 5), 240),
    lookbackHours: Math.min(Math.max(Math.round(settings.lookbackHours || 48), 1), 24 * 14),
    notificationPort: Math.min(
      Math.max(Math.round(settings.notificationPort || 3984), 1024),
      65535,
    ),
  };
}

export function toSettingsView(settings: TeamsMeetingSettings): TeamsMeetingSettingsView {
  return {
    enabled: settings.enabled,
    connected: Boolean(settings.refreshToken || settings.accessToken),
    clientId: settings.clientId,
    tenant: settings.tenant,
    pollIntervalMinutes: settings.pollIntervalMinutes,
    lookbackHours: settings.lookbackHours,
    notificationPublicUrl: settings.notificationPublicUrl,
    notificationPort: settings.notificationPort,
  };
}

interface StoredShape {
  teams?: Partial<TeamsMeetingSettings>;
}

export class TeamsMeetingSettingsManager {
  private static cached: TeamsMeetingSettings | null = null;

  static load(): TeamsMeetingSettings {
    if (this.cached) return this.cached;
    let settings = { ...TEAMS_MEETING_DEFAULTS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        const stored =
          SecureSettingsRepository.getInstance().load<StoredShape>("meeting-artifacts");
        if (stored?.teams) settings = { ...settings, ...stored.teams };
      }
    } catch (error) {
      logger.error("Failed to load Teams meeting settings:", error);
    }
    this.cached = clampTeamsSettings(settings);
    return this.cached;
  }

  static save(settings: TeamsMeetingSettings): TeamsMeetingSettings {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Secure settings storage is not initialized");
    }
    const next = clampTeamsSettings(settings);
    const repository = SecureSettingsRepository.getInstance();
    const stored = repository.load<StoredShape>("meeting-artifacts") || {};
    repository.save("meeting-artifacts", { ...stored, teams: next });
    this.cached = next;
    return next;
  }

  static applyUpdate(update: TeamsMeetingSettingsUpdate): TeamsMeetingSettings {
    const current = this.load();
    const next: TeamsMeetingSettings = { ...current };
    if (update.enabled !== undefined) next.enabled = update.enabled;
    if (update.clientId !== undefined) next.clientId = update.clientId.trim() || undefined;
    if (update.tenant !== undefined) next.tenant = update.tenant.trim() || undefined;
    if (update.pollIntervalMinutes !== undefined)
      next.pollIntervalMinutes = update.pollIntervalMinutes;
    if (update.lookbackHours !== undefined) next.lookbackHours = update.lookbackHours;
    if (update.notificationPort !== undefined) next.notificationPort = update.notificationPort;
    if (update.notificationPublicUrl !== undefined) {
      next.notificationPublicUrl =
        update.notificationPublicUrl.trim().replace(/\/+$/, "") || undefined;
    }
    if (!next.clientState) next.clientState = randomBytes(24).toString("base64url");
    return this.save(next);
  }

  /** Disconnect: forget tokens and identity but keep app registration details. */
  static clearTokens(): TeamsMeetingSettings {
    const current = this.load();
    return this.save({
      ...current,
      enabled: false,
      accessToken: undefined,
      refreshToken: undefined,
      tokenExpiresAt: undefined,
      scopes: undefined,
      account: undefined,
      userId: undefined,
      clientState: randomBytes(24).toString("base64url"),
    });
  }

  static clearCache(): void {
    this.cached = null;
  }
}
