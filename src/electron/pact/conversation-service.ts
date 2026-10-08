/**
 * Ordered, durable turns with a business agent (plan §9).
 *
 * Before any network effect the admitted request is persisted with its wire messageId, body
 * digest, authority fingerprint, card and provider revision, grant id and an attempt lease. Turns
 * are serialised per conversation and the lease is transactional, so two runtimes cannot send the
 * same turn. Every outcome maps to the retry contract:
 *
 * - established context, reply lost → `outcome_unknown`; reconcile later with the same messageId;
 * - first message without a context cannot be deduplicated → effectful operations first open the
 *   context with a non-mutating introduction;
 * - `INVALID_PARAMS` "no reply yet" → back off and retry the same id, never mint a new one;
 * - `TASK_STATE_AUTH_REQUIRED` → the turn was not executed; the caller re-consents and resends
 *   with a new wire messageId in the same context;
 * - 401 `invalid_token` → stop and offer reconnection, never another grant automatically;
 * - foreign context or different `sub` → the conversation is unusable for this binding.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PactEffectClass } from "../../shared/pact";
import type { PactRepository } from "./pact-repository";
import type { PactConversationRecord, PactMessageKind, PactMessageRecord } from "./types";
import { sendPactMessage } from "./protocol-client";
import { PactTransportError, type PactTransport } from "./transport";
import {
  A2AError,
  A2AHttpError,
  DelegationTokenRejectedError,
  type DelegatedSendResult,
} from "./upstream/client-delegation";
import type { Message } from "./upstream/protocol";
import type { Receipt } from "./upstream/delegation";

export const MESSAGE_LEASE_MS = 3 * 60_000;
const NO_REPLY_YET_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_RATE_LIMIT_RETRIES = 3;
export const MAX_CONTEXT_ATTEMPTS = 3;

export const PACT_INTRODUCTION_TEXT =
  "Hello. I am CoWork, a personal assistant acting for one of your customers. Their request follows in my next message.";

export function bodyDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type PactTurnResult =
  | {
      kind: "replied";
      message: PactMessageRecord;
      reply: Message;
      replyText: string;
      receipt?: Receipt;
      sentAt: number;
      receivedAt: number;
    }
  | { kind: "auth_required"; message: PactMessageRecord; missingScopes: string[]; promptText: string }
  | { kind: "outcome_unknown"; message: PactMessageRecord; reason: string }
  | {
      kind: "failed";
      message?: PactMessageRecord;
      reason:
        | "conversation_busy"
        | "unresolved_operation"
        | "context_closed"
        | "foreign_context"
        | "delegation_rejected"
        | "identity_rejected"
        | "business_not_found"
        | "not_executed"
        | "policy_denied"
        | "rate_limited"
        | "context_limit"
        | "cancelled";
      detail: string;
    };

export interface PactTurnInput {
  conversation: PactConversationRecord;
  operationId: string;
  kind: PactMessageKind;
  text: string;
  effectClass: PactEffectClass;
  requiredScopes: string[];
  authorityFingerprint: string;
  cardRevision: number;
  providerRevision: number;
  grantId: string | null;
  interfaceUrl: string;
  transport: PactTransport;
  paJwt: () => Promise<string>;
  delegationToken: () => Promise<string | undefined>;
  signal?: AbortSignal;
  /** Reconcile: resend this exact attempt (same wire messageId and body). */
  reuse?: PactMessageRecord;
}

