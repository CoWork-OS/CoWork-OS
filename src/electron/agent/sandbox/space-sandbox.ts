import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isSpaceTemplate } from "../../../shared/space-sandbox";
import type { Workspace, SpaceSandboxConfig } from "../../../shared/types";
import type { ISandbox, SandboxOptions, SandboxResult } from "./sandbox-factory";
import { loadPolicies } from "../../admin/policies";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";
import {
  SpaceClient,
  SpaceHttpError,
  spaceId,
  spaceRecord,
  type SpaceRecord,
} from "./space-client";
import { SpaceJournal, type SpaceRun } from "./space-journal";
import {
  decodeSpaceOutputs,
  publishSpaceOutputs,
  snapshotSpaceInputs,
  spaceRelativePath,
  spaceScriptPath,
  SPACE_TRANSFER_LIMIT,
  type SpaceInput,
  validateSpaceOutputs,
} from "./space-files";
import { createLogger } from "../../utils/logger";

const log = createLogger("SpaceSandbox");
const activeRuns = new Set<string>();
/** Each base64 argument stays below SPACE's per-string command bound. */
const UPLOAD_CHUNK_BYTES = 24 * 1024;
/** Several chunks per transfer command, so an 8 MiB selection needs ~43 commands, not ~350. */
const UPLOAD_CHUNKS_PER_COMMAND = 8;
/** Streamed output is checkpointed at most this often; completion saves the rest. */
const OUTPUT_CHECKPOINT_MS = 1000;

/** A stale run that can never be reconciled automatically; kept for operator inspection. */
class SpaceReconcileError extends Error {}
const DENY_NETWORK = { version: "v1", egress: { default_action: "deny", allow: [], deny: [] } };
const DAY = 24 * 60 * 60 * 1000;

/** Opt-in, offline Linux execution. A fresh microVM per invocation, selected
 * file copies only, no shared host mounts, local fallback, environment forwarding,
 * command replay, or implicit publication of a guest filesystem. */
export class SpaceSandbox implements ISandbox {
  readonly type = "space" as const;
  private client!: SpaceClient;
  private journal!: SpaceJournal;
  private config!: SpaceSandboxConfig;
  private initialized = false;
  private disposed = false;
  private controller?: AbortController;
  private active?: Promise<SandboxResult>;
  /** A run whose VM cleanup failed; retried (same delete key) before the next invocation. */
  private pendingCleanup?: SpaceRun;

  constructor(private readonly workspace: Workspace) {}

  async initialize(): Promise<void> {
    this.assertAuthority();
    const config = this.workspace.permissions.spaceConfig;
    if (!config || !isSpaceTemplate(config.template)) {
      throw new Error("SPACE requires an explicitly configured published template");
    }
    for (const paths of [config.inputPaths || [], config.outputPaths || []]) {
      if (!Array.isArray(paths) || paths.length > 64 || new Set(paths).size !== paths.length) {
        throw new Error("Invalid SPACE file selection");
      }
      paths.forEach(spaceRelativePath);
    }
    this.config = structuredClone(config);
    this.client = new SpaceClient();
    this.journal = new SpaceJournal(this.workspace.path, this.client.apiUrl);
    // Only reconcile stale runs from this workspace/endpoint. Live owners keep
    // their VMs. Recovery deletes VMs and never reattaches/replays commands or
    // republishes partially committed artifacts.
    // A stale run never blocks new work: one that can't be reconciled is set aside
    // for inspection, and a transient failure is retried on the next initialization
    // (an orphaned VM also deletes itself after its idle timeout).
    for (const run of this.journal.pending()) {
      if (activeRuns.has(run.id) || (run.pid !== process.pid && processAlive(run.pid))) continue;
      try {
        if (run.apiUrl !== this.client.apiUrl || run.dataPlaneUrl !== this.client.dataPlaneUrl) {
          throw new SpaceReconcileError("SPACE recovery endpoint mismatch");
        }
        if (["command", "publishing"].includes(run.phase)) {
          run.outcomeUnknown = true;
          this.journal.save(run);
        }
        await this.reconcile(run);
      } catch (error) {
        log.warn(`SPACE recovery record ${run.id} not reconciled: ${safeError(error)}`);
      }
    }
    this.assertAuthority();
    this.initialized = true;
  }

