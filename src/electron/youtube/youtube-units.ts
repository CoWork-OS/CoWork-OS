import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { YouTubeTranscriptSqlStore } from "./youtube-transcript-sql";

const make = (db: Database.Database) => new YouTubeTranscriptSqlStore(db);

/** YouTube transcript units (async SQLite migration plan, DB6), in the services domain. */
export const YOUTUBE_UNITS = {
  youtube_saveVideo: storeUnit(make, "saveVideo", { readonly: false }),
  youtube_saveSegments: storeUnit(make, "saveSegments", { readonly: false }),
  youtube_getVideo: storeUnit(make, "getVideo", { readonly: true }),
  youtube_listVideos: storeUnit(make, "listVideos", { readonly: true }),
  youtube_hasSegments: storeUnit(make, "hasSegments", { readonly: true }),
  youtube_search: storeUnit(make, "search", { readonly: true }),
} satisfies UnitCatalog;
