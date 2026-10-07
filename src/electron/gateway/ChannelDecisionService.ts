import { approvalDraftPresentation } from "../../shared/approval-draft-presentation";
import type { ApprovalRequest, SessionActionAttribution } from "../../shared/types";
import { validateGatewayOwnerIds } from "../../shared/gateway-owner-ids";
import { approvalRevisionMatches } from "../agent/approval-revision";
import type { ChannelDecisionRepository } from "./ChannelDecisionRepository";
import type { ChannelDecisionResolutionGuard, ChannelDecisionRoute } from "./ChannelDecisionStore";
import type { ChannelAdapter, ChannelDecisionEvent } from "./channels/types";
import { gatewaySenderRef } from "./gateway-sender-identity";

type Repository = InstanceType<typeof ChannelDecisionRepository>;
type DecisionChannel = {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
};
type ResponseStatus = "handled" | "duplicate" | "not_found" | "in_progress";
interface Dependencies {
  repository: Pick<
    Repository,
    "get" | "create" | "beginDelivery" | "delivered" | "deliveryUnknown" | "claim" | "finish"
  >;
  getSession(id: string): Promise<{ id: string; channelId: string } | undefined>;
  getChannel(id: string): Promise<DecisionChannel | undefined>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  describeApproval(request: ApprovalRequest): string;
  respond(input: {
    approvalId: string;
    approved: boolean;
    attribution: SessionActionAttribution;
    expectedRevisionHash: string;
    guard: ChannelDecisionResolutionGuard;
  }): Promise<ResponseStatus>;
}

/** Transport only. The central approval writer and daemon authorize resolution and execution. */
export class ChannelDecisionService {
  constructor(private readonly dependencies: Dependencies) {}

  private async authorize(
    channelId: string,
    actorId: string,
    type?: string,
  ): Promise<DecisionChannel> {
    const channel = await this.dependencies.getChannel(channelId);
    const owners = channel?.config.ownerUserIds;
    const parsed = Array.isArray(owners) ? validateGatewayOwnerIds(owners) : undefined;
    if (
      !channel ||
      channel.id !== channelId ||
      !channel.enabled ||
      !["slack", "teams"].includes(channel.type) ||
      (type && channel.type !== type) ||
      channel.config.decisionMessagesEnabled !== true ||
      !parsed?.ok ||
      !parsed.ids.includes(actorId)
    )
      throw new Error("Channel decision actor is not authorized");
    return channel;
  }

  async publish(input: {
    approvalId: string;
    sessionId: string;
    actorId: string;
  }): Promise<ChannelDecisionRoute> {
    const session = await this.dependencies.getSession(input.sessionId);
    if (!session || session.id !== input.sessionId) throw new Error("Decision session is missing");
    const channel = await this.authorize(session.channelId, input.actorId);
    const adapter = this.dependencies.getAdapter(channel.id);
    if (
      !adapter ||
      adapter.type !== channel.type ||
      adapter.status !== "connected" ||
      !adapter.sendDecision ||
      !adapter.decisionCapabilities?.approve ||
      !adapter.decisionCapabilities.deny
    )
      throw new Error("Channel decision adapter is unavailable");
    const route = await this.dependencies.repository.create(input);
    if (route.channelId !== channel.id || route.channelType !== channel.type)
      throw new Error("Channel decision destination changed");
    // Existing effects are never replayed, including ambiguous or interrupted publication.
    if (route.state !== "queued") return route;
    const request = await this.dependencies.getApproval(route.approvalId);
    if (
      !request ||
      request.status !== "pending" ||
      request.taskId !== route.taskId ||
      !approvalRevisionMatches(request, route.approvalRevisionHash)
    )
      throw new Error("Decision request changed");
    const summary = this.dependencies.describeApproval(request).trim().slice(0, 1800);
    if (!summary) throw new Error("Decision summary is missing");
    const draft = approvalDraftPresentation(request.details);
    const draftFiles =
      draft?.state === "bound"
        ? {
            present: draft.files.filter((file) => file.status === "present").length,
            missing: draft.files.filter((file) => file.status === "missing").length,
          }
        : undefined;
    const delivery = await this.dependencies.repository.beginDelivery(route.id);
    try {
      await this.authorize(delivery.channelId, delivery.actorId, delivery.channelType);
      if (this.dependencies.getAdapter(delivery.channelId) !== adapter)
        throw new Error("Decision adapter changed");
      const messageId = await adapter.sendDecision({
        routeId: delivery.id,
        chatId: delivery.chatId,
        title: "Approval required",
        summary,
        revisionHash: delivery.approvalRevisionHash,
        ...(draftFiles ? { draftFiles } : {}),
        expiresAt: delivery.expiresAt,
      });
      return await this.dependencies.repository.delivered(
        delivery.id,
        delivery.deliveryClaimId!,
        messageId,
      );
    } catch {
      // Any failure after claiming publication is uncertain. Never send a second card/text fallback.
      try {
        await this.dependencies.repository.deliveryUnknown(delivery.id, delivery.deliveryClaimId!);
      } catch {
        /* An interrupted receipt write leaves the durable delivering claim fenced. */
      }
      try {
        return (await this.dependencies.repository.get(delivery.id)) || delivery;
      } catch {
        return delivery;
      }
    }
  }

  async handle(
    channelId: string,
    event: ChannelDecisionEvent,
  ): Promise<ResponseStatus | "delivery_unknown"> {
    const route = await this.dependencies.repository.get(event.routeId);
    if (!route || route.channelId !== channelId || route.channelType !== event.channelType)
      throw new Error("Channel decision callback destination mismatch");
    await this.authorize(channelId, event.actorId, event.channelType);
    const claimed = await this.dependencies.repository.claim({ ...event, channelId });
    try {
      await this.authorize(channelId, claimed.actorId, claimed.channelType);
      const status = await this.dependencies.respond({
        approvalId: claimed.approvalId,
        approved: event.action === "approve",
        attribution: {
          principalId: gatewaySenderRef(claimed.channelType, claimed.actorId),
          role: "owner",
        },
        expectedRevisionHash: claimed.approvalRevisionHash,
        guard: { routeId: claimed.id, claimId: claimed.claimId! },
      });
      const outcome = status === "in_progress" ? "delivery_unknown" : status;
      await this.dependencies.repository.finish(claimed.id, claimed.claimId!, outcome);
      return status;
    } catch {
      try {
        await this.dependencies.repository.finish(claimed.id, claimed.claimId!, "delivery_unknown");
      } catch {
        /* Preserve the claim if the durable outcome cannot be written. */
      }
      return "delivery_unknown";
    }
  }
}
