import type Database from "better-sqlite3";
import { StatementPort } from "../database/statements/statement-port";
import {
  CONTROL_PLANE_STATEMENTS,
  type ControlPlaneStatementName,
} from "./control-plane-statements";
import type { CONTROL_PLANE_UNITS } from "./control-plane-units";

export type ControlPlaneStatementPort = StatementPort<
  ControlPlaneStatementName,
  typeof CONTROL_PLANE_UNITS
>;

/**
 * The control plane's port: worker-backed when the runtime routes the control plane
 * (`COWORK_DB_WORKER_CONTROL_PLANE`). Its planner statements run in sequences with host
 * work in between, so the worker backend keeps each operation's sequences uninterrupted
 * (see `statement-burst.ts`).
 */
export function createControlPlaneStatementPort(db: Database.Database): ControlPlaneStatementPort {
  return new StatementPort(db, "controlPlane", CONTROL_PLANE_STATEMENTS, { serializeBursts: true });
}

const ports = new WeakMap<Database.Database, ControlPlaneStatementPort>();

/** The control-plane port for `db`, created once per connection (for request handlers). */
export function controlPlaneStatements(db: Database.Database): ControlPlaneStatementPort {
  let port = ports.get(db);
  if (!port) {
    port = createControlPlaneStatementPort(db);
    ports.set(db, port);
  }
  return port;
}
