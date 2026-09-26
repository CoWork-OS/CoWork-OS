import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { createLogger } from "../../utils/logger";
import { timingSafeEqualString } from "../../utils/webhook-auth";
import type {
  MeetingArtifactSummary,
  TeamsMeetingStatus,
  TeamsMeetingSyncState,
} from "../../../shared/types";
import { MeetingArtifactStore, artifactIdFor } from "../artifact-store";
import { parseWebVtt, renderMeetingMarkdown } from "../vtt";
import { TeamsGraphClient, TeamsGraphError } from "./teams-graph-client";
import type { TeamsMeetingSettings } from "./teams-meeting-settings";

const logger = createLogger("TeamsArtifactPipeline");

const MAX_JOB_ATTEMPTS = 6;
/** Transcripts can appear a few minutes after a meeting ends. */
const MEETING_END_GRACE_MS = 5 * 60 * 1000;
/** Recheck a join URL that did not resolve (e.g. the user was not the organizer) daily. */
const UNRESOLVED_MEETING_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Graph caps transcript subscriptions at 3 days; stay safely under it. */
const SUBSCRIPTION_LIFETIME_MS = 70 * 60 * 60 * 1000;
const SUBSCRIPTION_RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;
const SUBSCRIPTION_CHECK_MS = 60 * 60 * 1000;
const NOTIFICATION_DEBOUNCE_MS = 60 * 1000;
const MAX_NOTIFICATION_BODY = 256 * 1024;
const MAX_RECORDING_BYTES = 4 * 1024 * 1024 * 1024;
const NOTIFICATION_PATH = "/teams-meetings/notifications";
const LIFECYCLE_PATH = "/teams-meetings/lifecycle";

interface CalendarEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string };
}

interface MeetingInfo {
  subject?: string;
  startTime?: string;
  endTime?: string;
  organizer?: string;
  attendees?: string[];
  joinUrl: string;
}

interface TranscriptJob {
  key: string;
  meetingId: string;
  transcriptId: string;
  meeting: MeetingInfo;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  failed?: boolean;
}

interface SubscriptionState {
  id: string;
  expiresAt: string;
  lastRenewedAt?: string;
  lastNotificationAt?: string;
}

interface PipelineState {
  version: 1;
  processed: Record<string, { artifactId: string; at: number }>;
  jobs: TranscriptJob[];
  meetingIds: Record<string, { meetingId: string | null; checkedAt: number }>;
  lastSyncAt?: number;
  lastError?: string;
  state: TeamsMeetingSyncState;
  subscription?: SubscriptionState;
  subscriptionError?: string;
}

function emptyState(): PipelineState {
  return { version: 1, processed: {}, jobs: [], meetingIds: {}, state: "idle" };
}

