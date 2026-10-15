import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  AndroidDeviceIdSchema,
  AndroidPhoneSettingsSchema,
  type AndroidPhoneSettings,
  type AndroidPhoneStatus,
  type AndroidPhoneObservation,
  type AndroidPhoneInput,
} from "../../shared/android-phone";
import { getUserDataDir } from "../utils/user-data-dir";
import { ApplicationNotDispatchedError } from "../applications/ApplicationAdapterCatalog";
import { ANDROID_BRIDGE } from "./android-bridge";

export interface PhoneBridgeReply {
  observation?: Omit<AndroidPhoneObservation, "captureId" | "mediaType" | "scaleFactor" | "target">;
  receipt?: { status: string; deviceId: string; requestDigest: string };
  error?: string;
  notDispatched?: boolean;
}
export type PhoneProcessRunner = (
  file: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
) => Promise<string>;

/** No shell or inherited provider credentials. Abort kills the entire local process group. */
export const runPhoneProcess: PhoneProcessRunner = (file, args, input, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SYSTEMROOT",
      "SystemRoot",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LOCALAPPDATA",
      "APPDATA",
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      "ADB_VENDOR_KEYS",
    ])
      if (process.env[key]) env[key] = process.env[key];
    env.PHONE_HARNESS_TELEMETRY = "0";
    env.PHONE_HARNESS_NO_UPDATE_CHECK = "1";
    env.PYTHONIOENCODING = "utf-8";
    const child = spawn(file, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let out = "",
      err = "",
      failure: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    };
    const abort = () => {
      failure = new Error(
        "Phone operation interrupted; reconcile any dispatched action before retrying",
      );
      kill();
    };
    const timer = setTimeout(() => {
      failure = new Error("Phone runtime timed out; dispatched effects may be unknown");
      kill();
    }, 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > 20 * 1024 * 1024) {
        failure = new Error("Phone runtime output exceeded its limit");
        kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on("error", (e) => {
      failure = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Phone runtime exited ${code}: ${err}`));
      else resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

export class AndroidPhoneService {
  private static instance: AndroidPhoneService | undefined;
  static getInstance(): AndroidPhoneService {
    return (this.instance ??= new AndroidPhoneService());
  }
  readonly root: string;
  readonly pythonPath: string;
  private readonly runtimeMarker: string;
  private readonly active = new Set<AbortController>();
  private generation = 0;
  private readonly instanceId = randomUUID();
  private changingSettings = 0;
  private settingsWrites: Promise<unknown> = Promise.resolve();
  private installing?: Promise<void>;
  constructor(
    root = path.join(getUserDataDir(), "android-phone"),
    private runner: PhoneProcessRunner = runPhoneProcess,
  ) {
    this.root = root;
    this.runtimeMarker = path.join(root, "runtime", ".cowork-phone-harness-0.3.2-pillow-12.3.0");
    this.pythonPath = path.join(
      root,
      "runtime",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  }
  private executable(name: string): string {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const candidates =
      name === "adb"
        ? [
            process.env.ANDROID_HOME &&
              path.join(process.env.ANDROID_HOME, "platform-tools", name + suffix),
            path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb"),
            "/opt/homebrew/bin/adb",
            "/usr/local/bin/adb",
          ]
        : [path.join(os.homedir(), ".local/bin/uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
    return candidates.find((p): p is string => !!p && existsSync(p)) ?? name + suffix;
  }
  async settings(): Promise<AndroidPhoneSettings> {
    try {
      return AndroidPhoneSettingsSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.root, "settings.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
      throw e;
    }
  }
  async saveSettings(raw: unknown): Promise<AndroidPhoneSettings> {
    const settings = AndroidPhoneSettingsSchema.parse(raw);
    if (settings.enabled && !settings.deviceId)
      throw new Error("Select an Android device before enabling phone control");
    this.changingSettings++;
    this.stop();
    const previous = this.settingsWrites;
    let finish!: () => void;
    this.settingsWrites = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await previous;
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = path.join(this.root, `${randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify(settings), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temp, path.join(this.root, "settings.json"));
      return settings;
    } finally {
      this.changingSettings--;
      this.stop();
      finish();
    }
  }
  async status(): Promise<AndroidPhoneStatus> {
    const status: AndroidPhoneStatus = {
      settings: await this.settings(),
      devices: [],
      runtimeInstalled: existsSync(this.pythonPath) && existsSync(this.runtimeMarker),
      pythonPath: this.pythonPath,
    };
    try {
      const output = await this.runner(this.executable("adb"), ["devices", "-l"], "");
      status.devices = output.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload)\b(.*)$/);
        if (!match || !AndroidDeviceIdSchema.safeParse(match[1]).success) return [];
        return [
          {
            id: match[1],
            state: match[2],
            model: match[3].match(/\bmodel:(\S+)/)?.[1].replace(/_/g, " ") ?? match[1],
          },
        ];
      });
    } catch (e) {
      status.error = `ADB unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    return status;
  }
  install(): Promise<void> {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      this.stop();
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.rm(this.runtimeMarker, { force: true });
      await this.runner(
        this.executable("uv"),
        ["--system-certs", "venv", "--clear", "--python", "3.12", path.join(this.root, "runtime")],
        "",
      );
      await this.runner(
        this.executable("uv"),
        [
          "--system-certs",
          "pip",
          "install",
          "--python",
          this.pythonPath,
          "phone-harness==0.3.2",
          "pillow==12.3.0",
        ],
        "",
      );
      await fs.writeFile(this.runtimeMarker, "ready", { mode: 0o600 });
    })().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }
  stop(): void {
    this.generation++;
    for (const controller of this.active) controller.abort();
  }
  controlGeneration(): number {
    return this.generation;
  }
  assertControl(generation: number, signal?: AbortSignal): void {
    if (generation !== this.generation || this.changingSettings || signal?.aborted)
      throw new ApplicationNotDispatchedError(
        "Phone control stopped or changed; observe and approve again",
      );
  }
  controlScope(generation: number, signal?: AbortSignal): { signal: AbortSignal; dispose(): void } {
    this.assertControl(generation, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    return {
      signal: controller.signal,
      dispose: () => {
        signal?.removeEventListener("abort", abort);
        this.active.delete(controller);
      },
    };
  }
  async requireSelected(deviceId: string, generation = this.generation): Promise<void> {
    this.assertControl(generation);
    AndroidDeviceIdSchema.parse(deviceId);
    const settings = await this.settings();
    if (!settings.enabled || settings.deviceId !== deviceId)
      throw new ApplicationNotDispatchedError(
        "Enable phone control and select this exact Android device in Settings → Built-in Tools → Android phone",
      );
    const status = await this.status();
    this.assertControl(generation);
    if (!status.settings.enabled || status.settings.deviceId !== deviceId)
      throw new ApplicationNotDispatchedError(
        "Android device selection changed; observe the selected device again",
      );
    if (!status.runtimeInstalled)
      throw new ApplicationNotDispatchedError(
        "Install the phone-harness runtime in Settings → Built-in Tools → Android phone",
      );
    if (!status.devices.some((d) => d.id === deviceId && d.state === "device"))
      throw new ApplicationNotDispatchedError(
        "The selected Android device is disconnected, offline or unauthorized. Reconnect and approve it on the phone; no other device was selected",
      );
  }
  private async bridge(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<PhoneBridgeReply> {
    this.assertControl(generation, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.active.add(controller);
    try {
      const output = await this.runner(
        this.pythonPath,
        ["-c", ANDROID_BRIDGE],
        JSON.stringify({
          ...request,
          root: path.join(this.root, "receipts"),
          adbPath: this.executable("adb"),
        }),
        controller.signal,
      );
      const reply: PhoneBridgeReply = JSON.parse(output);
      if (reply.error) {
        if (reply.notDispatched) throw new ApplicationNotDispatchedError(reply.error);
        throw new Error(reply.error);
      }
      return reply;
    } finally {
      this.active.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  private async persistObservation(
    taskId: string,
    reply: PhoneBridgeReply,
  ): Promise<AndroidPhoneObservation> {
    const raw = reply.observation;
    if (
      !raw ||
      !raw.imageBase64 ||
      !raw.stateDigest ||
      !raw.deviceId ||
      raw.width < 1 ||
      raw.height < 1
    )
      throw new Error("Phone returned no valid observation");
    const observation: AndroidPhoneObservation = {
      ...raw,
      captureId: randomUUID(),
      mediaType: "image/png",
      scaleFactor: 1,
      target: { appName: raw.package ?? "Android", windowTitle: raw.deviceId },
    };
    // Captures are transient evidence; receipts must remain available for recovery.
    const snapshots = path.join(this.root, "snapshots");
    for (const entry of (await fs.readdir(snapshots).catch(() => [] as string[])).slice(0, 2000)) {
      if (!/^[a-f0-9-]{36}\.(json|png)$/.test(entry)) continue;
      const file = path.join(snapshots, entry);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < Date.now() - 24 * 60 * 60_000)
        await fs.unlink(file).catch(() => {});
    }
    await fs.mkdir(path.join(this.root, "snapshots"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(this.root, "snapshots", observation.captureId + ".json"),
      JSON.stringify({
        taskId,
        observation: { ...observation, imageBase64: "" },
      }),
      { mode: 0o600, flag: "wx" },
    );
    await fs.writeFile(
      path.join(this.root, "snapshots", observation.captureId + ".png"),
      Buffer.from(observation.imageBase64, "base64"),
      { mode: 0o600, flag: "wx" },
    );
    return observation;
  }
  async savedObservation(taskId: string, captureId: string): Promise<AndroidPhoneObservation> {
    if (!/^[a-f0-9-]{36}$/.test(captureId)) throw new Error("Invalid phone capture identity");
    const saved = JSON.parse(
      await fs.readFile(path.join(this.root, "snapshots", captureId + ".json"), "utf8"),
    );
    if (saved.taskId !== taskId) throw new Error("Phone capture belongs to another task");
    return {
      ...saved.observation,
      imageBase64: (
        await fs.readFile(path.join(this.root, "snapshots", captureId + ".png"))
      ).toString("base64"),
    };
  }
  capturePath(captureId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(captureId)) throw new Error("Invalid phone capture identity");
    return path.join(this.root, "snapshots", captureId + ".png");
  }
  private approvalPath(operationId: string): string {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(operationId)) throw new Error("Invalid operation identity");
    return path.join(this.root, "receipts", "approval-" + operationId + ".json");
  }
  async recordActionApproval(
    taskId: string,
    operationId: string,
    input: AndroidPhoneInput,
    generation = this.generation,
  ): Promise<void> {
    this.assertControl(generation);
    const file = this.approvalPath(operationId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      file,
      JSON.stringify({
        taskId,
        digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        generation,
        instanceId: this.instanceId,
      }),
      { mode: 0o600, flag: "wx" },
    );
    this.assertControl(generation);
  }
  async requireActionApproval(
    taskId: string,
    operationId: string,
    input: AndroidPhoneInput,
    forDispatch = false,
  ): Promise<number> {
    const approval = await fs.readFile(this.approvalPath(operationId), "utf8").catch(() => "null");
    const saved = JSON.parse(approval);
    if (
      !saved ||
      saved.taskId !== taskId ||
      saved.digest !== createHash("sha256").update(JSON.stringify(input)).digest("hex")
    )
      throw new ApplicationNotDispatchedError(
        "Original Android action was not approved; readback is unavailable",
      );
    if (forDispatch) {
      if (saved.instanceId !== this.instanceId)
        throw new ApplicationNotDispatchedError(
          "Pending Android approval belongs to an interrupted runtime; do not dispatch",
        );
      this.assertControl(saved.generation);
    }
    return saved.generation;
  }
  async observe(
    taskId: string,
    deviceId: string,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<AndroidPhoneObservation> {
    await this.requireSelected(deviceId, generation);
    return this.persistObservation(
      taskId,
      await this.bridge({ mode: "observe", deviceId }, signal, generation),
    );
  }
  async snapshot(taskId: string, input: AndroidPhoneInput): Promise<AndroidPhoneObservation> {
    let saved;
    try {
      saved = JSON.parse(
        await fs.readFile(path.join(this.root, "snapshots", input.snapshotId + ".json"), "utf8"),
      );
    } catch {
      throw new ApplicationNotDispatchedError(
        "stale_snapshot: observe the selected phone before input",
      );
    }
    if (
      saved.taskId !== taskId ||
      saved.observation.deviceId !== input.deviceId ||
      Date.now() - saved.observation.createdAt > 120_000 ||
      saved.observation.secure ||
      !saved.observation.treeAvailable ||
      !saved.observation.securityKnown
    )
      throw new ApplicationNotDispatchedError(
        "stale_snapshot: observe this task's selected phone again; secure or unknown screen safety requires user handoff",
      );
    return saved.observation;
  }
  async action(
    taskId: string,
    operationId: string,
    input: AndroidPhoneInput,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<PhoneBridgeReply & { observation: AndroidPhoneObservation }> {
    await this.requireSelected(input.deviceId, generation);
    const before = await this.snapshot(taskId, input);
    const requestDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const reply = await this.bridge(
      {
        mode: "action",
        deviceId: input.deviceId,
        operationId,
        snapshotId: input.snapshotId,
        action: input.action,
        stateDigest: before.stateDigest,
        typingDigest: before.typingDigest,
        requestDigest,
      },
      signal,
      generation,
    );
    return {
      ...reply,
      observation: await this.persistObservation(taskId, reply),
    };
  }
  async reconcile(
    taskId: string,
    operationId: string,
    input: AndroidPhoneInput,
    signal?: AbortSignal,
  ): Promise<PhoneBridgeReply & { observation: AndroidPhoneObservation }> {
    const generation = this.generation;
    await this.requireSelected(input.deviceId, generation);
    const reply = await this.bridge(
      { mode: "reconcile", deviceId: input.deviceId, operationId },
      signal,
      generation,
    );
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (
      reply.receipt &&
      (reply.receipt.deviceId !== input.deviceId || reply.receipt.requestDigest !== digest)
    )
      throw new Error("Phone receipt does not match the original operation");
    return {
      ...reply,
      observation: await this.persistObservation(taskId, reply),
    };
  }
}