function textOf(message: Message): string {
  return message.parts
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export class PactConversationService {
  constructor(
    private readonly deps: {
      repo: PactRepository;
      leaseOwner: string;
      now?: () => number;
      /** Tests replace backoff sleeps. */
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.sleep ?? sleep)(ms, signal);
  }

  async sendTurn(input: PactTurnInput): Promise<PactTurnResult> {
    let message: PactMessageRecord | null;
    if (input.reuse) {
      if (input.reuse.bodyDigest !== bodyDigest(input.reuse.bodyText)) {
        return { kind: "failed", reason: "not_executed", detail: "Stored turn failed its integrity check" };
      }
      message = input.reuse;
    } else {
      message = await this.deps.repo.prepareMessage({
        conversationId: input.conversation.id,
        operationId: input.operationId,
        wireMessageId: randomUUID(),
        kind: input.kind,
        bodyText: input.text,
        bodyDigest: bodyDigest(input.text),
        effectClass: input.effectClass,
        requiredScopes: input.requiredScopes,
        authorityFingerprint: input.authorityFingerprint,
        cardRevision: input.cardRevision,
        providerRevision: input.providerRevision,
        grantId: input.grantId,
        leaseOwner: this.deps.leaseOwner,
        leaseMs: MESSAGE_LEASE_MS,
      });
      if (!message) {
        const messages = await this.deps.repo.listMessages(input.conversation.id);
        const unresolved = messages.some((entry) => entry.state === "outcome_unknown");
        return unresolved
          ? {
              kind: "failed",
              reason: "unresolved_operation",
              detail: "An earlier request to this business has an unknown outcome; resolve it first",
            }
          : {
              kind: "failed",
              reason: "conversation_busy",
              detail: "Another CoWork runtime is sending to this business right now",
            };
      }
    }
    const started = input.reuse
      ? await this.deps.repo.beginReconcile(message.id, this.deps.leaseOwner, MESSAGE_LEASE_MS)
      : await this.deps.repo.beginAttempt(message.id, this.deps.leaseOwner, MESSAGE_LEASE_MS);
    if (!started) {
      return { kind: "failed", message, reason: "conversation_busy", detail: "The turn is held by another runtime" };
    }
    message = started;
    await this.deps.repo.updateConversation(input.conversation.id, { state: "sending", stateReason: null });

    const contextId = input.conversation.contextId ?? undefined;
    const sentAt = this.now();
    let noReplyRetries = 0;
    let rateLimitRetries = 0;
    let result: DelegatedSendResult;
    for (;;) {
      let paJwt: string;
      let delegationToken: string | undefined;
      try {
        [paJwt, delegationToken] = await Promise.all([input.paJwt(), input.delegationToken()]);
      } catch (error) {
        // Nothing was sent: the identity or the grant is unusable. The caller maps the cause.
        await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
          state: "failed",
          stateReason: "credentials_unavailable",
        });
        await this.deps.repo.updateConversation(input.conversation.id, {
          state: input.conversation.contextId ? "ready" : "discovered",
          stateReason: "credentials_unavailable",
        });
        throw error;
      }
      try {
        result = await sendPactMessage(input.transport, {
          interfaceUrl: input.interfaceUrl,
          message: {
            messageId: message.wireMessageId,
            ...(contextId ? { contextId } : {}),
            text: message.bodyText,
          },
          paJwt,
          ...(delegationToken ? { delegationToken } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        break;
      } catch (error) {
        if (
          error instanceof A2AError &&
          error.reason === "INVALID_PARAMS" &&
          /no reply yet/i.test(error.message) &&
          noReplyRetries < NO_REPLY_YET_BACKOFF_MS.length
        ) {
          // The provider is still processing this exact turn; ask again with the same id.
          try {
            await this.wait(NO_REPLY_YET_BACKOFF_MS[noReplyRetries]!, input.signal);
          } catch {
            return this.unknown(message, input, "cancelled_while_processing");
          }
          noReplyRetries += 1;
          continue;
        }
        if (
          error instanceof PactTransportError &&
          error.code === "rate_limited" &&
          rateLimitRetries < MAX_RATE_LIMIT_RETRIES
        ) {
          // 429 means the provider refused the request before running it.
          try {
            await this.wait(error.retryAfterMs ?? 5_000, input.signal);
          } catch {
            return this.notExecuted(message, input, "cancelled", "Cancelled while rate limited");
          }
          rateLimitRetries += 1;
          continue;
        }
        return this.classifyFailure(error, message, input, noReplyRetries > 0);
      }
    }

    const receivedAt = this.now();
    if (result.kind === "authRequired") {
      const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
        state: "auth_required",
        stateReason: `missing:${result.missingScopes.join(" ")}`,
      });
      await this.adoptContext(input.conversation, result.task.contextId);
      await this.deps.repo.updateConversation(input.conversation.id, {
        state: "awaiting_business_consent",
        stateReason: null,
      });
      return {
        kind: "auth_required",
        message: finished ?? message,
        missingScopes: result.missingScopes,
        promptText: result.task.status.message ? textOf(result.task.status.message) : "",
      };
    }

    const reply = result.message;
    if (reply.role !== "ROLE_AGENT") {
      return this.unknown(message, input, "reply_not_from_agent");
    }
    if (contextId && reply.contextId && reply.contextId !== contextId) {
      return this.unknown(message, input, "reply_context_mismatch");
    }
    if (!contextId && reply.contextId) await this.adoptContext(input.conversation, reply.contextId);
    const replyText = textOf(reply).slice(0, 20_000);
    const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
      state: "replied",
      stateReason: null,
      replyText,
      replyMessageId: reply.messageId,
    });
    await this.deps.repo.updateConversation(input.conversation.id, { state: "replied", stateReason: null });
    return {
      kind: "replied",
      message: finished ?? message,
      reply,
      replyText,
      ...(result.receipt ? { receipt: result.receipt } : {}),
      sentAt,
      receivedAt,
    };
  }

  private async adoptContext(conversation: PactConversationRecord, contextId: string | undefined) {
    if (!contextId || conversation.contextId === contextId) return;
    if (conversation.contextId && conversation.contextId !== contextId) return;
    await this.deps.repo.updateConversation(conversation.id, { contextId });
    conversation.contextId = contextId;
  }

  private async notExecuted(
    message: PactMessageRecord,
    input: PactTurnInput,
    reason: Extract<PactTurnResult, { kind: "failed" }>["reason"],
    detail: string,
  ): Promise<PactTurnResult> {
    const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
      state: reason === "cancelled" ? "cancelled" : "failed",
      stateReason: reason,
    });
    await this.deps.repo.updateConversation(input.conversation.id, {
      state: input.conversation.contextId ? "ready" : "discovered",
      stateReason: reason,
    });
    return { kind: "failed", message: finished ?? message, reason, detail };
  }

  private async unknown(
    message: PactMessageRecord,
    input: PactTurnInput,
    reason: string,
  ): Promise<PactTurnResult> {
    const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
      state: "outcome_unknown",
      stateReason: reason,
    });
    await this.deps.repo.updateConversation(input.conversation.id, {
      state: "outcome_unknown",
      stateReason: reason,
    });
    return { kind: "outcome_unknown", message: finished ?? message, reason };
  }

  private async closeConversation(
    message: PactMessageRecord,
    input: PactTurnInput,
    reason: "context_closed" | "foreign_context",
    detail: string,
  ): Promise<PactTurnResult> {
    const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
      state: "failed",
      stateReason: reason,
    });
    await this.deps.repo.updateConversation(input.conversation.id, { state: "closed", stateReason: reason });
    return { kind: "failed", message: finished ?? message, reason, detail };
  }

  private async classifyFailure(
    error: unknown,
    message: PactMessageRecord,
    input: PactTurnInput,
    wasProcessing: boolean,
  ): Promise<PactTurnResult> {
    const effectful = input.kind === "operation" && input.effectClass !== "inspect";
    if (wasProcessing) {
      // We saw "still processing" and then lost track: the turn exists on the provider.
      return this.unknown(message, input, "provider_still_processing");
    }
    if (error instanceof DelegationTokenRejectedError) {
      const finished = await this.deps.repo.finishAttempt(message.id, this.deps.leaseOwner, {
        state: "failed",
        stateReason: "delegation_rejected",
      });
      return {
        kind: "failed",
        message: finished ?? message,
        reason: "delegation_rejected",
        detail: "The business no longer accepts this permission; reconnect to continue",
      };
    }
    if (error instanceof A2AError) {
      switch (error.reason) {
        case "UNSUPPORTED_OPERATION":
          return this.closeConversation(message, input, "context_closed", "The business closed this conversation");
        case "INVALID_PARAMS":
          if (input.conversation.contextId) {
            return this.closeConversation(
              message,
              input,
              "foreign_context",
              "The business does not accept this conversation for this account",
            );
          }
          return this.notExecuted(message, input, "not_executed", `The business rejected the message: ${error.message}`);
        case "CONTENT_TYPE_NOT_SUPPORTED":
        case "TASK_NOT_FOUND":
        case "PUSH_NOTIFICATION_NOT_SUPPORTED":
          return this.notExecuted(message, input, "not_executed", error.message);
        default:
          // INTERNAL or unknown: the provider may have acted before failing.
          return effectful
            ? this.unknown(message, input, `provider_error_${error.reason || error.status}`)
            : this.notExecuted(message, input, "not_executed", error.message);
      }
    }
    if (error instanceof A2AHttpError) {
      if (error.status === 401) {
        return this.notExecuted(message, input, "identity_rejected", "The business did not accept CoWork's identity");
      }
      if (error.status === 404) {
        return this.notExecuted(message, input, "business_not_found", "The business agent was not found");
      }
      if (error.status >= 500 && effectful) {
        return this.unknown(message, input, `http_${error.status}`);
      }
      return this.notExecuted(message, input, "not_executed", `The business returned HTTP ${error.status}`);
    }
    if (error instanceof PactTransportError) {
      if (
        error.code === "policy_denied" ||
        error.code === "invalid_url" ||
        error.code === "destination_refused"
      ) {
        return this.notExecuted(message, input, "policy_denied", error.message);
      }
      if (error.code === "rate_limited") {
        return this.notExecuted(message, input, "rate_limited", "The business is rate limiting requests");
      }
      if (error.code === "aborted") {
        // Cancel in flight: the dispatched operation may have happened.
        return this.unknown(message, input, "cancelled_in_flight");
      }
      return this.unknown(message, input, `transport_${error.code}`);
    }
    // A 2xx body CoWork cannot parse means the provider did something CoWork cannot read.
    return this.unknown(message, input, "unreadable_response");
  }
}
