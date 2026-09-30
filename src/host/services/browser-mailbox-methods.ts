import type Database from "better-sqlite3";
import { z } from "zod";
import { MailboxService, getMailboxServiceInstance } from "../../electron/mailbox/MailboxService";
import type { ChannelGateway } from "../../electron/gateway";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";

const id = z.string().trim().min(1).max(200);
const limit = z.number().int().min(1).max(100).optional();
const threadQuery = z
  .object({
    accountId: id.optional(),
    query: z.string().max(4000).optional(),
    category: z
      .enum([
        "priority",
        "calendar",
        "follow_up",
        "promotions",
        "updates",
        "personal",
        "other",
        "all",
      ])
      .optional(),
    todayBucket: z
      .enum(["needs_action", "happening_today", "good_to_know", "more_to_browse", "all"])
      .optional(),
    domainCategory: z
      .enum([
        "travel",
        "packages",
        "receipts",
        "bills",
        "shopping",
        "newsletters",
        "events",
        "finance",
        "customer",
        "hiring",
        "approvals",
        "ops",
        "personal",
        "other",
        "all",
      ])
      .optional(),
    mailboxView: z.enum(["inbox", "sent", "all"]).optional(),
    folderId: id.optional(),
    labelId: id.optional(),
    savedViewId: id.optional(),
    scheduledOnly: z.boolean().optional(),
    draftOnly: z.boolean().optional(),
    queuedOnly: z.boolean().optional(),
    unreadOnly: z.boolean().optional(),
    needsReply: z.boolean().optional(),
    hasSuggestedProposal: z.boolean().optional(),
    hasOpenCommitment: z.boolean().optional(),
    cleanupCandidate: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    attachmentQuery: z.string().max(4000).optional(),
    sortBy: z.enum(["priority", "recent"]).optional(),
    limit,
  })
  .strict()
  .optional();

const cronSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), atMs: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal("every"),
      everyMs: z.number().int().positive(),
      anchorMs: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().trim().min(1).max(200),
      tz: z.string().max(100).optional(),
    })
    .strict(),
]);
const mailboxConditionOperator = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "matches",
  "starts_with",
  "ends_with",
  "gt",
  "lt",
]);
const commitmentState = z.enum(["suggested", "accepted", "done", "dismissed"]);
const mailboxDraftOptions = z
  .object({
    tone: z.enum(["concise", "warm", "direct", "executive"]).optional(),
    includeAvailability: z.boolean().optional(),
    allowNoreplySender: z.boolean().optional(),
  })
  .strict();
const mailboxRuleRecipe = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    workspaceId: id.optional(),
    threadId: id.optional(),
    source: z.literal("mailbox_event").optional(),
    conditions: z
      .array(
        z
          .object({
            field: z.string().trim().min(1).max(100),
            operator: mailboxConditionOperator,
            value: z.string().max(4000),
          })
          .strict(),
      )
      .max(50),
    conditionLogic: z.enum(["all", "any"]).optional(),
    actionType: z.enum(["create_task", "wake_agent"]),
    actionTitle: z.string().max(500).optional(),
    actionPrompt: z.string().max(100_000),
    agentRoleId: id.optional(),
    cooldownMs: z.number().int().min(0).max(31_536_000_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const mailboxScheduleRecipe = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    workspaceId: id.optional(),
    threadId: id.optional(),
    kind: z.enum(["rule", "schedule", "reminder", "forward"]).optional(),
    schedule: cronSchedule,
    taskTitle: z.string().trim().min(1).max(500),
    taskPrompt: z.string().max(100_000),
    enabled: z.boolean().optional(),
  })
  .strict();
