import { BotWorkControlStore } from "./BotWorkControlStore";
import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { BotResponsibilityStore } from "./responsibility-store";
import {
  responsibilityEventAdmissionSnapshot,
  responsibilityEventMatchesSourceInstance,
  type ResponsibilityAdmissionSnapshot,
} from "./responsibility-event-admission";
import type { BotResponsibility } from "../../shared/bot-responsibility";
import type { EventTrigger, TriggerEvent } from "../triggers/types";
import {
  assertResponsibilityTaskPolicy,
  assertResponsibilityHistoryPolicy,
  claimResponsibilityActionReviewInUnit,
  findReusableResponsibilityActionReviewInUnit,
  finishResponsibilityActionReviewInUnit,
  responsibilityActionReviewContextInUnit,
  responsibilityReviewTargetGrantInUnit,
  readResponsibilityChannelHistoryInUnit,
  responsibilityActionReviewCanWaitInUnit,
  type ResponsibilityActionReviewClaimInput,
} from "./responsibility-task-policy";
const make = (db: Database.Database) => new BotResponsibilityStore(db);
export const BOT_RESPONSIBILITY_UNITS = {
  botWorkControl_futurePaused: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "futurePaused",
    { readonly: true },
  ),
  botWorkControl_futureState: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "futureState",
    { readonly: true },
  ),
  botWorkControl_syncGraphs: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "syncGraphs",
    { readonly: false },
  ),
  botWorkControl_activeGraphRoots: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "activeGraphRoots",
    { readonly: true },
  ),
  botWorkControl_recoverable: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "recoverable",
    { readonly: true },
  ),
  botWorkControl_assertNotStopped: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "assertNotStopped",
    { readonly: true },
  ),
  botWorkControl_assertTarget: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "assertTarget",
    { readonly: true },
  ),
  botWorkControl_begin: storeUnit((db: Database.Database) => new BotWorkControlStore(db), "begin", {
    readonly: false,
  }),
  botWorkControl_read: storeUnit((db: Database.Database) => new BotWorkControlStore(db), "read", {
    readonly: true,
  }),
  botWorkControl_record: storeUnit(
    (db: Database.Database) => new BotWorkControlStore(db),
    "record",
    { readonly: false },
  ),
  botResponsibility_setFutureControl: storeUnit(make, "setFutureControl", { readonly: false }),
  botResponsibility_getForEventTrigger: storeUnit(make, "getForEventTrigger", { readonly: true }),
  botResponsibility_signalContext: storeUnit(make, "signalContext", { readonly: true }),
  botResponsibility_assertHistoryPolicy: storeUnit(
    (db: Database.Database) => ({
      assertHistoryPolicy: (taskId: string, input: unknown, runtime: string) =>
        assertResponsibilityHistoryPolicy(db, taskId, input, runtime),
    }),
    "assertHistoryPolicy",
    { readonly: true },
  ),
  botResponsibility_readChannelHistory: storeUnit(
    (db: Database.Database) => ({
      readChannelHistory: (
        taskId: string,
        channelType: string,
        channelId: string,
        chatId: string,
        sinceMs: number | null,
        direction: "incoming" | "outgoing" | "both",
        limit: number,
        runtime: string,
      ) =>
        readResponsibilityChannelHistoryInUnit(
          db,
          taskId,
          channelType,
          channelId,
          chatId,
          sinceMs,
          direction,
          limit,
          runtime,
        ),
    }),
    "readChannelHistory",
    { readonly: true },
  ),
  botResponsibility_activationIssues: storeUnit(make, "activationIssues", { readonly: true }),
  botResponsibility_assertRunnable: storeUnit(make, "assertRunnable", { readonly: true }),
  botResponsibility_setState: storeUnit(make, "setState", { readonly: false }),
  botResponsibility_assertTaskPolicy: storeUnit(
    (db: Database.Database) => ({
      assertTaskPolicy: (
        taskId: string,
        workspaceId: string,
        operation: import("./responsibility-task-policy").TrustedResponsibilityOperation | null,
        runtime?: string,
        phase?: "tool" | "start",
        allowSelectedActionReview?: boolean,
      ) =>
        assertResponsibilityTaskPolicy(
          db,
          taskId,
          workspaceId,
          operation,
          runtime,
          phase,
          allowSelectedActionReview,
        ),
    }),
    "assertTaskPolicy",
    { readonly: true },
  ),
  botResponsibility_reviewTargetGrant: storeUnit(
    (db: Database.Database) => ({
      grant: (taskId: string, canonicalPath: string) =>
        responsibilityReviewTargetGrantInUnit(db, taskId, canonicalPath),
    }),
    "grant",
    { readonly: true },
  ),
  botResponsibility_actionReviewContext: storeUnit(
    (db: Database.Database) => ({
      context: (
        taskId: string,
        workspaceId: string,
        workspacePath: string,
        canonicalPath: string,
        runtime: string,
      ) =>
        responsibilityActionReviewContextInUnit(
          db,
          taskId,
          workspaceId,
          workspacePath,
          canonicalPath,
          runtime,
        ),
    }),
    "context",
    { readonly: true },
  ),
  botResponsibility_claimActionReview: storeUnit(
    (db: Database.Database) => ({
      claim: (input: ResponsibilityActionReviewClaimInput) =>
        claimResponsibilityActionReviewInUnit(db, input),
    }),
    "claim",
    { readonly: false },
  ),
  botResponsibility_findReusableActionReview: storeUnit(
    (db: Database.Database) => ({
      find: (
        taskId: string,
        workspaceId: string,
        workspacePath: string,
        proposed: import("./responsibility-task-policy").ResponsibilityActionReviewPayload,
        runtime: string,
      ) =>
        findReusableResponsibilityActionReviewInUnit(
          db,
          taskId,
          workspaceId,
          workspacePath,
          proposed,
          runtime,
        ),
    }),
    "find",
    { readonly: true },
  ),
  botResponsibility_actionReviewCanWait: storeUnit(
    (db: Database.Database) => ({
      canWait: (approvalId: string, taskId: string, requestRevisionHash: string) =>
        responsibilityActionReviewCanWaitInUnit(db, approvalId, taskId, requestRevisionHash),
    }),
    "canWait",
    { readonly: true },
  ),
  botResponsibility_finishActionReview: storeUnit(
    (db: Database.Database) => ({
      finish: (
        approvalId: string,
        requestRevisionHash: string,
        executionId: string,
        outcome: "committed" | "uncertain",
      ) =>
        finishResponsibilityActionReviewInUnit(
          db,
          approvalId,
          requestRevisionHash,
          executionId,
          outcome,
        ),
    }),
    "finish",
    { readonly: false },
  ),
  botResponsibility_engines: storeUnit(make, "engines", { readonly: true }),
  botResponsibility_preview: storeUnit(make, "preview", { readonly: true }),
  botResponsibility_getForCronJob: storeUnit(make, "getForCronJob", { readonly: true }),
  botResponsibility_getForEngine: storeUnit(make, "getForEngine", { readonly: true }),
  botResponsibility_eventAdmissionSnapshot: storeUnit(
    (db: Database.Database) => ({
      capture: (binding: BotResponsibility, trigger: EventTrigger) =>
        responsibilityEventAdmissionSnapshot(db, binding, trigger),
    }),
    "capture",
    { readonly: true },
  ),
  botResponsibility_eventSourceMatches: storeUnit(
    (db: Database.Database) => ({
      matches: (
        trigger: EventTrigger,
        event: TriggerEvent,
        snapshot: ResponsibilityAdmissionSnapshot,
      ) => responsibilityEventMatchesSourceInstance(db, trigger, event, snapshot),
    }),
    "matches",
    { readonly: true },
  ),
  botResponsibility_list: storeUnit(make, "list", { readonly: true }),
  botResponsibility_get: storeUnit(make, "get", { readonly: true }),
  botResponsibility_create: storeUnit(make, "create", { readonly: false }),
  botResponsibility_revise: storeUnit(make, "revise", { readonly: false }),
};
