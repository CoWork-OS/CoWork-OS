import * as path from "path";
import { createLogger } from "../utils/logger";
import { startMicrosoftGraphOAuth } from "../utils/microsoft-email-oauth";
import type {
  MeetingArtifactProvider,
  MeetingArtifactSummary,
  TeamsMeetingSettingsUpdate,
  TeamsMeetingSettingsView,
  TeamsMeetingStatus,
} from "../../shared/types";
import { MeetingArtifactStore } from "./artifact-store";
import { TeamsArtifactPipeline } from "./teams/teams-artifact-pipeline";
import { GRAPH_BASE, TeamsGraphClient } from "./teams/teams-graph-client";
import {
  TEAMS_MEETING_SCOPES,
  TeamsMeetingSettingsManager,
  toSettingsView,
} from "./teams/teams-meeting-settings";

const logger = createLogger("MeetingArtifactsService");

export class MeetingArtifactsService {
  private static instance: MeetingArtifactsService | null = null;

  readonly store: MeetingArtifactStore;
  private readonly teams: TeamsArtifactPipeline;
  private readonly listeners = new Set<() => void>();

  private constructor(rootDir: string) {
    this.store = new MeetingArtifactStore(path.join(rootDir, "artifacts"));
    const client = new TeamsGraphClient({
      loadTokens: () => TeamsMeetingSettingsManager.load(),
      saveTokens: (tokens) =>
        TeamsMeetingSettingsManager.save({ ...TeamsMeetingSettingsManager.load(), ...tokens }),
    });
    this.teams = new TeamsArtifactPipeline({
      stateDir: path.join(rootDir, "teams-state"),
      store: this.store,
      client,
      loadSettings: () => TeamsMeetingSettingsManager.load(),
      onChange: () => this.emitChange(),
    });
  }

  static initialize(rootDir: string): MeetingArtifactsService {
    if (!this.instance) {
      this.instance = new MeetingArtifactsService(rootDir);
      void this.instance.teams
        .start()
        .catch((error) => logger.error("Teams pipeline start failed:", error));
    }
    return this.instance;
  }

  static getInstance(): MeetingArtifactsService | null {
    return this.instance;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Teams ─────────────────────────────────────────────

  getTeamsSettings(): TeamsMeetingSettingsView {
    return toSettingsView(TeamsMeetingSettingsManager.load());
  }

  getTeamsStatus(): TeamsMeetingStatus {
    return this.teams.status();
  }

  async updateTeamsSettings(update: TeamsMeetingSettingsUpdate): Promise<TeamsMeetingSettingsView> {
    TeamsMeetingSettingsManager.applyUpdate(update);
    await this.restartTeams();
    return this.getTeamsSettings();
  }

  async connectTeams(input: { clientId: string; tenant?: string }): Promise<TeamsMeetingStatus> {
    const clientId = input.clientId.trim();
    if (!clientId) throw new Error("An Azure app (client) ID is required");
    const result = await startMicrosoftGraphOAuth({
      clientId,
      tenant: input.tenant,
      scopes: TEAMS_MEETING_SCOPES,
      prompt: "select_account",
    });
    const me = (await fetch(`${GRAPH_BASE}/me?$select=id,mail,userPrincipalName,displayName`, {
      headers: { Authorization: `Bearer ${result.accessToken}` },
    }).then((response) => (response.ok ? response.json() : null))) as {
      id?: string;
      mail?: string;
      userPrincipalName?: string;
    } | null;
    if (!me?.id)
      throw new Error("Connected, but Microsoft Graph did not return the signed-in user");

    const current = TeamsMeetingSettingsManager.applyUpdate({
      clientId,
      tenant: input.tenant ?? "",
      enabled: true,
    });
    TeamsMeetingSettingsManager.save({
      ...current,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tokenExpiresAt: Date.now() + (result.expiresIn ?? 3600) * 1000,
      scopes: result.scopes || TEAMS_MEETING_SCOPES,
      account: me.mail || me.userPrincipalName,
      userId: me.id,
    });
    await this.restartTeams();
    return this.teams.syncNow();
  }

  async disconnectTeams(): Promise<void> {
    await this.teams.stop({ deleteSubscription: true });
    TeamsMeetingSettingsManager.clearTokens();
    this.teams.reset();
    this.emitChange();
  }

  syncTeamsNow(): Promise<TeamsMeetingStatus> {
    return this.teams.syncNow();
  }

  retryFailedTeamsJobs(): TeamsMeetingStatus {
    this.teams.retryFailedJobs();
    return this.teams.status();
  }

  downloadRecording(artifactId: string, recordingId: string): Promise<string> {
    const artifact = this.store.get(artifactId);
    if (artifact?.provider !== "teams") {
      return Promise.reject(new Error("Recordings can only be downloaded for Teams meetings"));
    }
    return this.teams.downloadRecording(artifactId, recordingId);
  }

  // ── Artifacts ─────────────────────────────────────────

  listArtifacts(
    options: { provider?: MeetingArtifactProvider; limit?: number } = {},
  ): MeetingArtifactSummary[] {
    return this.store.list(options);
  }

  getArtifact(id: string): { summary: MeetingArtifactSummary; markdown: string } | null {
    const summary = this.store.get(id);
    const markdown = this.store.readMarkdown(id);
    return summary && markdown !== null ? { summary, markdown } : null;
  }

  async shutdown(): Promise<void> {
    await this.teams.stop();
  }

  private async restartTeams(): Promise<void> {
    await this.teams.stop();
    await this.teams.start();
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("Meeting artifact listener failed:", error);
      }
    }
  }
}
