import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  isReadStatement,
  requireSqlParams,
  resolveStatementSql,
  StatementCatalogError,
  type SqlParam,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import { record, str } from "../database/statements/unit-args";
import { MAILBOX_STATEMENTS, type MailboxStatementName } from "./mailbox-statements";

/**
 * Mailbox transaction units (async SQLite migration plan, DB6). A thread sync used to run
 * several statements per message, each its own round trip on the worker backend; these
 * two units make it two: one snapshot of every row the upsert consults, then every write
 * in one transaction. The units run the mailbox catalog's own statements, so both
 * backends and the per-statement path share the SQL.
 */

function array(value: unknown, path: string, maxLength = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new StatementCatalogError(`${path} must be an array of at most ${maxLength} values`);
  }
  return value;
}

function statement(db: Database.Database, name: MailboxStatementName) {
  return db.prepare(resolveStatementSql(MAILBOX_STATEMENTS, name));
}

function statementName(value: unknown, path: string): MailboxStatementName {
  const name = str(value, path, 200);
  if (!Object.prototype.hasOwnProperty.call(MAILBOX_STATEMENTS, name)) {
    throw new StatementCatalogError(`${path} is not a mailbox statement`);
  }
  return name as MailboxStatementName;
}

function writeStatement(
  value: unknown,
  path: string,
): { name: MailboxStatementName; params: SqlParam[] } {
  const entry = record(value, path);
  const name = statementName(entry.name, `${path}.name`);
  if (isReadStatement(resolveStatementSql(MAILBOX_STATEMENTS, name))) {
    throw new StatementCatalogError(`${path}.name reads; a write op runs a write statement`);
  }
  return { name, params: requireSqlParams(entry.params) };
}

export interface MailboxThreadUpsertStateInput {
  threadId: string;
  accountId: string;
  messages: Array<{ id: string; providerMessageId: string; attachmentIds: string[] }>;
}

export interface MailboxThreadUpsertState {
  existing: Record<string, unknown> | undefined;
  localMessages: Array<{ id: string; is_unread: number }>;
  messages: Record<
    string,
    {
      previousThreadId: string | null;
      duplicates: Array<{ id: string; thread_id: string }>;
      existingAttachmentIds: string[];
      embeddingHash: string | null;
    }
  >;
  attachments: Record<string, { textContent: string | null; embeddingHash: string | null }>;
}

/** One write of a thread upsert, applied in order by `mailbox_applyThreadWrites`. */
export type MailboxThreadWrite =
  | { kind: "run"; name: MailboxStatementName; params: SqlParam[] }
  /** Best-effort statements (search index, embeddings): a failure skips the rest of the group. */
  | { kind: "optional"; statements: Array<{ name: MailboxStatementName; params: SqlParam[] }> }
  | { kind: "deleteThreadIfEmpty"; threadId: string };

function validateStateInput(args: unknown): [MailboxThreadUpsertStateInput] {
  const [raw] = array(args, "args");
  const input = record(raw, "args[0]");
  return [
    {
      threadId: str(input.threadId, "args[0].threadId", 500),
      accountId: str(input.accountId, "args[0].accountId", 500),
      messages: array(input.messages, "args[0].messages").map((value, index) => {
        const message = record(value, `args[0].messages[${index}]`);
        return {
          id: str(message.id, `args[0].messages[${index}].id`, 500),
          providerMessageId: str(
            message.providerMessageId,
            `args[0].messages[${index}].providerMessageId`,
            1_000,
          ),
          attachmentIds: array(
            message.attachmentIds,
            `args[0].messages[${index}].attachmentIds`,
          ).map((id, attachmentIndex) =>
            str(id, `args[0].messages[${index}].attachmentIds[${attachmentIndex}]`, 500),
          ),
        };
      }),
    },
  ];
}

