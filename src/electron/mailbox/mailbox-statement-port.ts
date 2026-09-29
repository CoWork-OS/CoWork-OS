import type Database from "better-sqlite3";
import { StatementPort } from "../database/statements/statement-port";
import { MAILBOX_STATEMENTS, type MailboxStatementName } from "./mailbox-statements";
import type { MAILBOX_UNITS } from "./mailbox-units";

export type MailboxStatementPort = StatementPort<MailboxStatementName, typeof MAILBOX_UNITS>;

/**
 * The mailbox domain's statement port: worker-backed when the runtime routes mailbox.
 * Mailbox operations still run several statements with host work in between (message
 * encryption, thread normalization), so on the worker backend each operation's statement
 * sequences are kept uninterrupted, as the synchronous code guaranteed; see
 * `statement-burst.ts`. Mailbox services open an operation per public call with
 * `bindStatementContext`. Two transaction units turn a thread sync into two round trips
 * (see `mailbox-units.ts`), and reads use the reader connection when one is running.
 */
export function createMailboxStatementPort(db: Database.Database): MailboxStatementPort {
  return new StatementPort<MailboxStatementName, typeof MAILBOX_UNITS>(db, "mailbox", MAILBOX_STATEMENTS, {
    serializeBursts: true,
    // Mailbox list and search reads run on the reader connection when one is running.
    readsOnReader: true,
  });
}
