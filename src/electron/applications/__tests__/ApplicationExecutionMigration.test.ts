import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { WorkSessionProtocolRepository } from "../../database/WorkSessionProtocolRepository";
import { ApplicationOperationRepository } from "../ApplicationOperationRepository";
import {
  ApplicationOperationRequestSchema,
  ApplicationRouteSchema,
} from "../../../shared/application-execution";

it("adds application tables to a real older profile and preserves legacy tasks and operation history on subsequent opens", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-application-upgrade-"));
  const dbPath = path.join(directory, "profile.db");
  let manager: DatabaseManager | undefined;
  try {
    manager = new DatabaseManager({ dbPath });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Existing workspace", directory, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const task = new TaskStore(db).create({
      title: "Existing task",
      prompt: "Preserve the source",
      status: "paused",
      workspaceId: workspace.id,
    });
    const session = new WorkSessionProtocolRepository(db).ensureForTask({
      taskId: task.id,
      workspaceId: workspace.id,
      status: "paused",
    }).session;
    db.exec(
      "DROP TABLE application_operation_events; DROP TABLE application_resource_locks; DROP TABLE application_operation_attempts; DROP TABLE application_operations;",
    );
    manager.close();
    manager = new DatabaseManager({ dbPath });
    expect(new TaskStore(manager.getDatabase()).findById(task.id)?.prompt).toBe(
      "Preserve the source",
    );
    const repository = new ApplicationOperationRepository(manager.getDatabase());
    const operation = await repository.create(
      ApplicationOperationRequestSchema.parse({
        taskId: task.id,
        sessionId: session.id,
        workspaceId: workspace.id,
        idempotencyKey: "upgrade",
        capability: "fixture.read",
        objective: "Read the source",
        input: {},
        resources: [],
      }),
      ApplicationRouteSchema.parse({
        id: "fixture",
        adapterId: "fixture",
        adapterVersion: "1",
        capability: "fixture.read",
        protocol: "native",
        control: "structured",
        environment: {
          id: "local",
          kind: "local",
          locality: "local",
          background: true,
          isolated: false,
        },
        resourceKinds: ["file"],
        effect: "read",
        replay: "read_only",
        supports: {
          prepare: false,
          observe: false,
          cancel: false,
          verify: false,
          conditionalWrite: false,
          remoteFencing: false,
        },
        qualified: true,
        description: "Upgrade fixture",
      }),
      Date.now(),
    );
    manager.close();
    manager = new DatabaseManager({ dbPath });
    expect(
      await new ApplicationOperationRepository(manager.getDatabase()).get(operation.id),
    ).toMatchObject({ id: operation.id, execution: "planned" });
    expect(new TaskStore(manager.getDatabase()).findById(task.id)).toBeDefined();
  } finally {
    manager?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
