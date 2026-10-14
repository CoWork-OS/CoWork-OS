import { serviceRepositoryFacade } from "../database/service-statements";
import type { ApplicationOperationStore } from "./application-operation-store";

export class ApplicationOperationRepository extends serviceRepositoryFacade<
  ApplicationOperationStore,
  | "create"
  | "get"
  | "list"
  | "recoverable"
  | "recoverExpired"
  | "claim"
  | "renew"
  | "finish"
  | "requestCancel"
  | "requestExecute"
  | "resolveDecision"
  | "resolveUnknown"
  | "attempts"
  | "events"
  | "authorizesToolAttempt"
>("applicationOperation_", [
  "create",
  "get",
  "list",
  "recoverable",
  "recoverExpired",
  "claim",
  "renew",
  "finish",
  "requestCancel",
  "requestExecute",
  "resolveDecision",
  "resolveUnknown",
  "attempts",
  "events",
  "authorizesToolAttempt",
]) {}
