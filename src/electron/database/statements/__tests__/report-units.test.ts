import { afterEach, describe, expect, it } from "vitest";
import { StatementPort } from "../statement-port";
import {
  setReportReaderClient,
  setStatementClient,
  type StatementClient,
} from "../statement-route";

// Report-style read units run on the reporting reader when one is registered (DB6).

function client(name: string, log: string[]): StatementClient {
  return {
    execute: (command: string, args: { name: string }) => {
      log.push(`${name}:${command}:${args.name}`);
      return Promise.resolve([]);
    },
  } as unknown as StatementClient;
}

const db = { name: "/tmp/cowork-report-units.db", memory: false } as never;

describe("report units", () => {
  afterEach(() => {
    setStatementClient(null, null, null);
    setReportReaderClient(null, null);
  });

  it("runs report units on the reader, other units on the writer", async () => {
    const log: string[] = [];
    setStatementClient("controlPlane", "/tmp/cowork-report-units.db", client("writer", log));
    const port = new StatementPort<never>(db, "controlPlane", {});
    await port.unit("controlPlane_summarizeCosts" as never, [{}] as never);
    setReportReaderClient("/tmp/cowork-report-units.db", client("reader", log));
    await port.unit("controlPlane_summarizeCosts" as never, [{}] as never);
    await port.unit("controlPlane_listIssues" as never, [] as never);
    await port.unit("controlPlane_createIssue" as never, [{}] as never);
    expect(log).toEqual([
      "writer:statements.readUnit:controlPlane_summarizeCosts",
      "reader:statements.readUnit:controlPlane_summarizeCosts",
      "writer:statements.readUnit:controlPlane_listIssues",
      "writer:statements.unit:controlPlane_createIssue",
    ]);
  });

  it("routes workspace listing to the reader but keeps workspace mutations on the writer", async () => {
    const log: string[] = [];
    setStatementClient("storage", "/tmp/cowork-report-units.db", client("writer", log));
    setReportReaderClient("/tmp/cowork-report-units.db", client("reader", log));
    const port = new StatementPort<never>(db, "storage", {});
    await port.unit("workspace_findAll" as never, [] as never);
    await port.unit("workspace_create" as never, [] as never);
    expect(log).toEqual([
      "reader:statements.readUnit:workspace_findAll",
      "writer:statements.unit:workspace_create",
    ]);
  });
});
