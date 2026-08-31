import { AgentDaemon } from "../agent/daemon";
import { initializeHookAgentIngress, HookAgentIngress } from "../hooks/agent-ingress";
import { XSettingsManager } from "../settings/x-manager";
import { checkBirdInstalled } from "../utils/x-cli";
import { classifyXMentionFailure, fetchMentionsWithRetry, type XMentionFailureCode } from "./fetch";
import {
  buildMentionTaskPrompt,
  parseBirdMentions,
  parseMentionTriggerCommand,
  sortMentionsOldestFirst,
} from "./parser";
import { getXMentionTriggerStatusStore } from "./status";

interface XMentionBridgeServiceOptions {
  isNativeXChannelEnabled?: () => boolean;
}

export class XMentionBridgeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pollInFlight = false;
  private pausedForAuth = false;
  private consecutiveFailures = 0;
  private lastLoggedFailureKey: string | null = null;
  private suppressedFailureLogCount = 0;
  private readonly ingress: HookAgentIngress;
  private readonly statusStore = getXMentionTriggerStatusStore();
  private readonly isNativeXChannelEnabled: () => boolean;
  private readonly FAILURE_BACKOFF_MIN_MS = 2 * 60 * 1000;
  private readonly FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
  private readonly CLI_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
  private readonly CONFIG_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
  private readonly FAILURE_LOG_REPEAT_EVERY = 5;

  constructor(agentDaemon: AgentDaemon, options: XMentionBridgeServiceOptions = {}) {
    this.ingress = initializeHookAgentIngress(agentDaemon, {
      scope: "hooks",
      defaultTempWorkspaceKey: "x-mentions",
      logger: (...args) => console.warn(...args),
    });
    this.isNativeXChannelEnabled = options.isNativeXChannelEnabled || (() => false);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pausedForAuth = false;
    console.log("[X Mentions] Bridge service started");
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    this.pausedForAuth = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.statusStore.setMode("disabled", false);
    console.log("[X Mentions] Bridge service stopped");
  }

  triggerNow(): void {
    if (!this.running) return;
    this.pausedForAuth = false;
    this.resetFailureLogSuppression();
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(
      () => {
        void this.pollOnce();
      },
      Math.max(0, delayMs),
    );
  }

  private getCurrentPollIntervalMs(): number {
    const settings = XSettingsManager.loadSettings();
    const intervalSec = settings.mentionTrigger?.pollIntervalSec ?? 120;
    return Math.max(30, intervalSec) * 1000;
  }

  private getFailureBackoffMs(code: XMentionFailureCode, baseIntervalMs: number): number {
    if (code === "unsupported_json" || code === "auth") {
      return Math.max(baseIntervalMs, this.CONFIG_FAILURE_BACKOFF_MS);
    }

    if (code === "cli") {
      return Math.max(baseIntervalMs * 2, this.CLI_FAILURE_BACKOFF_MS);
    }

    const multiplier = Math.pow(2, Math.max(0, Math.min(this.consecutiveFailures - 1, 4)));
    const exponentialDelay = Math.round(baseIntervalMs * multiplier);

    return Math.min(
      Math.max(exponentialDelay, this.FAILURE_BACKOFF_MIN_MS),
      this.FAILURE_BACKOFF_MAX_MS,
    );
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    if (this.pollInFlight) {
      this.schedulePoll(this.getCurrentPollIntervalMs());
      return;
    }
    this.pollInFlight = true;
    let nextDelayMs = this.getCurrentPollIntervalMs();

    try {
      const settings = XSettingsManager.loadSettings();
      const trigger = settings.mentionTrigger;

      if (!settings.enabled || !trigger?.enabled) {
        this.statusStore.setMode("disabled", false);
        return;
      }

      if (this.isNativeXChannelEnabled()) {
        this.statusStore.setMode("disabled", false);
        return;
      }

      const installStatus = await checkBirdInstalled();
      if (!installStatus.installed) {
        this.statusStore.setMode("bridge", false);
        this.statusStore.markError("bird CLI is not installed");
        nextDelayMs = Math.max(nextDelayMs, this.CLI_FAILURE_BACKOFF_MS);
        return;
      }

      this.statusStore.setMode("bridge", true);
      this.statusStore.markPoll();

      const result = await fetchMentionsWithRetry(settings, trigger.fetchCount || 25);
      if (result.jsonFallbackUsed) {
        throw new Error(
          "bird mentions requires JSON support. Upgrade bird CLI to a newer version.",
        );
      }
      const mentions = sortMentionsOldestFirst(parseBirdMentions(result.data ?? result.stdout));

      for (const mention of mentions) {
        const parsed = parseMentionTriggerCommand(mention, trigger);
        if (!parsed.accepted || !parsed.mention) {
          this.statusStore.incrementIgnored();
          continue;
        }

        const prompt = buildMentionTaskPrompt(parsed.mention);
        const created = await this.ingress.createTaskFromAgentAction(
          {
            name: `X mention from @${parsed.mention.author}`,
            message: prompt,
            sessionKey: `xmention:${parsed.mention.tweetId}`,
          },
          {
            tempWorkspaceKey: `x-${parsed.mention.author}`,
          },
        );
        this.statusStore.incrementAccepted();
        this.statusStore.setLastTaskId(created.taskId);
      }

      this.statusStore.markSuccess();
      this.consecutiveFailures = 0;
      this.resetFailureLogSuppression();
    } catch (error) {
      const failure = classifyXMentionFailure(error);
      this.consecutiveFailures += 1;
      if (failure.code === "auth") {
        this.pausedForAuth = true;
      } else {
        nextDelayMs = this.getFailureBackoffMs(failure.code, nextDelayMs);
      }
      this.statusStore.setMode("bridge", false);
      this.logPollFailure(failure, nextDelayMs);
      this.statusStore.markError(failure.message);
    } finally {
      this.pollInFlight = false;
      if (!this.pausedForAuth) {
        this.schedulePoll(nextDelayMs);
      }
    }
  }

  private resetFailureLogSuppression(): void {
    this.lastLoggedFailureKey = null;
    this.suppressedFailureLogCount = 0;
  }

  private logPollFailure(
    failure: ReturnType<typeof classifyXMentionFailure>,
    nextDelayMs: number,
  ): void {
    const key = `${failure.code}:${failure.message}`;
    const repeated = key === this.lastLoggedFailureKey;
    if (repeated) {
      this.suppressedFailureLogCount += 1;
      if (this.suppressedFailureLogCount % this.FAILURE_LOG_REPEAT_EVERY !== 0) {
        return;
      }
      console.warn(
        `[X Mentions] Bridge poll still failing (${failure.code}); suppressed ${this.suppressedFailureLogCount} repeated failure logs. ` +
          (failure.code === "auth"
            ? `Polling paused until settings are refreshed: ${failure.message}`
            : `Next poll in ${Math.round(nextDelayMs / 1000)}s: ${failure.message}`),
      );
      return;
    }

    if (this.suppressedFailureLogCount > 0) {
      console.warn(
        `[X Mentions] Suppressed ${this.suppressedFailureLogCount} repeated bridge poll failure logs before failure changed.`,
      );
    }
    this.lastLoggedFailureKey = key;
    this.suppressedFailureLogCount = 0;
    console.warn(
      failure.code === "auth"
        ? `[X Mentions] Bridge poll failed (${failure.code}). Polling paused until settings are refreshed: ${failure.message}`
        : `[X Mentions] Bridge poll failed (${failure.code}). Next poll in ${Math.round(nextDelayMs / 1000)}s: ${failure.message}`,
    );
  }
}

let sharedBridgeService: XMentionBridgeService | null = null;

export function initializeXMentionBridgeService(
  agentDaemon: AgentDaemon,
  options: XMentionBridgeServiceOptions = {},
): XMentionBridgeService {
  if (!sharedBridgeService) {
    sharedBridgeService = new XMentionBridgeService(agentDaemon, options);
  }
  return sharedBridgeService;
}

export function getXMentionBridgeService(): XMentionBridgeService | null {
  return sharedBridgeService;
}
