import { AgentDaemon } from "../agent/daemon";
import { initializeHookAgentIngress, HookAgentIngress } from "../hooks/agent-ingress";
import { XSettingsManager } from "../settings/x-manager";
import { checkBirdInstalled } from "../utils/x-cli";
import { fetchMentionsWithRetry } from "./fetch";
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
  private readonly ingress: HookAgentIngress;
  private readonly statusStore = getXMentionTriggerStatusStore();
  private readonly isNativeXChannelEnabled: () => boolean;

  constructor(
    agentDaemon: AgentDaemon,
    options: XMentionBridgeServiceOptions = {},
  ) {
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
    console.log("[X Mentions] Bridge service started");
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.statusStore.setMode("disabled", false);
    console.log("[X Mentions] Bridge service stopped");
  }

  triggerNow(): void {
    if (!this.running) return;
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      void this.pollOnce();
    }, Math.max(0, delayMs));
  }

  private getCurrentPollIntervalMs(): number {
    const settings = XSettingsManager.loadSettings();
    const intervalSec = settings.mentionTrigger?.pollIntervalSec ?? 120;
    return Math.max(30, intervalSec) * 1000;
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    if (this.pollInFlight) {
      this.schedulePoll(this.getCurrentPollIntervalMs());
      return;
    }
    this.pollInFlight = true;

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
        return;
      }

      this.statusStore.setMode("bridge", true);
      this.statusStore.markPoll();

      const result = await fetchMentionsWithRetry(settings, trigger.fetchCount || 25);
      if (result.jsonFallbackUsed) {
        throw new Error("bird mentions requires JSON support. Upgrade bird CLI to a newer version.");
      }
      const mentions = sortMentionsOldestFirst(parseBirdMentions(result.data ?? result.stdout));
      let acceptedThisPoll = 0;
      let ignoredThisPoll = 0;

      for (const mention of mentions) {
        const parsed = parseMentionTriggerCommand(mention, trigger);
        if (!parsed.accepted || !parsed.mention) {
          this.statusStore.incrementIgnored();
          ignoredThisPoll += 1;
          continue;
        }

        const prompt = buildMentionTaskPrompt(parsed.mention);
        const created = await this.ingress.createTaskFromAgentAction({
          name: `X mention from @${parsed.mention.author}`,
          message: prompt,
          sessionKey: `xmention:${parsed.mention.tweetId}`,
        }, {
          tempWorkspaceKey: `x-${parsed.mention.author}`,
        });
        this.statusStore.incrementAccepted();
        acceptedThisPoll += 1;
        this.statusStore.setLastTaskId(created.taskId);
      }

      if (mentions.length > 0) {
        console.log(
          `[X Mentions] Bridge poll processed ${mentions.length} mentions (${acceptedThisPoll} accepted, ${ignoredThisPoll} ignored)`,
        );
      }

      this.statusStore.markSuccess();
    } catch (error) {
      console.warn(
        "[X Mentions] Bridge poll failed:",
        error instanceof Error ? error.message : String(error),
      );
      this.statusStore.markError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pollInFlight = false;
      this.schedulePoll(this.getCurrentPollIntervalMs());
    }
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
