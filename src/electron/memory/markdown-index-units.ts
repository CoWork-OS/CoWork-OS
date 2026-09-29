import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { MarkdownIndexStore } from "./markdown-index-sql";

/** Markdown memory index units (async SQLite migration plan, DB6), part of the memory domain. */

const store = (db: Database.Database) => new MarkdownIndexStore(db);

export const MARKDOWN_INDEX_READS = [
  "listIndexedFiles",
  "recentFirstChunks",
  "getChunk",
  "chunksAround",
  "getChunks",
  "searchCandidates",
] as const;
export const MARKDOWN_INDEX_WRITES = ["applySync", "clearWorkspace", "deletePaths"] as const;

export const MARKDOWN_INDEX_UNITS = {
  markdown_listIndexedFiles: storeUnit(store, "listIndexedFiles", { readonly: true }),
  markdown_recentFirstChunks: storeUnit(store, "recentFirstChunks", { readonly: true }),
  markdown_getChunk: storeUnit(store, "getChunk", { readonly: true }),
  markdown_chunksAround: storeUnit(store, "chunksAround", { readonly: true }),
  markdown_getChunks: storeUnit(store, "getChunks", { readonly: true }),
  markdown_searchCandidates: storeUnit(store, "searchCandidates", { readonly: true }),
  markdown_applySync: storeUnit(store, "applySync", { readonly: false }),
  markdown_clearWorkspace: storeUnit(store, "clearWorkspace", { readonly: false }),
  markdown_deletePaths: storeUnit(store, "deletePaths", { readonly: false }),
} satisfies UnitCatalog;