const mailboxForwardRecipe = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    workspaceId: id.optional(),
    threadId: id.optional(),
    providerThreadId: z.string().max(1000).optional(),
    schedule: cronSchedule,
    targetEmail: z.string().trim().email().max(320),
    allowedSenders: z.array(z.string().trim().email().max(320)).max(100),
    allowedDomains: z.array(z.string().trim().min(1).max(253)).max(100),
    excludedSenders: z.array(z.string().trim().email().max(320)).max(100).optional(),
    excludedDomains: z.array(z.string().trim().min(1).max(253)).max(100).optional(),
    subjectKeywords: z.array(z.string().max(500)).max(100).optional(),
    attachmentKeywords: z.array(z.string().max(500)).max(100).optional(),
    attachmentExtensions: z.array(z.string().max(32)).max(50).optional(),
    dryRun: z.boolean().optional(),
    maxMessagesPerRun: z.number().int().min(1).max(1000).optional(),
    backfillDays: z.number().int().min(0).max(3650).optional(),
    lookbackMinutes: z.number().int().min(0).max(525_600).optional(),
    gmailQuery: z.string().max(4000).optional(),
    forwardedLabelName: z.string().max(200).optional(),
    rejectedLabelName: z.string().max(200).optional(),
    candidateLabelName: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Mailbox records stay in the active host profile; browser input cannot name host files. */