  private assertAuthority(): void {
    if (this.disposed) throw new Error("SPACE sandbox was disposed");
    if (
      this.workspace.permissions.sandboxType !== "space" ||
      !loadPolicies().runtime.allowedSandboxTypes.includes("space") ||
      this.workspace.permissions.shell !== true ||
      this.workspace.permissions.accessProfileUnavailable
    ) {
      throw new Error(
        "SPACE requires explicit workspace selection, shell permission, and administrator opt-in",
      );
    }
    if (
      this.config &&
      JSON.stringify(this.workspace.permissions.spaceConfig) !== JSON.stringify(this.config)
    ) {
      throw new Error(
        "SPACE file selection changed; create a new sandbox adapter before execution",
      );
    }
  }

  execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    return this.start(command, args, options);
  }

  executeCode(
    code: string,
    language: "python" | "javascript",
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    if (!["python", "javascript"].includes(language)) throw new Error("Unsupported SPACE language");
    const script = spaceScriptPath() + (language === "python" ? ".py" : ".js");
    return this.start(
      language === "python" ? "python3" : "node",
      [`/workspace/${script}`],
      options,
      { path: script, data: Buffer.from(code), internal: true },
    );
  }

  private start(
    command: string,
    args: string[],
    options: SandboxOptions,
    script?: SpaceInput,
  ): Promise<SandboxResult> {
    if (!this.initialized) throw new Error("SPACE sandbox is not initialized");
    options.signal?.throwIfAborted();
    if (this.active) throw new Error("SPACE invocation already running");
    this.assertAuthority();
    if (
      options.allowNetwork ||
      options.envPassthrough?.length ||
      options.allowedReadPaths?.length ||
      options.allowedWritePaths?.length ||
      options.privateDocumentWorkspace ||
      options.detached
    ) {
      throw new Error(
        "SPACE supports offline execution with explicitly selected workspace files only",
      );
    }
    for (const value of [options.timeout, options.maxOutputSize]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Invalid SPACE execution limit");
    }
    const cwd = this.guestCwd(options.cwd || this.workspace.path);
    const inputs = snapshotSpaceInputs(this.workspace, this.config.inputPaths || []);
    if (script) {
      if (script.data.length > 2 * 1024 * 1024) throw new Error("SPACE script exceeds size limit");
      inputs.push(script);
    }
    if (inputs.reduce((size, input) => size + input.data.length, 0) > SPACE_TRANSFER_LIMIT) {
      throw new Error("SPACE inputs exceed transfer budget");
    }
    const outputBindings = validateSpaceOutputs(this.workspace, this.config.outputPaths || []);
    this.controller = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(Math.min(300_000, options.timeout ?? 30_000) + 300_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    this.active = this.run(command, args, cwd, inputs, options, signal, outputBindings).finally(
      () => {
        this.active = undefined;
        this.controller = undefined;
      },
    );
    return this.active;
  }

  private guestCwd(cwd: string): string {
    const relative = path.relative(path.resolve(this.workspace.path), path.resolve(cwd));
    if (relative === "") return "/workspace";
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("SPACE cwd must be inside the workspace");
    spaceRelativePath(relative.split(path.sep).join("/"));
    if (
      evaluateWorkspaceFilesystemAccess(this.workspace, cwd, "read").decision !== "allow" ||
      !fs.statSync(cwd).isDirectory() ||
      fs.realpathSync(cwd) !== path.join(fs.realpathSync(this.workspace.path), relative)
    ) {
      throw new Error("SPACE cwd is outside the permitted workspace");
    }
    return "/workspace/" + relative.split(path.sep).join("/");
  }

  private async run(
    command: string,
    args: string[],
    cwd: string,
    inputs: SpaceInput[],
    options: SandboxOptions,
    signal: AbortSignal,
    outputBindings: ReturnType<typeof validateSpaceOutputs>,
  ): Promise<SandboxResult> {
    if (this.pendingCleanup) {
      // Retry the earlier VM's cleanup with its saved delete key before any new VM.
      const previous = this.pendingCleanup;
      try {
        await this.reconcile(previous);
      } catch {
        throw new Error(
          `SPACE cleanup is pending; recovery record ${previous.id}. No command was replayed.`,
        );
      }
      this.pendingCleanup = undefined;
      signal.throwIfAborted();
    }
    const timeout = Math.min(300_000, Math.max(1000, options.timeout ?? 30_000));
    const cap = Math.min(1024 * 1024, Math.max(0, options.maxOutputSize ?? 100 * 1024));
    const run: SpaceRun = {
      version: 1,
      id: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      apiUrl: this.client.apiUrl,
      dataPlaneUrl: this.client.dataPlaneUrl,
      createBody: {
        template: this.config.template,
        runtime: "fc",
        network_policy: DENY_NETWORK,
        idle_timeout: "600s",
        idle_action: "delete",
      },
      createKey: randomUUID(),
      deleteKey: randomUUID(),
      phase: "creating",
      published: [],
    };
    activeRuns.add(run.id);
    let result: SandboxResult = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      killed: false,
      timedOut: false,
    };
    let creationAttempted = false;
    try {
      this.journal.save(run); // Intent is durable before creation can have effects.
      signal.throwIfAborted();
      creationAttempted = true;
      let created: SpaceRecord;
      try {
        created = await this.client.request(
          "POST",
          "/v1/sandboxes",
          run.createBody,
          run.createKey,
          signal,
        );
      } catch (error) {
        if (error instanceof SpaceHttpError && [400, 401, 403, 404, 422].includes(error.status)) {
          run.phase = "create_rejected";
          this.journal.save(run);
        }
        throw error;
      }
      this.rememberCreated(run, created);
      await this.client.wait(
        `/v1/operations/${spaceId(run.createOperationId, "op")}`,
        "succeeded",
        signal,
      );
      await this.client.wait(`/v1/sandboxes/${spaceId(run.sandboxId, "sbx")}`, "running", signal);
      const ready = await this.client.request(
        "GET",
        `/v1/sandboxes/${run.sandboxId}/processes?limit=1`,
        undefined,
        undefined,
        signal,
      );
      if (!Array.isArray(ready.data)) throw new Error("SPACE process service is not ready");
      await this.checkNetwork(run, signal);
      await this.command(
        run,
        [
          "python3",
          "-c",
          `import os; os.makedirs('/workspace', exist_ok=True); os.makedirs(${JSON.stringify(cwd)}, exist_ok=True)`,
        ],
        "/",
        30_000,
        1024,
        signal,
      );
      for (const input of inputs) {
        this.assertAuthority();
        if (
          !input.internal &&
          evaluateWorkspaceFilesystemAccess(this.workspace, input.path, "read").decision !== "allow"
        ) {
          throw new Error("SPACE input read permission was revoked before upload");
        }
        // The first command creates the file exclusively, later ones append. Copies
        // are private to this invocation and are never retried on uncertainty.
        const target = `/workspace/${input.path}`;
        let offset = 0;
        let mode = "x";
        do {
          const chunks: string[] = [];
          for (
            let i = 0;
            i < UPLOAD_CHUNKS_PER_COMMAND && offset < input.data.length;
            i += 1, offset += UPLOAD_CHUNK_BYTES
          ) {
            chunks.push(
              input.data.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString("base64"),
            );
          }
          await this.command(
            run,
            ["python3", "-c", UPLOAD_SCRIPT, target, mode, ...chunks],
            "/workspace",
            30_000,
            1024,
            signal,
          );
          mode = "a";
        } while (offset < input.data.length);
      }
      this.assertAuthority();
      await this.checkNetwork(run, signal);
      const argv = args.length ? [command, ...args] : ["/bin/sh", "-c", command];
      const completed = await this.command(run, argv, cwd, timeout, cap, signal, true);
      result = { ...completed };
      const paths = this.config.outputPaths || [];
      if (completed.exitCode === 0 && paths.length) {
        const exported = await this.command(
          run,
          ["python3", "-c", EXPORT_SCRIPT, JSON.stringify(paths)],
          "/workspace",
          30_000,
          Math.ceil(SPACE_TRANSFER_LIMIT * 1.4) + 65536,
          signal,
        );
        if (exported.truncated) throw new Error("SPACE artifact manifest exceeded transfer limit");
        const files = decodeSpaceOutputs(exported.stdout, paths);
        signal.throwIfAborted();
        this.assertAuthority();
        run.phase = "publishing";
        run.artifacts = files.map((file) => ({
          path: file.path,
          sha256: createHash("sha256").update(file.data).digest("hex"),
        }));
        this.journal.save(run);
        publishSpaceOutputs(
          this.workspace,
          files,
          (relative) => {
            run.published.push(relative);
            this.journal.save(run);
          },
          outputBindings,
        );
        result.stdout += `\nSPACE artifacts published: ${run.published.join(", ")}`;
      }
      run.phase = "completed";
      this.journal.save(run);
    } catch (error) {
      run.outcomeUnknown = run.phase === "command" || run.phase === "publishing";
      if (!creationAttempted) run.phase = "create_rejected";
      else if (run.phase !== "create_rejected") run.phase = "failed";
      try {
        this.journal.save(run);
      } catch {
        // Keep in-memory identities for cleanup; the durable create intent still
        // allows reconciliation if later checkpoints could not be persisted.
      }
      result = {
        exitCode: 1,
        stdout: result.stdout || run.stdout || "",
        stderr: result.stderr || run.stderr || "",
        killed: signal.aborted,
        timedOut:
          (error instanceof Error && error.name === "TimeoutError") ||
          signal.reason?.name === "TimeoutError",
        error: `SPACE execution failed${run.outcomeUnknown ? "; outcome unknown, do not replay" : ""}. ${safeError(error)}. Recovery record: ${run.id}. Published: ${run.published.join(", ") || "none"}`,
        outcomeUnknown: run.outcomeUnknown,
      };
      result.stderr += (result.stderr ? "\n" : "") + result.error;
    } finally {
      try {
        if (creationAttempted) await this.deleteRun(run);
        else this.journal.remove(run.id);
      } catch {
        this.pendingCleanup = run;
        result.exitCode = 1;
        result.error = `SPACE cleanup is pending; recovery record ${run.id}. No command was replayed.`;
        result.stderr += `\n${result.error}`;
      } finally {
        activeRuns.delete(run.id);
      }
    }
    return result;
  }

  private rememberCreated(run: SpaceRun, response: SpaceRecord): void {
    // Keep a valid sandbox ID even if the operation part of a response is bad.
    if (typeof response.sandbox_id === "string") {
      run.sandboxId = spaceId(response.sandbox_id, "sbx");
      this.journal.save(run);
    }
    run.createOperationId = spaceId(response.operation_id, "op");
    this.journal.save(run);
    spaceId(run.sandboxId, "sbx");
  }

  private async checkNetwork(run: SpaceRun, signal: AbortSignal): Promise<void> {
    const policy = await this.client.request(
      "GET",
      `/v1/sandboxes/${spaceId(run.sandboxId, "sbx")}/network-policy`,
      undefined,
      undefined,
      signal,
    );
    const egress = spaceRecord(policy.egress);
    // Never trust the template or a successful create alone. This deliberately
    // rejects additive operator profiles, credential rules, or unsupported shapes.
    if (
      policy.version !== "v1" ||
      egress.default_action !== "deny" ||
      !Array.isArray(egress.allow) ||
      egress.allow.length ||
      (policy.network_credential_rules !== undefined &&
        (!Array.isArray(policy.network_credential_rules) ||
          policy.network_credential_rules.length !== 0)) ||
      (policy.tls_interception_exemptions !== undefined &&
        (!Array.isArray(policy.tls_interception_exemptions) ||
          policy.tls_interception_exemptions.length !== 0))
    ) {
      throw new Error("SPACE cannot enforce the requested offline network policy");
    }
  }

  private async command(
    run: SpaceRun,
    argv: string[],
    cwd: string,
    timeout: number,
    cap: number,
    signal: AbortSignal,
    userCommand = false,
  ) {
    signal.throwIfAborted();
    this.assertAuthority();
    run.phase = "command";
    run.commandKey = randomUUID();
    this.journal.save(run);
    const created = await this.client.request(
      "POST",
      `/v1/sandboxes/${spaceId(run.sandboxId, "sbx")}/commands`,
      { command: argv, cwd, timeout: `${timeout / 1000}s`, stdin: false },
      run.commandKey,
      signal,
    );
    run.processId = spaceId(created.process_id, "proc");
    this.journal.save(run);
    let checkpointedAt = 0;
    const result = await this.client.stream(created, timeout, cap, signal, (stdout, stderr) => {
      if (!userCommand) return;
      run.stdout = stdout;
      run.stderr = stderr;
      // Bounded fsync rate; the completion (or failure) save records the latest output.
      if (Date.now() - checkpointedAt < OUTPUT_CHECKPOINT_MS) return;
      checkpointedAt = Date.now();
      this.journal.save(run);
    });
    run.phase = "command_completed";
    this.journal.save(run);
    if (!userCommand && result.exitCode !== 0)
      throw new Error("SPACE file transfer command failed");
    return result;
  }

  /** Deletes a run's VM; a run that can never be reconciled is set aside, not retried. */
  private async reconcile(run: SpaceRun): Promise<void> {
    try {
      await this.deleteRun(run);
    } catch (error) {
      if (!(error instanceof SpaceReconcileError)) throw error;
      run.phase = "abandoned";
      this.journal.save(run);
      log.warn(`SPACE recovery record ${run.id} needs operator inspection: ${error.message}`);
    }
  }

  private async deleteRun(run: SpaceRun): Promise<void> {
    if (run.phase === "create_rejected") {
      this.journal.remove(run.id);
      return;
    }
    if (!run.sandboxId) {
      // Creation is the only POST recovered by replay, with its exact saved
      // body/key, within SPACE's 24-hour deduplication contract.
      if (Date.now() - run.createdAt >= DAY)
        throw new SpaceReconcileError("SPACE create reconciliation window expired");
      this.rememberCreated(
        run,
        await this.client.request("POST", "/v1/sandboxes", run.createBody, run.createKey),
      );
    }
    const sandboxId = spaceId(run.sandboxId, "sbx");
    if (!run.deleteOperationId) {
      // A first delete has its own deduplication window, independent of VM age.
      const previousAttempt =
        run.deleteRequestedAt ?? (run.phase === "deleting" ? run.createdAt : undefined);
      if (previousAttempt !== undefined && Date.now() - previousAttempt >= DAY)
        throw new SpaceReconcileError("SPACE cleanup reconciliation requires operator inspection");
      run.deleteRequestedAt = previousAttempt ?? Date.now();
      run.phase = "deleting";
      this.journal.save(run);
      const deleted = await this.client.request(
        "DELETE",
        `/v1/sandboxes/${sandboxId}`,
        undefined,
        run.deleteKey,
      );
      run.deleteOperationId = spaceId(deleted.operation_id, "op");
      this.journal.save(run);
    }
    await this.client.wait(`/v1/operations/${spaceId(run.deleteOperationId, "op")}`, "succeeded");
    run.phase = "deleted";
    // A cleanly finished run needs no record; an unknown outcome stays for inspection
    // (the journal prunes those after a week).
    if (run.outcomeUnknown) this.journal.save(run);
    else this.journal.remove(run.id);
  }

  async cleanup(): Promise<void> {
    this.disposed = true;
    this.initialized = false;
    this.controller?.abort();
    await this.active;
  }
}

function safeError(error: unknown): string {
  // Transport errors and vendor bodies may contain URLs/tokens. Expose only
  // locally authored errors; fetch failures have a generic diagnosis.
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("SPACE ") || message.startsWith("Invalid SPACE")
    ? message
    : "transport, cancellation, or validation failure";
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** argv: target, "x" (create exclusively) or "a" (append), then base64 chunks. */
const UPLOAD_SCRIPT = `import base64,os,sys
os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True)
with open(sys.argv[1],sys.argv[2]+'b') as f:
 for chunk in sys.argv[3:]: f.write(base64.b64decode(chunk,validate=True))`;

const EXPORT_SCRIPT = `import base64,hashlib,json,os,stat,sys
result=[]
total=0
root=os.path.realpath('/workspace')
for rel in json.loads(sys.argv[1]):
 p=os.path.join(root,rel)
 if os.path.realpath(p)!=p: raise ValueError('artifact symlink')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  s=os.fstat(f.fileno())
  if not stat.S_ISREG(s.st_mode): raise ValueError('artifact type')
  data=f.read(2097153)
  total+=len(data)
  if len(data)>2097152 or total>8388608: raise ValueError('artifact size')
 result.append({'path':rel,'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest()})
print(json.dumps(result))`;
