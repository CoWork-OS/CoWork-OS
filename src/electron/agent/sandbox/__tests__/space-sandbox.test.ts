import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { loadPolicies } from "../../../admin/policies";
import { SpaceSandbox } from "../space-sandbox";
import { SpaceJournal } from "../space-journal";
import { createSandbox } from "../sandbox-factory";

const exec = promisify(execFile);
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const policy = { version: "v1", egress: { default_action: "deny", allow: [], deny: [] } };

/** Real HTTP + SSE, with commands executed only in a synthetic local guest
 * directory. This verifies transport/file integration, not Firecracker isolation. */
describe("SPACE backend HTTP integration", () => {
  let base: string;
  let workspace: Workspace;
  let server: http.Server;
  let origin: string;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown>; key?: string }>;
  let guests: Map<string, string>;
  let sessions: Map<string, { guest: string; argv: string[]; cwd: string; timeout: string }>;
  let createReplies: Map<string, object>;
  let offline: boolean;
  let disconnect: boolean;
  let failDelete: boolean;
  let hostileAttach: boolean;
  let loseCreateReply: boolean;
  let rejectCreate: boolean;
  let onUserCommand: (() => void) | undefined;
  let admin: ReturnType<typeof loadPolicies>;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-space-test-"));
    const host = path.join(base, "host");
    fs.mkdirSync(host);
    workspace = {
      id: "space-test",
      name: "SPACE",
      path: host,
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: true,
        network: false,
        sandboxType: "space",
        spaceConfig: { template: "test:latest", inputPaths: [], outputPaths: [] },
      },
    };
    admin = structuredClone(loadPolicies());
    admin.runtime.allowedSandboxTypes = ["space"];
    vi.spyOn(await import("../../../admin/policies"), "loadPolicies").mockImplementation(
      () => admin,
    );
    vi.stubEnv("COWORK_USER_DATA_DIR", path.join(base, "profile"));
    vi.stubEnv("COWORK_SPACE_API_TOKEN", "management-secret");
    requests = [];
    guests = new Map();
    sessions = new Map();
    createReplies = new Map();
    offline = true;
    disconnect = false;
    failDelete = false;
    hostileAttach = false;
    loseCreateReply = false;
    rejectCreate = false;
    onUserCommand = undefined;
    server = http.createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const url = request.url!;
        const key = request.headers["idempotency-key"] as string | undefined;
        requests.push({ method: request.method!, url, body, key });
        const json = (value: unknown, status = 200) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (url.includes("/sessions/")) {
          expect(request.headers.authorization).toBe("Bearer session-secret");
          const session = sessions.get(url.split("/")[3])!;
          response.writeHead(200, { "content-type": "text/event-stream" });
          let sequence = 0;
          const send = (frame: Record<string, unknown>) =>
            response.write(
              `: keepalive\r\ndata: ${JSON.stringify({ ...frame, ...(["stdout", "stderr"].includes(frame.type) ? { seq: ++sequence } : {}), ...(frame.type === "process_exited" ? { process_id: url.split("/")[3], status: "exited" } : {}) })}\r\n\r\n`,
            );
          if (session.argv[0] === "/bin/sh") {
            onUserCommand?.();
            if (disconnect) {
              send({
                type: "stdout",
                data_base64: Buffer.from("partial output").toString("base64"),
              });
              response.end();
              return;
            }
          }
          const argv = session.argv.map((arg) => arg.replaceAll("/workspace", session.guest));
          try {
            const result = await exec(argv[0], argv.slice(1), {
              cwd: session.cwd.replace("/workspace", session.guest),
              timeout: Math.min(5000, parseFloat(session.timeout) * 1000),
              env: { PATH: process.env.PATH, HOME: session.guest },
              maxBuffer: 16 * 1024 * 1024,
            });
            for (const [type, text] of [
              ["stdout", result.stdout],
              ["stderr", result.stderr],
            ]) {
              const bytes = Buffer.from(text);
              for (let offset = 0; offset < bytes.length; offset += 65536) {
                send({
                  type,
                  data_base64: bytes.subarray(offset, offset + 65536).toString("base64"),
                });
              }
            }
            send({ type: "process_exited", exit_code: 0 });
          } catch (error) {
            send({
              type: "stderr",
              data_base64: Buffer.from(
                String((error as NodeJS.ErrnoException & { stderr?: string }).stderr || "failed"),
              ).toString("base64"),
            });
            send({
              type: "process_exited",
              exit_code:
                typeof (error as NodeJS.ErrnoException).code === "number"
                  ? (error as { code: number }).code
                  : 1,
            });
          }
          response.end();
          return;
        }
        expect(request.headers.authorization).toBe("Bearer management-secret");
        if (request.method === "POST" && url === "/v1/sandboxes") {
          if (rejectCreate) {
            json({ error: "management-secret must not leak" }, 401);
            return;
          }
          if (!createReplies.has(key!)) {
            const sandbox = id("sbx");
            const guest = path.join(base, sandbox);
            fs.mkdirSync(guest);
            guests.set(sandbox, guest);
            createReplies.set(key!, { sandbox_id: sandbox, operation_id: id("op") });
          }
          if (loseCreateReply) {
            loseCreateReply = false;
            response.destroy();
            return;
          }
          json(createReplies.get(key!));
          return;
        }
        if (request.method === "DELETE") {
          if (failDelete) {
            json({ error: "secret must never be surfaced" }, 503);
            return;
          }
          json({ operation_id: id("op") }, 202);
          return;
        }
        if (url.includes("/operations/")) {
          json({ state: "succeeded" });
          return;
        }
        if (url.endsWith("network-policy")) {
          json(
            offline
              ? policy
              : { ...policy, egress: { default_action: "allow", allow: [], deny: [] } },
          );
          return;
        }
        if (url.endsWith("processes?limit=1")) {
          json({ data: [] });
          return;
        }
        if (url.endsWith("/commands")) {
          const session = id("proc");
          sessions.set(session, {
            guest: guests.get(url.split("/")[3])!,
            argv: body.command,
            cwd: body.cwd,
            timeout: body.timeout,
          });
          json({
            session_id: session,
            process_id: session,
            attach: {
              token: "session-secret",
              events_url: hostileAttach
                ? "https://evil.example/events"
                : `/v1/sessions/${session}/events`,
            },
          });
          return;
        }
        json({ state: "running" });
      })().catch((error) => {
        response.writeHead(500);
        response.end();
        console.error(error);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    vi.stubEnv("COWORK_SPACE_API_URL", origin);
    vi.stubEnv("COWORK_SPACE_DATA_PLANE_URL", origin);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const states = () => new SpaceJournal(workspace.path, origin).pending();

  it("round-trips selected binary files without exposing other host files or credentials", async () => {
    const bytes = Buffer.from([0, 255, 128, 1, 2, 3]);
    fs.writeFileSync(path.join(workspace.path, "input.bin"), bytes);
    fs.writeFileSync(path.join(workspace.path, "private.txt"), "not selected");
    workspace.permissions.spaceConfig = {
      template: "test:latest",
      inputPaths: ["input.bin"],
      outputPaths: ["output.bin"],
    };
    const sandbox = await createSandbox(workspace, "space");
    const result = await sandbox.execute(
      'cp input.bin output.bin; test ! -e private.txt; test -z "$COWORK_SPACE_API_TOKEN"',
    );
    expect(result).toMatchObject({ exitCode: 0, killed: false });
    expect(fs.readFileSync(path.join(workspace.path, "output.bin"))).toEqual(bytes);
    expect(requests.find((r) => r.url === "/v1/sandboxes")?.body.network_policy).toEqual(policy);
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(states()).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(
          new SpaceJournal(workspace.path, origin).directory,
          fs.readdirSync(new SpaceJournal(workspace.path, origin).directory)[0],
        ),
        "utf8",
      ),
    ).not.toContain("secret");
    await sandbox.cleanup();
  });

  it.each(["python", "javascript"] as const)(
    "runs %s code through guest staging",
    async (language) => {
      const sandbox = new SpaceSandbox(workspace);
      await sandbox.initialize();
      const result = await sandbox.executeCode(
        language === "python" ? "print('guest')" : "console.log('guest')",
        language,
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "guest\n" });
    },
  );

  it("rejects missing administrator opt-in before any request", async () => {
    admin.runtime.allowedSandboxTypes = ["macos", "docker"];
    await expect(new SpaceSandbox(workspace).initialize()).rejects.toThrow("administrator opt-in");
    expect(requests).toEqual([]);
  });

  it("rejects unsupported network access, host path grants, and private interpreter work", async () => {
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    for (const options of [
      { allowNetwork: true },
      { allowedReadPaths: ["/tmp/secret"] },
      { envPassthrough: ["TOKEN"] },
      { privateDocumentWorkspace: true },
    ]) {
      expect(() => sandbox.execute("echo unsafe", [], options)).toThrow("offline execution");
    }
    expect(requests).toEqual([]);
  });

  it("checks effective network denial before uploading inputs or executing commands", async () => {
    offline = false;
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    const result = await sandbox.execute("echo unsafe");
    expect(result.exitCode).toBe(1);
    expect(requests.filter((r) => r.url.endsWith("/commands"))).toEqual([]);
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  it("preserves partial output and never retries a disconnected command", async () => {
    disconnect = true;
    workspace.permissions.spaceConfig!.outputPaths = ["output.txt"];
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    const result = await sandbox.execute("echo must-not-repeat > output.txt");
    expect(result).toMatchObject({ exitCode: 1, outcomeUnknown: true, stdout: "partial output" });
    expect(requests.filter((r) => r.body?.command?.[0] === "/bin/sh")).toHaveLength(1);
    expect(fs.existsSync(path.join(workspace.path, "output.txt"))).toBe(false);
    expect(states()).toEqual([]);
  });

  it("never sends a session credential to an unexpected attachment URL", async () => {
    hostileAttach = true;
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect((await sandbox.execute("echo unsafe")).exitCode).toBe(1);
    expect(requests.filter((r) => r.url.includes("/sessions/"))).toEqual([]);
  });

  it("reconciles failed cleanup after reconnect without replaying a command", async () => {
    failDelete = true;
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect((await sandbox.execute("echo once")).error).toContain("cleanup is pending");
    expect(() => sandbox.execute("echo twice")).toThrow("cleanup is pending");
    const deleteKey = requests.find((r) => r.method === "DELETE")!.key;
    expect(states()).toHaveLength(1);
    failDelete = false;
    await new SpaceSandbox(workspace).initialize();
    expect(states()).toEqual([]);
    expect(requests.filter((r) => r.body?.command?.[0] === "/bin/sh")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "DELETE").map((r) => r.key)).toEqual([
      deleteKey,
      deleteKey,
    ]);
  });

  it("revalidates local write authority after remote work completes", async () => {
    workspace.permissions.spaceConfig!.outputPaths = ["output.txt"];
    onUserCommand = () => {
      workspace.permissions.write = false;
    };
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect((await sandbox.execute("echo remote > output.txt")).exitCode).toBe(1);
    expect(fs.existsSync(path.join(workspace.path, "output.txt"))).toBe(false);
  });

  it("refuses an output created locally during execution", async () => {
    workspace.permissions.spaceConfig!.outputPaths = ["output.txt"];
    onUserCommand = () => fs.writeFileSync(path.join(workspace.path, "output.txt"), "user edit");
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect((await sandbox.execute("echo remote > output.txt")).exitCode).toBe(1);
    expect(fs.readFileSync(path.join(workspace.path, "output.txt"), "utf8")).toBe("user edit");
  });

  it("cancels before dispatch without creating a VM", async () => {
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    const controller = new AbortController();
    controller.abort();
    expect(() => sandbox.execute("echo unsafe", [], { signal: controller.signal })).toThrow();
    expect(requests).toEqual([]);
  });

  it("recovers a lost create reply with the same key and never creates a second VM", async () => {
    loseCreateReply = true;
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect((await sandbox.execute("echo unsafe")).exitCode).toBe(1);
    expect(createReplies.size).toBe(1);
    const creates = requests.filter(
      (request) => request.method === "POST" && request.url === "/v1/sandboxes",
    );
    expect(creates).toHaveLength(2);
    expect(creates[0].key).toBe(creates[1].key);
    expect(creates[0].body).toEqual(creates[1].body);
    expect(states()).toEqual([]);
  });

  it("does not replay or leave pending cleanup after a definitive authentication rejection", async () => {
    rejectCreate = true;
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    const result = await sandbox.execute("echo unsafe");
    expect(result.exitCode).toBe(1);
    expect(result.error).not.toContain("management-secret");
    expect(requests).toHaveLength(1);
    expect(states()).toEqual([]);
  });

  it("cancels an attached command and still confirms VM cleanup", async () => {
    const controller = new AbortController();
    onUserCommand = () => controller.abort();
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    expect(await sandbox.execute("echo stopped", [], { signal: controller.signal })).toMatchObject({
      exitCode: 1,
      killed: true,
      outcomeUnknown: true,
    });
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    expect(states()).toEqual([]);
  });

  it.each([false, true])(
    "does not create a VM when the initial journal write fails (persistent=%s)",
    async (persistent) => {
      const sandbox = new SpaceSandbox(workspace);
      await sandbox.initialize();
      const save = vi.spyOn(SpaceJournal.prototype, "save");
      const failure = () => {
        throw new Error("disk failure management-secret");
      };
      if (persistent) save.mockImplementation(failure);
      else save.mockImplementationOnce(failure);
      const result = await sandbox.execute("echo must-not-run");
      expect(result.exitCode).toBe(1);
      expect(result.error).not.toContain("management-secret");
      expect(requests).toEqual([]);
      expect(states()).toEqual([]);
    },
  );

  it("preserves a recoverable intent if journaling fails after creation", async () => {
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    const original = SpaceJournal.prototype.save;
    vi.spyOn(SpaceJournal.prototype, "save").mockImplementation(function (run) {
      if (run.sandboxId) throw new Error("disk failure");
      original.call(this, run);
    });
    expect((await sandbox.execute("echo must-not-run")).error).toContain("cleanup is pending");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(states()).toHaveLength(1);
    vi.restoreAllMocks();
    vi.spyOn(await import("../../../admin/policies"), "loadPolicies").mockImplementation(
      () => admin,
    );
    await new SpaceSandbox(workspace).initialize();
    expect(states()).toEqual([]);
    expect(guests.size).toBe(1);
    expect(requests.filter((r) => r.url.endsWith("/commands"))).toEqual([]);
  });

  it.each([NaN, Infinity, -1])(
    "rejects invalid limits before remote effects: %s",
    async (value) => {
      const sandbox = new SpaceSandbox(workspace);
      await sandbox.initialize();
      expect(() => sandbox.execute("echo unsafe", [], { timeout: value })).toThrow("limit");
      expect(() => sandbox.execute("echo unsafe", [], { maxOutputSize: value })).toThrow("limit");
      expect(requests).toEqual([]);
    },
  );

  it("does not reuse a disposed adapter", async () => {
    const sandbox = new SpaceSandbox(workspace);
    await sandbox.initialize();
    await sandbox.cleanup();
    expect(() => sandbox.execute("echo stale")).toThrow();
    await expect(sandbox.initialize()).rejects.toThrow("disposed");
    expect(requests).toEqual([]);
  });

  it.each([false, true])(
    "uses delete attempt age independently of VM creation age (attempted=%s)",
    async (attempted) => {
      const journal = new SpaceJournal(workspace.path, origin);
      const old = Date.now() - 25 * 60 * 60 * 1000;
      journal.save({
        version: 1,
        id: randomUUID(),
        pid: process.pid,
        createdAt: old,
        apiUrl: origin,
        dataPlaneUrl: origin,
        createBody: {},
        createKey: randomUUID(),
        deleteKey: randomUUID(),
        sandboxId: id("sbx"),
        phase: attempted ? "deleting" : "command",
        published: [],
        ...(attempted ? { deleteRequestedAt: old } : {}),
      });
      const initialization = new SpaceSandbox(workspace).initialize();
      if (attempted) {
        await expect(initialization).rejects.toThrow("inspection");
        expect(requests).toEqual([]);
      } else {
        await initialization;
        expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
        expect(states()).toEqual([]);
      }
    },
  );

  it("refuses a stale unknown create outside the deduplication window", async () => {
    const journal = new SpaceJournal(workspace.path, origin);
    journal.save({
      version: 1,
      id: randomUUID(),
      pid: process.pid,
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      apiUrl: origin,
      dataPlaneUrl: origin,
      createBody: { template: "test:latest", runtime: "fc", network_policy: policy },
      createKey: randomUUID(),
      deleteKey: randomUUID(),
      phase: "creating",
      published: [],
    });
    await expect(new SpaceSandbox(workspace).initialize()).rejects.toThrow("window expired");
    expect(requests).toEqual([]);
  });

  it("retains confirmed partial publication across recovery without deleting or republishing it", async () => {
    const journal = new SpaceJournal(workspace.path, origin);
    fs.writeFileSync(path.join(workspace.path, "published.txt"), "user has edited this");
    journal.save({
      version: 1,
      id: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      apiUrl: origin,
      dataPlaneUrl: origin,
      createBody: {},
      createKey: randomUUID(),
      deleteKey: randomUUID(),
      sandboxId: id("sbx"),
      phase: "publishing",
      published: ["published.txt"],
    });
    await new SpaceSandbox(workspace).initialize();
    expect(fs.readFileSync(path.join(workspace.path, "published.txt"), "utf8")).toBe(
      "user has edited this",
    );
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(states()).toEqual([]);
  });
});