export function createBrowserMailboxDefinitions(
  db: Database.Database,
  channelGateway?: Pick<ChannelGateway, "sendMessage">,
): {
  definitions: BrowserDesktopDefinitions;
  dispose: () => void;
} {
  const existing = getMailboxServiceInstance();
  const mailbox = existing ?? new MailboxService(db, { autoSync: false });
  const definitions: BrowserDesktopDefinitions = {};
  const add = <T extends unknown[]>(
    name: string,
    schema: z.ZodType<T>,
    handler: (args: T) => unknown,
    mutation = false,
  ) => {
    definitions[name] = {
      capability: "mailbox.manage",
      mutation,
      validate: (args) => schema.parse(args) as unknown[],
      handler: async (args) => hideLocalPaths(await handler(args as T)),
    };
  };
  const noArgs = z.tuple([]);
  const oneId = z.tuple([id]);
  // A tuple's optional trailing arguments may be omitted by the browser.
  const optional = <T>(schema: z.ZodType<T>) =>
    z
      .array(z.unknown())
      .max(1)
      .transform((args): [T] => [schema.parse(args[0])]);
  add("getMailboxSyncStatus", noArgs, () => mailbox.getSyncStatus());
  add("getMailboxClientState", noArgs, () => mailbox.getMailboxClientState());
  add("listMailboxThreads", optional(threadQuery), ([query]) => mailbox.listThreads(query));
  add("getMailboxThread", oneId, ([threadId]) => mailbox.getThread(threadId));
  add("getMailboxDigest", optional(id.optional()), ([workspaceId]) =>
    mailbox.getMailboxDigest(workspaceId),
  );
  add(
    "getMailboxTodayDigest",
    optional(z.object({ limitPerBucket: limit }).strict().optional()),
    ([request]) => mailbox.getMailboxTodayDigest(request),
  );
  add(
    "getMailboxSenderCleanupDigest",
    optional(z.object({ limit }).strict().optional()),
    ([request]) => mailbox.getMailboxSenderCleanupDigest(request),
  );
  add("listMailboxSnippets", noArgs, () => mailbox.listMailboxSnippets());
  add("listMailboxSavedViews", noArgs, () => mailbox.listMailboxSavedViews());
  add(
    "getMailboxQuickReplySuggestions",
    oneId,
    ([threadId]) => mailbox.getMailboxQuickReplySuggestions(threadId),
    true,
  );
  add("listThreadMailboxAutomations", oneId, ([threadId]) =>
    mailbox.listThreadAutomations(threadId),
  );
  add(
    "listMailboxAutomations",
    optional(z.object({ workspaceId: id.optional(), threadId: id.optional() }).strict().optional()),
    ([request]) => mailbox.listMailboxAutomations(request),
  );
  add(
    "listMailboxEvents",
    z
      .array(z.unknown())
      .max(2)
      .transform((args): [number | undefined, string | undefined] => [
        limit.parse(args[0]),
        id.optional().parse(args[1]),
      ]),
    ([count, threadId]) => mailbox.listMailboxEvents(count, threadId),
  );
  add(
    "syncMailbox",
    z
      .array(z.unknown())
      .max(2)
      .transform((args): [number | undefined, "auto" | "manual" | undefined] => [
        limit.parse(args[0]),
        z.enum(["auto", "manual"]).optional().parse(args[1]),
      ]),
    ([count, source]) => mailbox.sync(count, { source: source ?? "manual" }),
    true,
  );
  add("summarizeMailboxThread", oneId, ([threadId]) => mailbox.summarizeThread(threadId), true);
  add(
    "extractMailboxCommitments",
    oneId,
    ([threadId]) => mailbox.extractCommitments(threadId),
    true,
  );
  add("scheduleMailboxReply", oneId, ([threadId]) => mailbox.scheduleReply(threadId), true);
  add("researchMailboxContact", oneId, ([threadId]) => mailbox.researchContact(threadId), true);
  add("reclassifyMailboxThread", oneId, ([threadId]) => mailbox.reclassifyThread(threadId), true);
  add(
    "reviewMailboxBulkAction",
    z.tuple([z.object({ type: z.enum(["cleanup", "follow_up"]), limit }).strict()]),
    ([request]) => mailbox.reviewBulkAction(request),
    true,
  );
  add(
    "askMailbox",
    z.tuple([
      z
        .object({
          query: z.string().trim().min(1).max(8000),
          limit,
          includeAnswer: z.boolean().optional(),
          runId: id.optional(),
        })
        .strict(),
    ]),
    ([request]) => mailbox.askMailbox(request),
    true,
  );
  add(
    "upsertMailboxSnippet",
    z.tuple([
      z
        .object({
          id: id.optional(),
          shortcut: z.string().trim().min(1).max(100),
          body: z.string().max(64000),
          subjectHint: z.string().max(500).optional(),
        })
        .strict(),
    ]),
    ([request]) => mailbox.upsertMailboxSnippet(request),
    true,
  );
  add(
    "deleteMailboxSnippet",
    oneId,
    ([snippetId]) => mailbox.deleteMailboxSnippet(snippetId),
    true,
  );
  add("deleteMailboxSavedView", oneId, ([viewId]) => mailbox.deleteMailboxSavedView(viewId), true);
  add(
    "applyMailboxAction",
    z.tuple([
      z
        .object({
          type: z.enum([
            "cleanup_local",
            "mark_done",
            "archive",
            "trash",
            "mark_read",
            "mark_unread",
            "move",
            "label",
            "remove_label",
            "snooze",
            "waiting_on",
            "undo",
            "discard_draft",
            "dismiss_proposal",
          ]),
          threadId: id.optional(),
          proposalId: id.optional(),
          label: z.string().max(500).optional(),
          folderId: id.optional(),
          labelId: id.optional(),
          snoozeUntil: z.number().int().positive().optional(),
          draftId: id.optional(),
          commitmentId: id.optional(),
          actionId: id.optional(),
        })
        .strict()
        .refine(
          (request) => Boolean(request.threadId || request.proposalId),
          "A thread or proposal is required",
        ),
    ]),
    ([request]) => mailbox.applyAction(request),
    true,
  );
  add("previewMailboxMissionControlHandoff", oneId, ([threadId]) =>
    mailbox.previewMissionControlHandoff(threadId),
  );
  add("listMailboxMissionControlHandoffs", oneId, ([threadId]) =>
    mailbox.listMissionControlHandoffs(threadId),
  );
  add(
    "createMailboxMissionControlHandoff",
    z.tuple([
      z
        .object({
          threadId: id,
          companyId: id,
          operatorRoleId: id,
          issueTitle: z.string().trim().min(1).max(500),
          issueSummary: z.string().max(20_000).optional(),
        })
        .strict(),
    ]),
    ([request]) => mailbox.createMissionControlHandoff(request),
    true,
  );
  add(
    "updateMailboxCommitmentDetails",
    z.tuple([
      id,
      z
        .object({
          title: z.string().max(1000).optional(),
          dueAt: z.number().int().positive().nullable().optional(),
          ownerEmail: z.string().max(320).nullable().optional(),
          state: commitmentState.optional(),
          sourceExcerpt: z.string().max(20_000).nullable().optional(),
        })
        .strict(),
    ]),
    ([commitmentId, patch]) => mailbox.updateCommitmentDetails(commitmentId, patch),
    true,
  );
  add(
    "updateMailboxCommitmentState",
    z.tuple([id, commitmentState]),
    ([commitmentId, state]) => mailbox.updateCommitmentState(commitmentId, state),
    true,
  );
  add(
    "generateMailboxDraft",
    z
      .array(z.unknown())
      .min(1)
      .max(2)
      .transform((args): [string, z.infer<typeof mailboxDraftOptions> | undefined] => [
        id.parse(args[0]),
        mailboxDraftOptions.optional().parse(args[1]),
      ]),
    ([threadId, options]) => mailbox.generateDraft(threadId, options),
    true,
  );
  add(
    "reclassifyMailboxAccount",
    z.tuple([
      z
        .object({
          accountId: id.optional(),
          threadId: id.optional(),
          scope: z.enum(["thread", "account", "backfill"]).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .refine((request) => Boolean(request.accountId), "An account is required"),
    ]),
    ([request]) => mailbox.reclassifyAccount(request),
    true,
  );
  add("retryMailboxAction", oneId, ([actionId]) => mailbox.retryMailboxAction(actionId), true);
  add(
    "extractMailboxAttachmentText",
    oneId,
    ([attachmentId]) => mailbox.extractMailboxAttachmentText(attachmentId),
    true,
  );
  add(
    "createMailboxRule",
    z.tuple([mailboxRuleRecipe]),
    ([recipe]) => mailbox.createMailboxRule(recipe),
    true,
  );
  add(
    "deleteMailboxRule",
    oneId,
    ([automationId]) => mailbox.deleteMailboxRule(automationId),
    true,
  );
  add(
    "createMailboxSchedule",
    z.tuple([mailboxScheduleRecipe]),
    ([recipe]) => mailbox.createMailboxSchedule(recipe),
    true,
  );
  add(
    "deleteMailboxSchedule",
    oneId,
    ([automationId]) => mailbox.deleteMailboxSchedule(automationId),
    true,
  );
  add(
    "createMailboxForward",
    z.tuple([mailboxForwardRecipe]),
    ([recipe]) => mailbox.createMailboxForward(recipe),
    true,
  );
  add(
    "deleteMailboxForward",
    oneId,
    ([automationId]) => mailbox.deleteMailboxForward(automationId),
    true,
  );
  add(
    "runMailboxForward",
    oneId,
    ([automationId]) => mailbox.runMailboxForward(automationId),
    true,
  );
  add(
    "previewMailboxSavedViewSimilar",
    z.tuple([
      z
        .object({
          seedThreadId: id,
          name: z.string().max(200),
          instructions: z.string().max(4000),
        })
        .strict(),
    ]),
    ([request]) => mailbox.previewMailboxLabelSimilar(request),
    true,
  );
  add(
    "createMailboxSavedView",
    z.tuple([
      z
        .object({
          name: z.string().trim().min(1).max(200),
          instructions: z.string().trim().min(1).max(4000),
          seedThreadId: id.optional(),
          threadIds: z.array(id).max(500),
          showInInbox: z.boolean().optional(),
        })
        .strict(),
    ]),
    ([request]) => mailbox.createMailboxSavedView(request),
    true,
  );
  if (channelGateway) {
    add(
      "replyViaChannel",
      z.tuple([
        z
          .object({
            threadId: id,
            handleId: id,
            channelType: z.enum(["slack", "teams", "whatsapp", "signal", "imessage"]),
            message: z.string().trim().min(1).max(100_000),
            parseMode: z.enum(["text", "markdown"]).optional(),
          })
          .strict(),
      ]),
      async ([request]) => {
        const target = (await mailbox.getReplyTargets(request.threadId)).find(
          (candidate) => candidate.handleId === request.handleId,
        );
        if (!target || target.channelType !== request.channelType) {
          throw new Error("The selected reply target is no longer available.");
        }
        await channelGateway.sendMessage(target.channelType, target.chatId, request.message, {
          channelDbId: target.channelId,
          parseMode: request.parseMode ?? "text",
        });
        return { ok: true, target };
      },
      true,
    );
  }
  return {
    definitions,
    dispose: () => {
      if (!existing) void mailbox.stop();
    },
  };
}

function hideLocalPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideLocalPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["localPath", "workspacePath", "keyPath", "attachmentPath"].includes(key))
      .map(([key, child]) => [key, hideLocalPaths(child)]),
  );
}
