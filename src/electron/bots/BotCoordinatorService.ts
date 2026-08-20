import type Database from "better-sqlite3";

import type {
  BotCanonicalSessionRequest,
  BotBindingUserUpdates,
  BotEnvelope,
  BotRuntimeBinding,
  BotRuntimeSnapshot,
  BotSendMessageRequest,
  BotSummary,
  ManagedSession,
  ManagedSessionEvent,
  ManagedSessionInputContent,
} from "../../shared/types";
import { ManagedSessionService } from "../managed/ManagedSessionService";
import { BotMessageRepository, BotRuntimeBindingRepository } from "./repositories";
import { routeBotTurn } from "./BotTurnRouter";

const TERMINAL_SESSION_STATUSES = new Set<ManagedSession["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class BotCoordinatorService {
  private readonly bindings: BotRuntimeBindingRepository;
  private readonly messages: BotMessageRepository;
  private readonly canonicalCreations = new Map<string, Promise<ManagedSession>>();
  private readonly deliveryChains = new Map<string, Promise<unknown>>();
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    db: Database.Database,
    private readonly managedSessions: ManagedSessionService,
  ) {
    this.bindings = new BotRuntimeBindingRepository(db);
    this.messages = new BotMessageRepository(db);
    this.messages.recoverStaleClaims();
    this.messages.pruneTerminal();
  }

  listBots(): BotSummary[] {
    const agents = this.managedSessions.listAgents({ limit: 500 });
    return agents
      .filter((agent) => agent.status !== "archived")
      .map((agent) => {
        const binding = this.ensureBinding(agent.id);
        const canonicalSession = binding.canonicalSessionId
          ? this.managedSessions.getSession(binding.canonicalSessionId)
          : undefined;
        const inbox = this.messages.list({ toAgentId: agent.id, limit: 1 });
        return {
          agent,
          binding,
          canonicalSession,
          unreadCount: this.messages.countForRecipient(agent.id, "queued"),
          queuedCount: this.messages.countForRecipient(agent.id, "queued"),
          latestMessage: inbox[0],
          runtime: this.runtimeSnapshot(canonicalSession, this.messages.countForRecipient(agent.id, "queued")),
        };
      })
      .sort((left, right) => {
        const pin = Number(right.binding.pinned) - Number(left.binding.pinned);
        if (pin !== 0) return pin;
        const order = left.binding.sortOrder - right.binding.sortOrder;
        if (order !== 0) return order;
        return right.agent.updatedAt - left.agent.updatedAt;
      });
  }

  getBinding(agentId: string): BotRuntimeBinding {
    this.assertAgent(agentId);
    return this.ensureBinding(agentId);
  }

  updateBinding(
    agentId: string,
    updates: BotBindingUserUpdates,
  ): BotRuntimeBinding {
    this.assertAgent(agentId);
    if (updates.defaultEnvironmentId) {
      const environment = this.managedSessions.getEnvironment(updates.defaultEnvironmentId);
      if (!environment)
        throw new Error(`Managed environment not found: ${updates.defaultEnvironmentId}`);
      if (environment.status !== "active") {
        throw new Error(`Managed environment is not active: ${updates.defaultEnvironmentId}`);
      }
    }
    return this.bindings.update(agentId, {
      defaultEnvironmentId: updates.defaultEnvironmentId,
      avatar: updates.avatar,
      pinned: updates.pinned,
      sidebarGroup: updates.sidebarGroup,
      sortOrder: updates.sortOrder,
    });
  }

  async ensureCanonicalSession(request: BotCanonicalSessionRequest): Promise<ManagedSession> {
    const existingPromise = this.canonicalCreations.get(request.agentId);
    if (existingPromise) return existingPromise;
    const creation = this.ensureCanonicalSessionInternal(request);
    this.canonicalCreations.set(request.agentId, creation);
    try {
      return await creation;
    } finally {
      if (this.canonicalCreations.get(request.agentId) === creation) {
        this.canonicalCreations.delete(request.agentId);
      }
    }
  }

  async sendMessage(request: BotSendMessageRequest): Promise<BotEnvelope> {
    const details = this.assertAgent(request.toAgentId);
    if (!request.body.trim()) throw new Error("Bot message body is required");
    if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs < 0)) {
      throw new Error("Bot message TTL must be a finite non-negative number");
    }
    const route = routeBotTurn(request, details.currentVersion);
    const requestData = record(request.data) || {};
    const envelope = this.messages.create({
      fromAgentId: request.fromAgentId,
      toAgentId: request.toAgentId,
      kind: request.kind || "request",
      contentType: request.contentType || "text/plain",
      body: request.body.trim(),
      data: { ...requestData, botTurnRoute: route },
      artifactRefs: request.artifactRefs,
      conversationId: request.conversationId,
      correlationId: request.correlationId,
      replyTo: request.replyTo,
      sourceProtocol: "cowork",
      maxAttempts: 3,
      idempotencyKey: request.idempotencyKey,
      expiresAt: request.ttlMs && request.ttlMs > 0 ? Date.now() + request.ttlMs : undefined,
    });
    this.messages.capQueuedInbox(request.toAgentId, 5_000, "cowork");
    if (envelope.status !== "queued") return envelope;

    const claimed = this.messages.claim(envelope.id);
    if (!claimed) return this.messages.findById(envelope.id) || envelope;
    try {
      return await this.withAgentDeliveryLock(request.toAgentId, async () => {
        const binding = this.ensureBinding(request.toAgentId);
        if (binding.runtimeKind !== "local") {
          return this.messages.fail(
            envelope.id,
            `${binding.runtimeKind} bot delivery is queued until its runtime is connected`,
          )!;
        }
        await this.deliverToLocalBot(claimed, binding);
        return this.messages.complete(envelope.id)!;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.fail(envelope.id, message);
      throw error;
    }
  }

  listMessages(params: Parameters<BotMessageRepository["list"]>[0]): BotEnvelope[] {
    return this.messages.list(params);
  }

  startRecoveryLoop(intervalMs = 30_000): void {
    if (this.recoveryTimer) return;
    void this.recoverPendingMessages();
    this.recoveryTimer = setInterval(() => {
      void this.recoverPendingMessages();
    }, Math.max(5_000, intervalMs));
    this.recoveryTimer.unref?.();
  }

  stopRecoveryLoop(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  async recoverPendingMessages(): Promise<{ recovered: number; delivered: number }> {
    const recovered = this.messages.recoverStaleClaims();
    this.messages.pruneTerminal();
    let delivered = 0;
    const queued = this.messages.listQueuedForDelivery(100, Date.now() - 5_000);
    for (const envelope of queued) {
      const binding = this.bindings.findByAgentId(envelope.toAgentId);
      if (!binding || binding.runtimeKind !== "local") continue;
      const claimed = this.messages.claim(envelope.id);
      if (!claimed) continue;
      try {
        await this.withAgentDeliveryLock(envelope.toAgentId, () =>
          this.deliverToLocalBot(claimed, binding),
        );
        this.messages.complete(envelope.id);
        delivered += 1;
      } catch (error) {
        this.messages.fail(
          envelope.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { recovered, delivered };
  }

  getConversation(
    agentId: string,
    limitPerSession = 500,
  ): Array<{
    session: ManagedSession;
    events: ManagedSessionEvent[];
  }> {
    const binding = this.getBinding(agentId);
    if (!binding.canonicalSessionId) return [];
    const chain: ManagedSession[] = [];
    const seen = new Set<string>();
    let current = this.managedSessions.getSession(binding.canonicalSessionId);
    const rootWorkspaceId =
      current?.agentId === agentId && current.surface === "bot_chat"
        ? current.workspaceId
        : undefined;
    while (current && !seen.has(current.id) && chain.length < 25) {
      if (
        current.agentId !== agentId ||
        current.surface !== "bot_chat" ||
        current.workspaceId !== rootWorkspaceId
      ) {
        break;
      }
      seen.add(current.id);
      chain.push(current);
      current = current.resumedFromSessionId
        ? this.managedSessions.getSession(current.resumedFromSessionId)
        : undefined;
    }
    let remainingEvents = 1_000;
    const result: Array<{ session: ManagedSession; events: ManagedSessionEvent[] }> = [];
    for (const session of chain) {
      if (remainingEvents <= 0) break;
      const events = this.managedSessions.listLatestSessionEvents(
        session.id,
        Math.min(limitPerSession, remainingEvents),
      );
      remainingEvents -= events.length;
      result.unshift({ session, events });
    }
    return result;
  }

  private async ensureCanonicalSessionInternal(
    request: BotCanonicalSessionRequest,
  ): Promise<ManagedSession> {
    const { agent } = this.assertAgent(request.agentId);
    const binding = this.ensureBinding(request.agentId);
    if (binding.canonicalSessionId) {
      const existing = this.managedSessions.getSession(binding.canonicalSessionId);
      if (
        existing &&
        existing.agentId === request.agentId &&
        existing.surface === "bot_chat" &&
        (!request.environmentId || existing.environmentId === request.environmentId)
      ) {
        return existing;
      }
    }
    const environmentId = request.environmentId || binding.defaultEnvironmentId;
    if (!environmentId) {
      throw new Error(`Bot ${agent.name} needs a default environment before opening its chat`);
    }
    const environment = this.managedSessions.getEnvironment(environmentId);
    if (!environment || environment.status !== "active") {
      throw new Error(`Bot ${agent.name} needs an active environment before opening its chat`);
    }
    const previous = binding.canonicalSessionId
      ? this.managedSessions.getSession(binding.canonicalSessionId)
      : undefined;
    const session = await this.managedSessions.createSession({
      agentId: request.agentId,
      environmentId,
      title: `${agent.name} · Bot Chat`,
      surface: "bot_chat",
      resumedFromSessionId:
        previous?.agentId === request.agentId && previous.surface === "bot_chat"
          ? previous.id
          : undefined,
      initialEvent: request.initialContent?.length
        ? { type: "user.message", content: request.initialContent }
        : undefined,
    });
    this.bindings.update(request.agentId, {
      defaultEnvironmentId: environmentId,
      canonicalSessionId: session.id,
    });
    return session;
  }

  private async deliverToLocalBot(
    envelope: BotEnvelope,
    binding: BotRuntimeBinding,
  ): Promise<void> {
    const content = this.toManagedContent(envelope);
    const routeData = record(record(envelope.data)?.botTurnRoute);
    const route = routeData?.mode
      ? { mode: String(routeData.mode) as "conversation" | "task" | "team_task" }
      : routeBotTurn(
          { body: envelope.body },
          this.assertAgent(envelope.toAgentId).currentVersion,
        );
    const current = binding.canonicalSessionId
      ? this.managedSessions.getSession(binding.canonicalSessionId)
      : undefined;
    const canonical =
      current?.agentId === envelope.toAgentId && current.surface === "bot_chat"
        ? current
        : undefined;
    const environmentId = binding.defaultEnvironmentId || canonical?.environmentId;
    if (!environmentId) {
      throw new Error(`Bot ${envelope.toAgentId} needs a default environment before delivery`);
    }
    if (
      !canonical ||
      TERMINAL_SESSION_STATUSES.has(canonical.status) ||
      canonical.environmentId !== environmentId
      || canonical.interactionMode !== route.mode
    ) {
      const environment = this.managedSessions.getEnvironment(environmentId);
      if (!environment || environment.status !== "active") {
        throw new Error(`Bot environment is not active: ${environmentId}`);
      }
      const successor = await this.managedSessions.createSession({
        agentId: envelope.toAgentId,
        environmentId,
        title: canonical?.title || `${this.assertAgent(envelope.toAgentId).agent.name} · Bot Chat`,
        surface: "bot_chat",
        resumedFromSessionId: canonical?.id,
        initialEvent: { type: "user.message", content },
        launchMode: route.mode,
      });
      this.bindings.update(envelope.toAgentId, { canonicalSessionId: successor.id });
      return;
    }
    await this.managedSessions.sendUserMessage(
      canonical.id,
      content,
      route.mode === "conversation"
        ? {
            conversationMode: "chat",
            executionMode: "chat",
            executionModeSource: "user",
            collaborativeMode: false,
            multiLlmMode: false,
            allowedTools: [],
          }
        : undefined,
    );
  }

  private runtimeSnapshot(
    session: ManagedSession | undefined,
    queuedCount: number,
  ): BotRuntimeSnapshot {
    if (queuedCount > 0) {
      return { state: "queued", sessionId: session?.id, queuedCount, updatedAt: Date.now() };
    }
    if (!session) return { state: "not_started", queuedCount, updatedAt: Date.now() };
    const state =
      session.status === "completed"
        ? "idle"
        : session.status === "pending" || session.status === "interrupted"
          ? session.status === "interrupted" ? "failed" : "queued"
          : session.status;
    return {
      state,
      sessionId: session.id,
      queuedCount,
      lastOutcome: session.latestSummary,
      updatedAt: session.updatedAt,
    };
  }

  private async withAgentDeliveryLock<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.deliveryChains.get(agentId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.deliveryChains.set(agentId, settled);
    try {
      return await current;
    } finally {
      if (this.deliveryChains.get(agentId) === settled) this.deliveryChains.delete(agentId);
    }
  }

  private toManagedContent(envelope: BotEnvelope): ManagedSessionInputContent[] {
    const header =
      envelope.fromAgentId === "user"
        ? "Message from the user"
        : `Message from bot ${envelope.fromAgentId}`;
    const metadata = [
      envelope.correlationId ? `correlation=${envelope.correlationId}` : "",
      envelope.replyTo ? `replyTo=${envelope.replyTo}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const text = `${header}${metadata ? ` (${metadata})` : ""}:\n\n${envelope.body}`;
    return [
      { type: "text", text },
      ...(envelope.artifactRefs || []).map(
        (artifactId): ManagedSessionInputContent => ({ type: "file", artifactId }),
      ),
    ];
  }

  private ensureBinding(agentId: string): BotRuntimeBinding {
    const details = this.assertAgent(agentId);
    const metadata = record(details.currentVersion?.metadata);
    const studio = record(metadata?.studio);
    const legacyMirror = record(studio?.legacyMirror) || record(metadata?.legacyMirror);
    const inferredEnvironmentId =
      typeof studio?.defaultEnvironmentId === "string"
        ? studio.defaultEnvironmentId
        : undefined;
    const defaultEnvironmentId =
      inferredEnvironmentId && this.managedSessions.getEnvironment(inferredEnvironmentId)
        ? inferredEnvironmentId
        : undefined;
    return this.bindings.ensure(agentId, {
      runtimeKind: "local",
      defaultEnvironmentId,
      agentRoleId:
        typeof legacyMirror?.agentRoleId === "string" ? legacyMirror.agentRoleId : undefined,
    });
  }

  private assertAgent(agentId: string) {
    const details = this.managedSessions.getAgent(agentId);
    if (!details) throw new Error(`Managed agent not found: ${agentId}`);
    return details;
  }
}
