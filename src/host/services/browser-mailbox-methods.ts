import type Database from "better-sqlite3";
import { z } from "zod";
import { MailboxService, getMailboxServiceInstance } from "../../electron/mailbox/MailboxService";
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

/** Mailbox records stay in the active host profile; browser input cannot name host files. */
export function createBrowserMailboxDefinitions(db: Database.Database): {
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
