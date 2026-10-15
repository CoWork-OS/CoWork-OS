import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadExcelJS } from "../../utils/exceljs-loader";
import { loadDocumentArchive } from "../../security/document-archive";
import type { AgentDaemon } from "../daemon";
import type { FileTools } from "./file-tools";
import type { LLMTool } from "../llm/types";
import { getDefaultRuntimeToolMetadata } from "./runtime-tool-definition";
import { ApplicationNotDispatchedError } from "../../applications/ApplicationAdapterCatalog";
import { requireNativeDesktopSession } from "../../applications/native-desktop-session";
import { readSavedNumericFormulaCaches } from "../../applications/native-application-artifacts";
import { z } from "zod";
import {
  PhotoshopEditSchema,
  PhotoshopReadSchema,
  expectedPhotoshopEdit,
  photoshopReadSnapshotScript,
  photoshopEditSnapshotScript,
  type PhotoshopModel,
} from "../../applications/photoshop-document-edit";
import {
  NativeCreateSchema,
  NativeInspectSchema,
  excelCreateScript,
  photoshopCreateScript,
  readinessScript,
  nativeInspectScript,
  parseNativeInspection,
} from "../../applications/native-application-scripts";

const execFileAsync = promisify(execFile);
export const NATIVE_APPLICATION_TOOLS: LLMTool[] = [
  {
    name: "native_application_create",
    description:
      "Bounded macOS application pilots: create an Excel operating plan or a layered Photoshop banner at fresh local paths. Prefer application_operation for durable execution and verification. No arbitrary scripts, no overwrites, no existing-document edits. Requires the app already running and the task's shell/write authority.",
    input_schema: {
      type: "object",
      properties: {
        app: { enum: ["excel", "photoshop"] },
        path: { type: "string" },
        exportPath: { type: "string" },
        title: { type: "string" },
        subtitle: { type: "string" },
        months: { type: "array", items: { type: "string" } },
        units: { type: "array", items: { type: "number" } },
        price: { type: "number" },
        unitCost: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        background: { type: "string" },
        accent: { type: "string" },
      },
      required: ["app", "path", "title"],
    },
    runtime: {
      ...getDefaultRuntimeToolMetadata("native_application_create"),
      concurrencyClass: "exclusive",
      readOnly: false,
      sideEffectLevel: "high",
      deferLoad: true,
      exposure: "conditional",
    },
  },
  {
    name: "native_application_inspect",
    description:
      "Read-only, exact-file native Excel/Photoshop inspector. Checks readiness or reads an already-open saved pilot document and independently inspects its saved bytes. Never opens, activates, edits, recalculates or saves a document. Requires task read authority for document paths.",
    input_schema: {
      type: "object",
      properties: {
        app: { enum: ["excel", "photoshop"] },
        action: { enum: ["readiness", "document"] },
        path: { type: "string" },
        exportPath: { type: "string" },
      },
      required: ["app", "action"],
    },
    runtime: {
      ...getDefaultRuntimeToolMetadata("native_application_inspect"),
      concurrencyClass: "read_parallel",
      readOnly: true,
      sideEffectLevel: "none",
      approvalKind: "none",
      deferLoad: true,
      exposure: "conditional",
    },
  },
];

