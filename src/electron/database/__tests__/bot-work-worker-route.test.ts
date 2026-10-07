import { afterEach, describe, expect, it, vi } from "vitest";
import { BotWorkRepository, BotWorkResultRepository } from "../repository-facades";
import {
  setStatementClient,
  setReportReaderClient,
  type StatementClient,
} from "../statements/statement-route";

describe("bot work storage routing", () => {
  afterEach(() => {
    setStatementClient(null, null, null);
    setReportReaderClient(null, null);
  });
  it("runs the projection as a read unit on the configured reporting worker", async () => {
    const filename = "/tmp/cowork-bot-work-route.db";
    const execute = vi.fn().mockResolvedValue({
      items: [],
      counts: { needs_you: 0, working: 0, scheduled: 0, results: 0 },
    });
    const writerExecute = vi.fn();
    setStatementClient("storage", filename, {
      execute: writerExecute,
    } as unknown as StatementClient);
    setReportReaderClient(filename, { execute } as unknown as StatementClient);
    const repository = new BotWorkRepository({ name: filename, memory: false } as never);
    const query = {
      workspaceId: "workspace",
      agentRoleId: "user-bot",
      view: "working" as const,
      limit: 25,
    };
    await repository.list(query);
    expect(execute).toHaveBeenCalledWith(
      "statements.readUnit",
      expect.objectContaining({ domain: "storage", name: "botWork_list" }),
    );
    expect(writerExecute).not.toHaveBeenCalled();
    await new BotWorkResultRepository({ name: filename, memory: false } as never).manifest({
      workspaceId: "workspace",
      agentRoleId: "user-bot",
      taskId: "task",
    });
    expect(execute).toHaveBeenLastCalledWith(
      "statements.readUnit",
      expect.objectContaining({ domain: "storage", name: "botWorkResult_manifest" }),
    );
    expect(writerExecute).not.toHaveBeenCalled();
  });
});