function validateWrites(args: unknown): [MailboxThreadWrite[]] {
  const [raw] = array(args, "args");
  return [
    array(raw, "args[0]").map((value, index): MailboxThreadWrite => {
      const path = `args[0][${index}]`;
      const op = record(value, path);
      if (op.kind === "run") return { kind: "run", ...writeStatement(op, path) };
      if (op.kind === "optional") {
        return {
          kind: "optional",
          statements: array(op.statements, `${path}.statements`).map((entry, entryIndex) =>
            writeStatement(entry, `${path}.statements[${entryIndex}]`),
          ),
        };
      }
      if (op.kind === "deleteThreadIfEmpty") {
        return { kind: "deleteThreadIfEmpty", threadId: str(op.threadId, `${path}.threadId`, 500) };
      }
      throw new StatementCatalogError(`${path}.kind is not a thread write`);
    }),
  ];
}

function readThreadUpsertState(
  db: Database.Database,
  input: MailboxThreadUpsertStateInput,
): MailboxThreadUpsertState {
  const embeddingHash = (recordType: "message" | "attachment", recordId: string) =>
    (
      statement(db, "search_upsertEmbeddingForPlainText_1").get(recordType, recordId) as
        | { source_text_hash: string }
        | undefined
    )?.source_text_hash ?? null;
  const messages: MailboxThreadUpsertState["messages"] = {};
  const attachments: MailboxThreadUpsertState["attachments"] = {};
  for (const message of input.messages) {
    messages[message.id] = {
      previousThreadId:
        (statement(db, "upsertThread_4").get(message.id) as { thread_id: string } | undefined)
          ?.thread_id ?? null,
      duplicates: statement(db, "reconcileMailboxMessageIdentity_1").all(
        input.accountId,
        message.providerMessageId,
        message.id,
      ) as Array<{ id: string; thread_id: string }>,
      existingAttachmentIds: (
        statement(db, "upsertMessageAttachments_1").all(message.id) as Array<{ id: string }>
      ).map((row) => row.id),
      embeddingHash: embeddingHash("message", message.id),
    };
    for (const attachmentId of message.attachmentIds) {
      const row = statement(db, "getMailboxAttachment_1").get(attachmentId) as
        | { text_content?: string | null }
        | undefined;
      attachments[attachmentId] = {
        textContent: row?.text_content ?? null,
        embeddingHash: embeddingHash("attachment", attachmentId),
      };
    }
  }
  return {
    existing: statement(db, "upsertThread_1").get(input.threadId) as
      | Record<string, unknown>
      | undefined,
    localMessages: statement(db, "upsertThread_2").all(input.threadId) as Array<{
      id: string;
      is_unread: number;
    }>,
    messages,
    attachments,
  };
}

function deleteThreadIfEmpty(db: Database.Database, threadId: string): void {
  const row = statement(db, "deleteThreadIfEmpty_1").get(threadId) as { count: number } | undefined;
  if ((row?.count || 0) > 0) return;
  for (const name of [
    "deleteThreadIfEmpty_2",
    "deleteThreadIfEmpty_3",
    "deleteThreadIfEmpty_4",
    "deleteThreadIfEmpty_5",
    "deleteThreadIfEmpty_6",
    "deleteThreadIfEmpty_7",
    "deleteThreadIfEmpty_8",
    "deleteThreadIfEmpty_9",
  ] as const) {
    statement(db, name).run(threadId);
  }
}

function applyThreadWrites(db: Database.Database, writes: MailboxThreadWrite[]): void {
  for (const write of writes) {
    if (write.kind === "run") {
      statement(db, write.name).run(...write.params);
    } else if (write.kind === "deleteThreadIfEmpty") {
      deleteThreadIfEmpty(db, write.threadId);
    } else {
      try {
        // A savepoint: a failing best-effort group leaves the rest of the upsert intact.
        db.transaction(() => {
          for (const entry of write.statements) statement(db, entry.name).run(...entry.params);
        })();
      } catch {
        // Search indexes are best effort, as in the per-statement path.
      }
    }
  }
}

export const MAILBOX_UNITS = {
  mailbox_threadUpsertState: defineReadUnit(validateStateInput, (db, [input]) =>
    readThreadUpsertState(db, input),
  ),
  mailbox_applyThreadWrites: defineUnit(validateWrites, (db, [writes]) =>
    applyThreadWrites(db, writes),
  ),
} satisfies UnitCatalog;
