import { serviceRepositoryFacade } from "../database/service-statements";
import type { ChannelDecisionStore } from "./ChannelDecisionStore";
export const ChannelDecisionRepository = serviceRepositoryFacade<
  ChannelDecisionStore,
  | "initialize"
  | "get"
  | "create"
  | "beginDelivery"
  | "delivered"
  | "deliveryUnknown"
  | "claim"
  | "finish"
>("channelDecision_", [
  "initialize",
  "get",
  "create",
  "beginDelivery",
  "delivered",
  "deliveryUnknown",
  "claim",
  "finish",
]);