function toUtcIso(value?: { dateTime?: string; timeZone?: string }): string | undefined {
  if (!value?.dateTime) return undefined;
  // calendarView is requested in UTC (Prefer: outlook.timezone="UTC").
  const raw = /Z|[+-]\d{2}:\d{2}$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function odataString(value: string): string {
  return value.replace(/'/g, "''");
}

export interface TeamsArtifactPipelineDeps {
  stateDir: string;
  store: MeetingArtifactStore;
  client: TeamsGraphClient;
  loadSettings: () => TeamsMeetingSettings;
  now?: () => number;
  onChange?: () => void;
}

/**
 * Discovers Teams meeting transcripts and turns them into local artifacts.
 *
 * Polling the user's calendar is the source of truth: it needs no public URL
 * and recovers from anything missed. When a public notification URL is set, a
 * Graph subscription only accelerates discovery; it is renewed well before
 * its three-day maximum, and lifecycle events (reauthorization, removal,
 * missed notifications) all fall back to a discovery pass.
 */
export class TeamsArtifactPipeline {
  private state: PipelineState = emptyState();
  private readonly statePath: string;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionTimer: ReturnType<typeof setInterval> | null = null;
  private notificationTimer: ReturnType<typeof setTimeout> | null = null;
  private server: http.Server | null = null;
  private running: Promise<void> | null = null;
  private nextSyncAt?: number;
  private rejectedNotifications = 0;
  private readonly now: () => number;

  constructor(private readonly deps: TeamsArtifactPipelineDeps) {
    this.statePath = path.join(deps.stateDir, "state.json");
    this.now = deps.now ?? Date.now;
    this.load();
  }

  // ── Lifecycle ─────────────────────────────────────────

  async start(): Promise<void> {
    const settings = this.deps.loadSettings();
    if (!settings.enabled || !this.isConnected(settings)) {
      this.setState("disconnected");
      return;
    }
    if (this.state.state === "disconnected") this.setState("idle");
    this.scheduleSync(0);
    if (settings.notificationPublicUrl) {
      try {
        await this.startNotificationServer(settings.notificationPort);
        await this.ensureSubscription();
      } catch (error) {
        this.recordSubscriptionError(error);
      }
      this.subscriptionTimer = setInterval(() => {
        void this.ensureSubscription().catch((error) => this.recordSubscriptionError(error));
      }, SUBSCRIPTION_CHECK_MS);
      this.subscriptionTimer.unref?.();
    }
  }

  async stop(options: { deleteSubscription?: boolean } = {}): Promise<void> {
    for (const timer of [this.pollTimer, this.notificationTimer]) if (timer) clearTimeout(timer);
    if (this.subscriptionTimer) clearInterval(this.subscriptionTimer);
    this.pollTimer = this.notificationTimer = this.subscriptionTimer = null;
    if (options.deleteSubscription && this.state.subscription) {
      await this.deps.client
        .json("DELETE", `/subscriptions/${encodeURIComponent(this.state.subscription.id)}`)
        .catch((error) => logger.warn("Failed to delete Teams subscription:", error));
      this.state.subscription = undefined;
      this.save();
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.running?.catch(() => undefined);
  }

  /** Forget sync state (after disconnecting); artifacts on disk are kept. */
  reset(): void {
    this.state = { ...emptyState(), state: "disconnected" };
    this.save();
  }

  status(): TeamsMeetingStatus {
    const settings = this.deps.loadSettings();
    const pending = this.state.jobs.filter((job) => !job.failed);
    return {
      state: this.isConnected(settings) ? this.state.state : "disconnected",
      account: settings.account,
      lastSyncAt: this.state.lastSyncAt ? new Date(this.state.lastSyncAt).toISOString() : undefined,
      nextSyncAt: this.nextSyncAt ? new Date(this.nextSyncAt).toISOString() : undefined,
      lastError: this.state.lastError,
      pendingJobs: pending.length,
      failedJobs: this.state.jobs
        .filter((job) => job.failed)
        .map((job) => ({ key: job.key, attempts: job.attempts, lastError: job.lastError })),
      artifactCount: this.deps.store.list({ provider: "teams" }).length,
      subscription: this.state.subscription,
      subscriptionError: this.state.subscriptionError,
    };
  }

  /** Run one discovery + processing pass now (also used by the poll timer). */
  async syncNow(): Promise<TeamsMeetingStatus> {
    if (!this.running) {
      this.running = this.runSync().finally(() => {
        this.running = null;
      });
    }
    await this.running;
    return this.status();
  }

  retryFailedJobs(): void {
    for (const job of this.state.jobs) {
      if (job.failed) {
        job.failed = false;
        job.attempts = 0;
        job.nextAttemptAt = undefined;
      }
    }
    this.save();
    this.scheduleSync(0);
  }

  // ── Sync ──────────────────────────────────────────────

  private scheduleSync(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.nextSyncAt = this.now() + delayMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.syncNow().finally(() => {
        const minutes = this.deps.loadSettings().pollIntervalMinutes;
        if (this.deps.loadSettings().enabled) this.scheduleSync(minutes * 60_000);
      });
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private async runSync(): Promise<void> {
    const settings = this.deps.loadSettings();
    if (!this.isConnected(settings)) {
      this.setState("disconnected");
      return;
    }
    this.setState("syncing");
    try {
      await this.discover(settings);
      await this.processJobs();
      this.state.lastSyncAt = this.now();
      this.state.lastError = undefined;
      this.setState("idle");
    } catch (error) {
      this.recordSyncError(error);
    } finally {
      this.save();
    }
  }

  private recordSyncError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state.lastError = message;
    if (error instanceof TeamsGraphError && error.kind === "auth_expired") {
      this.setState("auth_expired");
    } else if (error instanceof TeamsGraphError && error.kind === "tenant_blocked") {
      this.setState("blocked");
    } else {
      this.setState("error");
    }
    logger.warn(`Teams meeting sync failed: ${message}`);
  }

  private async discover(settings: TeamsMeetingSettings): Promise<void> {
    const end = new Date(this.now());
    const start = new Date(end.getTime() - settings.lookbackHours * 60 * 60 * 1000);
    const query = new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $select:
        "id,subject,start,end,organizer,attendees,isOnlineMeeting,onlineMeetingProvider,onlineMeeting",
      $top: "100",
    });
    const events = await this.deps.client
      .json<{ value?: CalendarEvent[]; "@odata.nextLink"?: string }>(
        "GET",
        `/me/calendarView?${query.toString()}`,
        undefined,
        { Prefer: 'outlook.timezone="UTC"' },
      )
      .then(async (first) => {
        const all = [...(first.value || [])];
        if (first["@odata.nextLink"]) {
          all.push(...(await this.deps.client.collect<CalendarEvent>(first["@odata.nextLink"], 4)));
        }
        return all;
      });

    for (const event of events) {
      const joinUrl = event.onlineMeeting?.joinUrl;
      const endTime = toUtcIso(event.end);
      if (
        !event.isOnlineMeeting ||
        event.onlineMeetingProvider !== "teamsForBusiness" ||
        !joinUrl ||
        !endTime ||
        Date.parse(endTime) > this.now() - MEETING_END_GRACE_MS
      ) {
        continue;
      }
      const meetingId = await this.resolveMeetingId(joinUrl);
      if (!meetingId) continue;
      const meeting: MeetingInfo = {
        subject: event.subject,
        startTime: toUtcIso(event.start),
        endTime,
        organizer: event.organizer?.emailAddress?.name || event.organizer?.emailAddress?.address,
        attendees: (event.attendees || [])
          .map((attendee) => attendee.emailAddress?.name || attendee.emailAddress?.address || "")
          .filter(Boolean),
        joinUrl,
      };
      await this.enqueueTranscripts(meetingId, meeting);
    }
  }

  private async resolveMeetingId(joinUrl: string): Promise<string | null> {
    const cached = this.state.meetingIds[joinUrl];
    if (cached?.meetingId) return cached.meetingId;
    if (cached && this.now() - cached.checkedAt < UNRESOLVED_MEETING_RECHECK_MS) return null;
    let meetingId: string | null = null;
    try {
      const result = await this.deps.client.json<{ value?: Array<{ id?: string }> }>(
        "GET",
        `/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${odataString(joinUrl)}'`)}`,
      );
      meetingId = result.value?.[0]?.id || null;
    } catch (error) {
      if (!(error instanceof TeamsGraphError) || !["forbidden", "not_found"].includes(error.kind)) {
        throw error;
      }
    }
    this.state.meetingIds[joinUrl] = { meetingId, checkedAt: this.now() };
    return meetingId;
  }

  private async enqueueTranscripts(meetingId: string, meeting: MeetingInfo): Promise<void> {
    let transcripts: Array<{ id?: string }> = [];
    try {
      transcripts = await this.deps.client.collect(
        `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
      );
    } catch (error) {
      // Only the organizer can read transcripts with delegated access.
      if (error instanceof TeamsGraphError && ["forbidden", "not_found"].includes(error.kind))
        return;
      throw error;
    }
    for (const transcript of transcripts) {
      if (!transcript.id) continue;
      const key = `${meetingId}|${transcript.id}`;
      if (this.state.processed[key] || this.state.jobs.some((job) => job.key === key)) continue;
      this.state.jobs.push({ key, meetingId, transcriptId: transcript.id, meeting, attempts: 0 });
    }
  }

  private async processJobs(): Promise<void> {
    for (const job of [...this.state.jobs]) {
      if (job.failed || (job.nextAttemptAt && job.nextAttemptAt > this.now())) continue;
      try {
        const artifact = await this.buildArtifact(job);
        this.state.processed[job.key] = { artifactId: artifact.id, at: this.now() };
        this.state.jobs = this.state.jobs.filter((entry) => entry.key !== job.key);
        this.deps.onChange?.();
      } catch (error) {
        if (error instanceof TeamsGraphError) {
          if (error.kind === "auth_expired" || error.kind === "tenant_blocked") throw error;
          if (error.kind === "not_found") {
            // The transcript was deleted before we fetched it.
            this.state.jobs = this.state.jobs.filter((entry) => entry.key !== job.key);
            continue;
          }
        }
        job.attempts += 1;
        job.lastError = error instanceof Error ? error.message : String(error);
        if (job.attempts >= MAX_JOB_ATTEMPTS) {
          job.failed = true;
        } else {
          job.nextAttemptAt = this.now() + Math.min(60_000 * 2 ** (job.attempts - 1), 6 * 3600_000);
        }
      }
      this.save();
    }
  }

  private async buildArtifact(job: TranscriptJob): Promise<MeetingArtifactSummary> {
    const base = `/me/onlineMeetings/${encodeURIComponent(job.meetingId)}`;
    const vtt = await this.deps.client.text(
      `${base}/transcripts/${encodeURIComponent(job.transcriptId)}/content?$format=text/vtt`,
      "text/vtt",
    );
    let recordings: Array<{ id?: string; createdDateTime?: string }> = [];
    try {
      recordings = await this.deps.client.collect(`${base}/recordings`, 2);
    } catch (error) {
      // Recording metadata is optional; the transcript is the artifact.
      if (
        error instanceof TeamsGraphError &&
        (error.kind === "auth_expired" || error.kind === "tenant_blocked")
      ) {
        throw error;
      }
    }
    const cues = parseWebVtt(vtt);
    const title = job.meeting.subject?.trim() || "Teams meeting";
    const retrievedAt = new Date(this.now()).toISOString();
    const recordingList = recordings
      .filter((recording): recording is { id: string; createdDateTime?: string } =>
        Boolean(recording.id),
      )
      .map((recording) => ({ id: recording.id, createdDateTime: recording.createdDateTime }));
    const markdown = renderMeetingMarkdown({
      title,
      provider: "Microsoft Teams",
      organizer: job.meeting.organizer,
      startTime: job.meeting.startTime,
      endTime: job.meeting.endTime,
      joinUrl: job.meeting.joinUrl,
      attendees: job.meeting.attendees,
      recordings: recordingList,
      cues,
      retrievedAt,
    });
    return this.deps.store.write(
      {
        id: artifactIdFor("teams", job.key),
        provider: "teams",
        title,
        organizer: job.meeting.organizer,
        startTime: job.meeting.startTime,
        endTime: job.meeting.endTime,
        joinUrl: job.meeting.joinUrl,
        retrievedAt,
        cueCount: cues.length,
        recordings: recordingList,
        sourceRef: { meetingId: job.meetingId, transcriptId: job.transcriptId },
      },
      markdown,
    );
  }

  // ── Recordings (on demand only) ───────────────────────

  async downloadRecording(artifactId: string, recordingId: string): Promise<string> {
    const artifact = this.deps.store.get(artifactId);
    if (!artifact || artifact.provider !== "teams")
      throw new Error("Unknown Teams meeting artifact");
    const recording = artifact.recordings.find((entry) => entry.id === recordingId);
    if (!recording) throw new Error("This meeting has no such recording");
    if (recording.localPath && fs.existsSync(recording.localPath)) return recording.localPath;

    const meetingId = artifact.sourceRef.meetingId;
    const response = await this.deps.client.raw(
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}/content`,
      "video/mp4",
    );
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
      throw new Error("The recording is larger than 4 GB; download it from Teams instead.");
    }
    if (!response.body) throw new Error("Microsoft Graph returned an empty recording");
    const target = this.deps.store.recordingPath(artifactId, recordingId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.partial`;
    let written = 0;
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream);
    source.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > MAX_RECORDING_BYTES) source.destroy(new Error("Recording exceeds 4 GB"));
    });
    try {
      await pipeline(source, fs.createWriteStream(tmp, { mode: 0o600 }));
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    this.deps.store.update(artifactId, {
      recordings: artifact.recordings.map((entry) =>
        entry.id === recordingId ? { ...entry, localPath: target } : entry,
      ),
    });
    this.deps.onChange?.();
    return target;
  }

  // ── Change notifications (optional accelerator) ───────

  private async ensureSubscription(): Promise<void> {
    const settings = this.deps.loadSettings();
    if (!settings.notificationPublicUrl || !settings.userId || !settings.clientState) return;
    const current = this.state.subscription;
    const expiration = new Date(this.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
    if (current) {
      if (Date.parse(current.expiresAt) - this.now() > SUBSCRIPTION_RENEW_BEFORE_MS) return;
      try {
        const renewed = await this.deps.client.json<{ expirationDateTime?: string }>(
          "PATCH",
          `/subscriptions/${encodeURIComponent(current.id)}`,
          { expirationDateTime: expiration },
        );
        this.state.subscription = {
          ...current,
          expiresAt: renewed?.expirationDateTime || expiration,
          lastRenewedAt: new Date(this.now()).toISOString(),
        };
        this.state.subscriptionError = undefined;
        this.save();
        return;
      } catch (error) {
        if (!(error instanceof TeamsGraphError) || error.kind !== "not_found") throw error;
        this.state.subscription = undefined;
      }
    }
    const base = settings.notificationPublicUrl.replace(/\/+$/, "");
    const created = await this.deps.client.json<{ id: string; expirationDateTime?: string }>(
      "POST",
      "/subscriptions",
      {
        changeType: "created",
        resource: `users/${settings.userId}/onlineMeetings/getAllTranscripts`,
        notificationUrl: `${base}${NOTIFICATION_PATH}`,
        lifecycleNotificationUrl: `${base}${LIFECYCLE_PATH}`,
        includeResourceData: false,
        expirationDateTime: expiration,
        clientState: settings.clientState,
      },
    );
    this.state.subscription = {
      id: created.id,
      expiresAt: created.expirationDateTime || expiration,
      lastRenewedAt: new Date(this.now()).toISOString(),
    };
    this.state.subscriptionError = undefined;
    this.save();
  }

  private recordSubscriptionError(error: unknown): void {
    this.state.subscriptionError = `Change notifications unavailable; polling continues. ${
      error instanceof Error ? error.message : String(error)
    }`;
    this.save();
    logger.warn(this.state.subscriptionError);
  }

  private startNotificationServer(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handleNotificationRequest(req, res));
      server.on("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use.`) : error),
      );
      server.listen(port, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** Visible for tests. */
  async handleNotificationRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      req.method !== "POST" ||
      (url.pathname !== NOTIFICATION_PATH && url.pathname !== LIFECYCLE_PATH)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Graph validates the endpoint when creating or renewing a subscription.
    const validationToken = url.searchParams.get("validationToken");
    if (validationToken !== null) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(validationToken);
      return;
    }
    let body = "";
    let tooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_NOTIFICATION_BODY) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      res.writeHead(413);
      res.end();
      return;
    }
    let notifications: Array<{
      subscriptionId?: string;
      clientState?: string;
      lifecycleEvent?: string;
    }> = [];
    try {
      notifications = (JSON.parse(body) as { value?: typeof notifications }).value || [];
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(202);
    res.end();

    const settings = this.deps.loadSettings();
    for (const notification of notifications) {
      const trusted =
        Boolean(settings.clientState) &&
        typeof notification.clientState === "string" &&
        timingSafeEqualString(notification.clientState, settings.clientState as string) &&
        notification.subscriptionId === this.state.subscription?.id;
      if (!trusted) {
        this.rejectedNotifications += 1;
        if (this.rejectedNotifications === 1 || this.rejectedNotifications % 50 === 0) {
          logger.warn(
            `Ignored ${this.rejectedNotifications} Teams notification(s) with a wrong clientState or subscription`,
          );
        }
        continue;
      }
      if (this.state.subscription) {
        this.state.subscription.lastNotificationAt = new Date(this.now()).toISOString();
      }
      await this.handleTrustedNotification(notification.lifecycleEvent);
    }
    this.save();
  }

  private async handleTrustedNotification(lifecycleEvent?: string): Promise<void> {
    if (lifecycleEvent === "reauthorizationRequired") {
      // Renewing reauthorizes the subscription.
      if (this.state.subscription)
        this.state.subscription.expiresAt = new Date(this.now()).toISOString();
      await this.ensureSubscription().catch((error) => this.recordSubscriptionError(error));
      return;
    }
    if (lifecycleEvent === "subscriptionRemoved") {
      this.state.subscription = undefined;
      await this.ensureSubscription().catch((error) => this.recordSubscriptionError(error));
    }
    // New transcripts, missed notifications and removals all end in a discovery
    // pass. Debounced because transcript content lags the notification.
    if (this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = null;
      void this.syncNow();
    }, NOTIFICATION_DEBOUNCE_MS);
    this.notificationTimer.unref?.();
  }

  // ── Persistence ───────────────────────────────────────

  private isConnected(settings: TeamsMeetingSettings): boolean {
    return Boolean(settings.refreshToken || settings.accessToken);
  }

  private setState(state: TeamsMeetingSyncState): void {
    if (this.state.state === state) return;
    this.state.state = state;
    this.deps.onChange?.();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PipelineState;
      if (parsed?.version === 1) this.state = { ...emptyState(), ...parsed };
    } catch {
      this.state = emptyState();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }
}