/** Fixed application API commands, never agent-supplied executable source. */
export const LOCAL_PHOTOSHOP_TOOLS: LLMTool[] = NATIVE_APPLICATION_TOOLS.map((tool) => ({
  ...tool,
  name: tool.name.replace("native_application", "local_photoshop"),
  description: tool.name.endsWith("create")
    ? "Bounded local background Photoshop banner creation. Auto-launches installed Photoshop without activation. Fresh editable PSD/PNG files only; no arbitrary code, overwrite, VM, network or shell permission. Prefer application_operation for durable verification."
    : "Read-only original local Photoshop document and saved PSD/PNG verification. Never launches or activates an app; no VM or network dependency.",
  input_schema: {
    ...tool.input_schema,
    properties: {
      ...(tool.input_schema.properties as object),
      app: { enum: ["photoshop"] },
    },
  },
  runtime: { ...tool.runtime!, alwaysExpose: false },
}));
LOCAL_PHOTOSHOP_TOOLS.push(
  {
    name: "local_photoshop_read",
    description:
      "Read an existing PSD's exact layer tree, nested layer paths, editable text/style, visibility, opacity and source SHA-256. Launches Photoshop in the background and inspects a private snapshot; never changes the original file or open document. Refuses unsaved source documents. Use before photoshop.document.edit; requires file read authority.",
    input_schema: z.toJSONSchema(PhotoshopReadSchema) as LLMTool["input_schema"],
    runtime: {
      ...getDefaultRuntimeToolMetadata("local_photoshop_read"),
      concurrencyClass: "exclusive",
      readOnly: true,
      sideEffectLevel: "low",
      approvalKind: "none",
      alwaysExpose: true,
      deferLoad: false,
      exposure: "always",
    },
  },
  {
    name: "local_photoshop_edit",
    description:
      "Edit an existing PSD snapshot in background Photoshop and save a fresh revised PSD plus PNG. Supports named nested layers: text contents/size/color, visibility, opacity, rename and leaf translation. Requires exact sourceSha256 from local_photoshop_read; preserves source, refuses unsaved source documents, locked/missing/ambiguous targets and output overwrites. No arbitrary code or shell permission. Prefer application_operation with capability photoshop.document.edit for durable verification.",
    input_schema: z.toJSONSchema(PhotoshopEditSchema) as LLMTool["input_schema"],
    runtime: {
      ...getDefaultRuntimeToolMetadata("local_photoshop_edit"),
      concurrencyClass: "exclusive",
      readOnly: false,
      sideEffectLevel: "high",
      deferLoad: true,
      exposure: "conditional",
    },
  },
);

