import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationExecutionService } from "../ApplicationExecutionService";
import { ApplicationOperationRepository } from "../ApplicationOperationRepository";
import { APPLICATION_EXECUTION_SCHEMA } from "../application-operation-store";
import { createAndroidPhoneAdapter, androidPhoneResources } from "../android-phone-adapter";
import { AndroidPhoneTools } from "../../agent/tools/android-phone-tools";
import { AndroidPhoneService } from "../../phone/AndroidPhoneService";
import { runPhoneProcess } from "../../phone/AndroidPhoneService";
import type { AndroidPhoneInput, AndroidPhoneObservation } from "../../../shared/android-phone";
import type { ApplicationToolGateway } from "../ApplicationAdapterCatalog";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function database() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'executing');
    CREATE TABLE work_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    CREATE TABLE work_session_task_bindings (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('workspace'); INSERT INTO tasks VALUES ('task','workspace','executing'),('task2','workspace','executing');
    INSERT INTO work_sessions VALUES ('session','workspace'); INSERT INTO work_session_task_bindings VALUES ('task','session'),('task2','session');`);
  db.exec(APPLICATION_EXECUTION_SCHEMA);
  return db;
}
const input: AndroidPhoneInput = {
  deviceId: "emulator-5554",
  snapshotId: "12345678-1234-4123-8123-123456789abc",
  action: { kind: "open_app", package: "com.android.settings" },
  expected: { package: "com.android.settings", text: "Settings" },
};
const state = {
  observation: {
    deviceId: input.deviceId,
    captureId: "capture",
    createdAt: Date.now(),
    package: "com.android.settings",
    stateDigest: "screen-hash",
    texts: ["Settings"],
    imageBase64: "image",
  },
  receipt: { status: "completed" },
};
async function create(
  service: ApplicationExecutionService,
  value = input,
  taskId = "task",
  idempotencyKey = "original-action",
) {
  return service.create({
    idempotencyKey,
    taskId,
    sessionId: "session",
    workspaceId: "workspace",
    capability: "phone.android.action",
    objective: "Open Android Settings",
    input: JSON.parse(JSON.stringify(value)),
    resources: androidPhoneResources(value),
    dependsOn: [],
    planRevision: 1,
    constraints: { maxAttempts: 1, maxPolls: 1 },
  });
}
describe("durable Android operations", () => {
  it("verifies fresh domain criteria, keeps screenshots out of SQLite and never executes twice", async () => {
    const call = vi.fn(async () => state);
    const service = new ApplicationExecutionService(
      new ApplicationOperationRepository(database()),
      { call },
    );
    service.catalog.register(createAndroidPhoneAdapter());
    const operation = await create(service);
    const done = await service.execute(operation.id);
    expect(done.execution).toBe("completed");
    expect(done.verification).toBe("verified");
    expect(JSON.stringify(done.result)).not.toContain("imageBase64");
    await service.execute(operation.id);
    expect(
      call.mock.calls.filter((args: unknown[]) => args[0] === "android_phone_dispatch"),
    ).toHaveLength(1);
    await service.stop();
  });
  it("preserves unknown input and blocks a second task on the same device across service restart", async () => {
    const repository = new ApplicationOperationRepository(database());
    const call = vi.fn(async (name: string) => {
      if (name === "android_phone_dispatch") throw new Error("lost reply after input");
      return { ...state, receipt: { status: "dispatching" } };
    });
    const first = new ApplicationExecutionService(repository, { call });
    first.catalog.register(createAndroidPhoneAdapter());
    const operation = await create(first);
    expect((await first.execute(operation.id)).execution).toBe("unknown");
    await first.stop();
    const restarted = new ApplicationExecutionService(repository, { call });
    restarted.catalog.register(createAndroidPhoneAdapter());
    expect((await restarted.reconcile(operation.id)).execution).toBe("unknown");
    const other = await create(restarted, input, "task2", "other-task-action");
    expect((await restarted.execute(other.id)).execution).not.toBe("completed");
    expect(call.mock.calls.filter(([name]) => name === "android_phone_dispatch")).toHaveLength(1);
    await restarted.stop();
  });
  it("does not claim verification from dispatch, wrong text or a missing receipt", async () => {
    const service = new ApplicationExecutionService(
      new ApplicationOperationRepository(database()),
      { call: async () => state },
    );
    service.catalog.register(createAndroidPhoneAdapter());
    const operation = await create(service, {
      ...input,
      expected: { text: "Not on the phone" },
    });
    expect((await service.execute(operation.id)).verification).toBe("unavailable");
    await service.stop();
  });
  it("rejects device-lock resources that do not match the actual input", async () => {
    const service = new ApplicationExecutionService(
      new ApplicationOperationRepository(database()),
      { call: async () => state },
    );
    service.catalog.register(createAndroidPhoneAdapter());
    await expect(
      service.create({
        ...(await create(service)).request,
        idempotencyKey: "wrong-device",
        resources: [
          {
            kind: "application_state",
            system: "android-phone",
            identity: "other-device",
          },
        ],
      }),
    ).rejects.toThrow(/exact selected/);
    await service.stop();
  });
});

// Opt-in live test. Uses a real Android emulator/device and the installed pinned runtime.
describe.skipIf(!process.env.COWORK_ANDROID_E2E_DEVICE)(
  "live Android phone-harness acceptance",
  () => {
    it("runs approved device observation → durable input → screenshot → fresh verification → receipt recovery", async () => {
      const root =
        process.env.COWORK_ANDROID_E2E_ROOT ??
        (await fs.mkdtemp(path.join(os.tmpdir(), "cowork-phone-live-")));
      const phone = new AndroidPhoneService(root);
      if (!(await phone.status()).runtimeInstalled) await phone.install();
      const deviceId = process.env.COWORK_ANDROID_E2E_DEVICE!;
      if (deviceId.startsWith("emulator-")) {
        for (const packageName of [
          "com.android.settings",
          "com.google.android.settings.intelligence",
        ])
          await runPhoneProcess(
            "adb",
            ["-s", deviceId, "shell", "am", "force-stop", packageName],
            "",
          );
      }
      await phone.saveSettings({ enabled: true, deviceId });
      let approve = true;
      const approvals: unknown[] = [];
      let service: ApplicationExecutionService;
      const daemon = {
        getTask: () => ({ status: "executing" }),
        getApplicationExecutionService: () => service,
        requestApproval: async (...args: unknown[]) => {
          approvals.push(args);
          return approve;
        },
      };
      let tools = new AndroidPhoneTools(daemon as never, "task", phone);
      const gateway: ApplicationToolGateway = {
        call: (name, data, context) =>
          tools.run(name, data, {
            signal: context.signal,
            applicationAttempt: {
              operationId: context.operation.id,
              phase: context.phase,
            },
          }),
      };
      const repository = new ApplicationOperationRepository(database());
      service = new ApplicationExecutionService(repository, gateway);
      service.catalog.register(createAndroidPhoneAdapter());
      const shot = (await tools.run("android_phone_observe", {
        deviceId,
      })) as AndroidPhoneObservation;
      expect(Buffer.from(shot.imageBase64, "base64").subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const request = {
        ...input,
        deviceId,
        snapshotId: shot.captureId,
        expected: { package: "com.android.settings" },
      };
      // Pixel freshness can legitimately refuse a clock/caret/animation change.
      // Re-observe and ask for a NEW approval only after a definitive no-dispatch
      // failure; never retry unknown input or a completed original operation.
      const performAction = async (
        action:
          | AndroidPhoneInput["action"]
          | ((screen: AndroidPhoneObservation) => AndroidPhoneInput["action"]),
        key: string,
        expected?: AndroidPhoneInput["expected"],
        expectedExecution = "completed",
        initial?: AndroidPhoneObservation,
      ) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const fresh =
            attempt === 0 && initial
              ? initial
              : ((await tools.run("android_phone_observe", {
                  deviceId,
                })) as AndroidPhoneObservation);
          const operation = await create(
            service,
            {
              deviceId,
              snapshotId: fresh.captureId,
              action: typeof action === "function" ? action(fresh) : action,
              expected,
            },
            "task",
            `${key}-${attempt}`,
          );
          const result = await service.execute(operation.id);
          if (result.execution === "failed" && result.error?.includes("stale_snapshot")) {
            await expect(
              fs.access(path.join(root, "receipts", operation.id + ".json")),
            ).rejects.toThrow();
            continue;
          }
          expect(result.execution, result.error).toBe(expectedExecution);
          return { operation, result };
        }
        throw new Error(
          `Phone never reached a stable screen for ${key}; no stale input was dispatched`,
        );
      };
      const { operation, result: done } = await performAction(
        request.action,
        "open-settings",
        request.expected,
        "completed",
        shot,
      );
      expect(done.verification, done.verificationResult?.summary).toBe("verified");
      expect(approvals.length).toBeGreaterThanOrEqual(2);
      const captureId = (done.result!.data!.observation as { captureId: string }).captureId;
      const screen = await phone.savedObservation("task", captureId);
      expect(screen.package).toBe("com.android.settings");
      await fs.writeFile(
        path.join(root, "acceptance.png"),
        Buffer.from(screen.imageBase64, "base64"),
      );
      await fs.writeFile(
        path.join(root, "acceptance.json"),
        JSON.stringify(
          {
            operationId: done.id,
            execution: done.execution,
            verification: done.verification,
            screenshot: path.join(root, "acceptance.png"),
          },
          null,
          2,
        ),
      );
      await service.stop();
      service = new ApplicationExecutionService(repository, gateway);
      service.catalog.register(createAndroidPhoneAdapter());
      expect((await service.reconcile(operation.id)).verification).toBe("verified");
      await performAction((fresh) => {
        const search = fresh.elements.find((e) => e.id.endsWith("search_action_bar"));
        expect(search, "Settings search control").toBeDefined();
        return { kind: "tap", x: search!.x, y: search!.y };
      }, "tap-search");
      const { result: typed } = await performAction(
        { kind: "type_text", text: "cowork phone qa" },
        "type-search",
        {
          text: "cowork phone qa",
        },
      );
      expect(typed.verification, typed.verificationResult?.summary).toBe("verified");
      const typedCapture = await phone.savedObservation(
        "task",
        (typed.result!.data!.observation as { captureId: string }).captureId,
      );
      await fs.writeFile(
        path.join(root, "typing-acceptance.png"),
        Buffer.from(typedCapture.imageBase64, "base64"),
      );
      await performAction({ kind: "home" }, "go-home");
      let lost = false,
        actionCalls = 0;
      const lossyPhone = new AndroidPhoneService(root, async (file, args, stdin, signal) => {
        const output = await runPhoneProcess(file, args, stdin, signal);
        if (
          stdin &&
          JSON.parse(stdin).mode === "action" &&
          JSON.parse(output).receipt?.status === "completed"
        ) {
          actionCalls++;
          if (!lost) {
            lost = true;
            throw new Error("Injected lost reply after the phone applied input");
          }
        }
        return output;
      });
      tools = new AndroidPhoneTools(daemon as never, "task", lossyPhone);
      const lossShot = await lossyPhone.observe("task", deviceId);
      const { operation: lossOperation } = await performAction(
        { kind: "home" },
        "lost-reply",
        { package: lossShot.package! },
        "unknown",
        lossShot,
      );
      expect((await service.reconcile(lossOperation.id)).verification).toBe("verified");
      expect(actionCalls).toBe(1);
      tools = new AndroidPhoneTools(daemon as never, "task", phone);
      const fresh = await phone.observe("task", deviceId);
      approve = false;
      const denied = await create(
        service,
        { ...request, snapshotId: fresh.captureId },
        "task",
        "denied-action",
      );
      expect((await service.execute(denied.id)).execution).toBe("failed");
      await expect(fs.access(path.join(root, "receipts", denied.id + ".json"))).rejects.toThrow();
      await service.stop();
    }, 360_000);
  },
);
