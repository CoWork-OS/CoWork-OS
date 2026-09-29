import type Database from "better-sqlite3";
import type { UnitCatalog } from "../../database/statements/statement-catalog";
import { storeUnit } from "../../database/statements/store-units";
import { ChannelHistoryStore } from "./channel-history-sql";

const make = (db: Database.Database) => new ChannelHistoryStore(db);

/** Channel history read units (async SQLite migration plan, DB6), in the services domain. */
export const CHANNEL_HISTORY_UNITS = {
  channelHistory_chatSummaries: storeUnit(make, "chatSummaries", { readonly: true }),
  channelHistory_chatMessages: storeUnit(make, "chatMessages", { readonly: true }),
} satisfies UnitCatalog;
