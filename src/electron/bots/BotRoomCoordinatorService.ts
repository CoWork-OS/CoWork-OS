import type { BotRoom, BotRoomRunReceipt, ManagedSessionEvent } from "../../shared/types";
import { ManagedSessionService } from "../managed/ManagedSessionService";
import { BotCoordinatorService } from "./BotCoordinatorService";
import { BotRoomService } from "./BotRoomService";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_TRANSCRIPT_CHARS = 60_000;

interface BotRoomCoordinatorOptions {
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

function eventText(event: ManagedSessionEvent): string {
  const payload = event.payload as Record<string, unknown>;
  for (const value of [payload.message, payload.text, payload.summary, payload.result]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class BotRoomCoordinatorService {
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly turnTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly rooms: BotRoomService,
    private readonly bots: BotCoordinatorService,
    private readonly managedSessions: ManagedSessionService,
    options: BotRoomCoordinatorOptions = {},
  ) {
    this.turnTimeoutMs = Math.max(5_000, options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  sendUserMessage(roomId: string, body: string): BotRoomRunReceipt {
    const userMessage = this.rooms.appendUserMessage(roomId, body);
    const room = this.rooms.get(roomId)!;
    const memberCount = Math.max(1, this.rooms.listMembers(roomId).length);
    const leaseMs = Math.min(
      24 * 60 * 60 * 1000,
      this.turnTimeoutMs * room.maxRounds * memberCount + 60_000,
    );
    const run = this.rooms.startRun(roomId, `desktop:${process.pid}`, leaseMs);
    const execution = this.executeRun(roomId, run.runId, run.epoch).finally(() => {
      if (this.activeRuns.get(run.runId) === execution) this.activeRuns.delete(run.runId);
    });
    this.activeRuns.set(run.runId, execution);
    void execution.catch(() => {});
    return { userMessage, runId: run.runId, epoch: run.epoch };
  }

  async waitForRun(runId: string): Promise<void> {
    await this.activeRuns.get(runId);
  }

  private async executeRun(roomId: string, runId: string, epoch: number): Promise<void> {
    try {
      let room = this.requireActiveRun(roomId, runId);
      for (let round = 1; round <= room.maxRounds; round += 1) {
        room = this.requireActiveRun(roomId, runId);
        if (round > 1) {
          const advanced = this.rooms.advanceRound(roomId, runId);
          if (!advanced) break;
        }
        const remaining = room.maxMessages - this.rooms.countRunMessages(roomId, runId);
        if (remaining <= 0) break;
        const members = this.orderedMembers(room).slice(0, remaining);
        if (!members.length) break;

        const responses =
          room.executionMode === "parallel"
            ? await Promise.all(
                members.map((agentId) => this.runMemberTurn(roomId, runId, epoch, round, agentId)),
              )
            : await this.runSequentialTurns(roomId, runId, epoch, round, members);
        if (responses.every((response) => response === "pass")) break;
      }
    } finally {
      this.rooms.finishRun(roomId, runId);
    }
  }

  private async runSequentialTurns(
    roomId: string,
    runId: string,
    epoch: number,
    round: number,
    members: string[],
  ): Promise<Array<"pass" | "response" | "failed">> {
    const results: Array<"pass" | "response" | "failed"> = [];
    for (const agentId of members) {
      if (this.rooms.countRunMessages(roomId, runId) >= this.rooms.get(roomId)!.maxMessages) break;
      results.push(await this.runMemberTurn(roomId, runId, epoch, round, agentId));
    }
    return results;
  }

  private async runMemberTurn(
    roomId: string,
    runId: string,
    epoch: number,
    round: number,
    agentId: string,
  ): Promise<"pass" | "response" | "failed"> {
    const room = this.rooms.get(roomId);
    if (!room) return "failed";
    try {
      const binding = this.bots.getBinding(agentId);
      if (!binding.defaultEnvironmentId) throw new Error("No default environment is configured");
      const environment = this.managedSessions.getEnvironment(binding.defaultEnvironmentId);
      if (!environment || environment.status !== "active") {
        throw new Error("The configured environment is not active");
      }
      const member = this.rooms.listMembers(roomId).find((entry) => entry.agentId === agentId);
      const session = await this.managedSessions.createSession({
        agentId,
        environmentId: environment.id,
        title: `${room.name} · Round ${round}`,
        surface: "bot_group",
        resumedFromSessionId: member?.memberSessionId,
        initialEvent: {
          type: "user.message",
          content: [{ type: "text", text: this.buildTurnPrompt(room, round, agentId) }],
        },
      });
      this.rooms.setMemberSession(roomId, agentId, session.id);
      const response = await this.waitForAssistant(session.id);
      const message = this.rooms.appendBotMessage({
        roomId,
        runId,
        epoch,
        round,
        fromAgentId: agentId,
        body: response || "(pass)",
      });
      this.rooms.markSeen(roomId, agentId, message.seq);
      return message.status === "pass" ? "pass" : "response";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.rooms.appendBotMessage({
          roomId,
          runId,
          epoch,
          round,
          fromAgentId: agentId,
          body: `Turn failed: ${message}`,
          failed: true,
        });
      } catch {
        // The run may have been superseded or reached its configured message limit.
      }
      return "failed";
    }
  }

  private async waitForAssistant(sessionId: string): Promise<string> {
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() < deadline) {
      const events = this.managedSessions.listLatestSessionEvents(sessionId, 100);
      const response = [...events]
        .reverse()
        .find((event) => event.type === "assistant.message");
      if (response) return eventText(response) || "(pass)";
      const session = this.managedSessions.getSession(sessionId);
      if (session?.status === "failed") throw new Error(session.latestSummary || "Agent run failed");
      if (session?.status === "cancelled") throw new Error("Agent run was cancelled");
      if (session?.status === "completed") return session.latestSummary || "(pass)";
      await this.delay(this.pollIntervalMs);
    }
    throw new Error(`Agent turn timed out after ${Math.round(this.turnTimeoutMs / 1000)} seconds`);
  }

  private buildTurnPrompt(room: BotRoom, round: number, agentId: string): string {
    const transcript = this.rooms
      .listMessages(room.id)
      .slice(-100)
      .map((message) => `${message.fromAgentId || "user"}: ${message.body}`)
      .join("\n")
      .slice(-MAX_TRANSCRIPT_CHARS);
    return [
      `You are participating in the bot room "${room.name}" as ${agentId}.`,
      `This is round ${round} of at most ${room.maxRounds}.`,
      "Respond with a concise contribution that advances the request.",
      "If you have nothing useful to add, respond exactly with (pass).",
      "",
      "Room transcript:",
      transcript,
    ].join("\n");
  }

  private orderedMembers(room: BotRoom): string[] {
    const members = this.rooms
      .listMembers(room.id)
      .filter((member) => member.status === "active")
      .map((member) => member.agentId);
    if (room.executionMode !== "leader" || !room.ownerAgentId) return members;
    return [...members.filter((agentId) => agentId !== room.ownerAgentId), room.ownerAgentId];
  }

  private requireActiveRun(roomId: string, runId: string): BotRoom {
    const room = this.rooms.get(roomId);
    if (!room || room.activeRunId !== runId) throw new Error("Bot room run is no longer active");
    return room;
  }
}