export class NativeApplicationTools {
  constructor(
    private files: FileTools,
    private daemon: AgentDaemon,
    private taskId: string,
    private backgroundPhotoshop = false,
  ) {}
  private async script(script: string, signal?: AbortSignal): Promise<string> {
    if (process.platform !== "darwin")
      throw new ApplicationNotDispatchedError("Native pilots require macOS");
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
        signal,
      });
      return stdout.trim();
    } catch (error) {
      const failure = error as { killed?: boolean; stderr?: string };
      throw new Error(
        failure.killed
          ? "Native application command exceeded its time budget; dispatched effects require reconciliation"
          : failure.stderr?.trim().slice(0, 4_000) ||
              "Native application command failed or was interrupted",
      );
    }
  }
  private async launchPhotoshop(signal?: AbortSignal): Promise<void> {
    await execFileAsync("/usr/bin/open", ["-g", "-j", "-b", "com.adobe.Photoshop"], {
      timeout: 15_000,
      maxBuffer: 4096,
      signal,
    });
  }
  private async requireRunning(
    app: "excel" | "photoshop",
    signal?: AbortSignal,
    launch = false,
  ): Promise<string> {
    await requireNativeDesktopSession(signal);
    if (this.backgroundPhotoshop && app !== "photoshop")
      throw new ApplicationNotDispatchedError("Local background route supports Photoshop only");
    let version: string;
    try {
      version = await this.script(readinessScript(app), signal);
    } catch (error) {
      throw new ApplicationNotDispatchedError(
        `Native application Automation readiness failed: ${error instanceof Error ? error.message : "readiness unavailable"}`,
      );
    }
    if (version === "NOT_RUNNING" && launch && this.backgroundPhotoshop) {
      try {
        await this.launchPhotoshop(signal);
        for (let attempt = 0; attempt < 45; attempt++) {
          if (signal?.aborted) throw new Error("Cancelled before Photoshop dispatch");
          await new Promise((resolve) => setTimeout(resolve, 1000));
          version = await this.script(readinessScript(app), signal);
          if (version !== "NOT_RUNNING") break;
        }
      } catch (error) {
        throw new ApplicationNotDispatchedError(
          `Local Photoshop launch/readiness failed: ${error instanceof Error ? error.message : "unavailable"}`,
        );
      }
    }
    if (version === "NOT_RUNNING")
      throw new ApplicationNotDispatchedError(
        "Open the application before using its native pilot route",
      );
    return version;
  }
  private async compileNative(script: string, signal?: AbortSignal): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-native-compile-"));
    try {
      await execFileAsync(
        "/usr/bin/osacompile",
        ["-o", path.join(directory, "command.scpt"), "-e", script],
        { timeout: 5_000, maxBuffer: 64 * 1024, signal },
      );
    } catch (error) {
      const failure = error as { stderr?: string };
      throw new ApplicationNotDispatchedError(
        `Native command did not compile: ${failure.stderr?.trim().slice(0, 2_000) || "compiler unavailable"}`,
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  private async readBounded(pathname: string, kind: "psd" | "png"): Promise<Buffer> {
    await this.files.authorizeApplicationPath(pathname, "read");
    const handle = await fs.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new ApplicationNotDispatchedError(
          "Photoshop document exceeds the 32 MiB inspection limit",
        );
      const bytes = await handle.readFile();
      if (
        bytes.length > 32 * 1024 * 1024 ||
        (kind === "psd"
          ? bytes.length < 26 ||
            bytes.toString("ascii", 0, 4) !== "8BPS" ||
            bytes.readUInt16BE(4) !== 1
          : bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      )
        throw new ApplicationNotDispatchedError(`Invalid saved ${kind.toUpperCase()} artifact`);
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async withPhotoshopSnapshot<T>(
    pathname: string,
    run: (snapshot: string, bytes: Buffer) => Promise<T>,
  ): Promise<T> {
    const bytes = await this.readBounded(pathname, "psd");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-photoshop-snapshot-"));
    try {
      const snapshot = path.join(directory, "snapshot.psd");
      await fs.writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
      return await run(snapshot, bytes);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async read(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    saved: boolean;
    appVersion: string;
    model: PhotoshopModel;
    persisted: {
      sha256: string;
      size: number;
      width: number;
      height: number;
      export?: { path: string; sha256: string; width: number; height: number; size: number };
    };
  }> {
    const input = PhotoshopReadSchema.parse(raw);
    // Admit file authority before even launching the app.
    await this.files.authorizeApplicationPath(input.path, "read");
    if (input.exportPath) await this.files.authorizeApplicationPath(input.exportPath, "read");
    await this.requireRunning("photoshop", signal, true);
    return this.withPhotoshopSnapshot(input.path, async (snapshot, bytes) => {
      const native = JSON.parse(
        await this.script(photoshopReadSnapshotScript(input.path, snapshot), signal),
      ) as { appVersion: string; model: PhotoshopModel };
      const persisted: Awaited<ReturnType<NativeApplicationTools["read"]>>["persisted"] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        width: bytes.readUInt32BE(18),
        height: bytes.readUInt32BE(14),
      };
      const current = await this.readBounded(input.path, "psd");
      if (createHash("sha256").update(current).digest("hex") !== persisted.sha256)
        throw new Error("Source document changed during inspection");
      if (input.exportPath) {
        const png = await this.readBounded(input.exportPath, "png");
        persisted.export = {
          path: input.exportPath,
          sha256: createHash("sha256").update(png).digest("hex"),
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          size: png.length,
        };
      }
      return { ...native, path: input.path, saved: true, persisted };
    });
  }
  async edit(raw: unknown, signal?: AbortSignal): Promise<{ path: string }> {
    const input = PhotoshopEditSchema.parse(raw);
    const targets = [input.path, input.exportPath];
    const authorize = async () => {
      await this.files.authorizeApplicationPath(input.sourcePath, "read");
      for (const target of targets) {
        await this.files.authorizeApplicationPath(target, "write");
        try {
          await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new ApplicationNotDispatchedError(
          "Photoshop edits require fresh output paths; the source is preserved",
        );
      }
      const source = await this.readBounded(input.sourcePath, "psd");
      if (createHash("sha256").update(source).digest("hex") !== input.sourceSha256)
        throw new ApplicationNotDispatchedError(
          "Source PSD changed since planning; inspect it again before creating a new operation",
        );
    };
    await authorize();
    try {
      const source = await this.read({ app: "photoshop", path: input.sourcePath }, signal);
      expectedPhotoshopEdit(source.model, input.changes);
    } catch (error) {
      throw new ApplicationNotDispatchedError(
        error instanceof Error ? error.message : "Source inspection failed before edit dispatch",
      );
    }
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "workspace_write",
      "Save a revised Photoshop document",
      {
        tool: "local_photoshop_edit",
        permissionInput: input,
        path: input.path,
        targets,
        approvalPreview: {
          label: "Photoshop layer edits; source preserved",
          text: JSON.stringify(input.changes, null, 2),
        },
      },
      { signal },
    );
    if (!approved || signal?.aborted)
      throw new ApplicationNotDispatchedError(
        "Photoshop edit was denied or cancelled before dispatch",
      );
    await authorize();
    await requireNativeDesktopSession(signal);
    return this.withPhotoshopSnapshot(input.sourcePath, async (snapshot, bytes) => {
      if (createHash("sha256").update(bytes).digest("hex") !== input.sourceSha256)
        throw new ApplicationNotDispatchedError("Source PSD changed before dispatch");
      const script = photoshopEditSnapshotScript(input, snapshot);
      await this.compileNative(script, signal);
      // Any failure after dispatch is uncertain, even if one output was saved.
      // The durable harness reconciles these exact files and never replays it.
      return { path: await this.script(script, signal) };
    });
  }
  async create(raw: unknown, signal?: AbortSignal): Promise<{ path: string }> {
    const input = NativeCreateSchema.parse(raw);
    const targets = input.app === "excel" ? [input.path] : [input.path, input.exportPath];
    const authorize = async () => {
      for (const target of targets) {
        await this.files.authorizeApplicationPath(target, "write");
        try {
          await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new ApplicationNotDispatchedError("Native pilots only create fresh output files");
      }
    };
    await authorize();
    await this.requireRunning(input.app, signal, true);
    const script = input.app === "excel" ? excelCreateScript(input) : photoshopCreateScript(input);
    await this.compileNative(script, signal);
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "workspace_write",
      `Create a native ${input.app} document`,
      {
        tool: this.backgroundPhotoshop ? "local_photoshop_create" : "native_application_create",
        permissionInput: input,
        path: input.path,
        targets,
        approvalPreview: { label: "Native application command", text: script },
      },
      { signal },
    );
    if (!approved) throw new ApplicationNotDispatchedError("Native application command was denied");
    if (signal?.aborted)
      throw new ApplicationNotDispatchedError(
        "Native application command was cancelled before dispatch",
      );
    await authorize();
    await requireNativeDesktopSession(signal);
    // A late error is uncertain. Never retry the same application script here.
    return { path: await this.script(script, signal) };
  }
  async inspect(raw: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const input = NativeInspectSchema.parse(raw);
    const version = await this.requireRunning(input.app, signal);
    if (input.action === "readiness") return { ready: true, appVersion: version };
    const filePath = await this.files.authorizeApplicationPath(input.path!, "read");
    const native = parseNativeInspection(
      input.app,
      await this.script(nativeInspectScript(input.app, filePath), signal),
    );
    // No-follow open plus bounded reads. Re-admit after the app call; policy may have changed.
    await this.files.authorizeApplicationPath(filePath, "read");
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error("Native pilot artifact exceeds inspection limit");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const persisted: Record<string, unknown> = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
    if (input.app === "excel") {
      const archive = await loadDocumentArchive(bytes);
      const xml = await archive.file("xl/worksheets/sheet1.xml")?.async("string");
      const caches = readSavedNumericFormulaCaches(xml || "");
      const wb = new (await loadExcelJS()).Workbook();
      await wb.xlsx.load(bytes as never);
      const ws = wb.getWorksheet("Operating plan");
      if (!ws) throw new Error("Saved operating-plan sheet is missing");
      const rows: unknown[][] = [];
      for (let row = 4; row <= 9; row++)
        rows.push(
          Array.from({ length: 8 }, (_, col) => {
            const cell = ws.getCell(row, col + 1);
            return cell.formula
              ? {
                  formula: cell.formula,
                  result: caches.get(cell.address) ?? null,
                }
              : cell.value;
          }),
        );
      Object.assign(persisted, {
        title: ws.getCell("A1").value,
        rows,
        sheets: wb.worksheets.map((s) => s.name),
      });
    } else {
      if (bytes.toString("ascii", 0, 4) !== "8BPS" || bytes.readUInt16BE(4) !== 1)
        throw new Error("Saved artifact is not a PSD");
      Object.assign(persisted, {
        width: bytes.readUInt32BE(18),
        height: bytes.readUInt32BE(14),
      });
      if (input.exportPath) {
        const exported = await this.files.authorizeApplicationPath(input.exportPath, "read");
        try {
          const pngHandle = await fs.open(exported, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await pngHandle.stat();
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
              throw new Error("PNG exceeds inspection limit");
            const png = await pngHandle.readFile();
            if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
              throw new Error("Invalid PNG signature");
            persisted.export = {
              path: exported,
              sha256: createHash("sha256").update(png).digest("hex"),
              width: png.readUInt32BE(16),
              height: png.readUInt32BE(20),
              size: png.length,
            };
          } finally {
            await pngHandle.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          persisted.export = null;
        }
      }
    }
    return { ...native, persisted };
  }
}
