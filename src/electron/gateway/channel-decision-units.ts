import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { ChannelDecisionStore } from "./ChannelDecisionStore";
const make = (db: Database.Database) => new ChannelDecisionStore(db);
export const CHANNEL_DECISION_UNITS = {
  channelDecision_initialize: storeUnit(make, "initialize", { readonly: false }),
  channelDecision_get: storeUnit(make, "get", { readonly: true }),
  channelDecision_create: storeUnit(make, "create", { readonly: false }),
  channelDecision_beginDelivery: storeUnit(make, "beginDelivery", { readonly: false }),
  channelDecision_delivered: storeUnit(make, "delivered", { readonly: false }),
  channelDecision_deliveryUnknown: storeUnit(make, "deliveryUnknown", { readonly: false }),
  channelDecision_claim: storeUnit(make, "claim", { readonly: false }),
  channelDecision_finish: storeUnit(make, "finish", { readonly: false }),
};
