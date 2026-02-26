import * as fs from "fs/promises";
import * as path from "path";
import type { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { extractJsonValues } from "../../utils/json-utils";
import {
  clampMontyLimits,
  createMontySafeStdlib,
  MontyProgramCache,
  runMontyCode,
  sha256Hex,
  type MontyResourceLimits,
} from "../../sandbox/monty-engine";
import { FileTools } from "./file-tools";

type MontyRunInput = {
  code: string;
  inputs?: unknown;
  limits?: MontyResourceLimits;
};

type MontyTransformRunInput = {
  name: string;
  inputs?: unknown;
  limits?: MontyResourceLimits;
};

type MontyListTransformsInput = {
  // reserved for future options
};

type MontyTransformFileInput = {
  transform: string;
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  maxInputBytes?: number;
  limits?: MontyResourceLimits;
};

type ExtractJsonInput = {
  text: string;
  mode?: "first" | "all";
  allowRepair?: boolean;
  maxResults?: number;
};

const DEFAULT_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 1,
  maxAllocations: 250_000,
  maxMemory: 32 * 1024 * 1024,
  gcInterval: 2000,
  maxRecursionDepth: 300,
};

const MAX_LIMITS: MontyResourceLimits = {
  maxDurationSecs: 5,
  maxAllocations: 2_000_000,
  maxMemory: 128 * 1024 * 1024,
  gcInterval: 100_000,
  maxRecursionDepth: 2000,
};

function sanitizeTransformName(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) throw new Error("Transform name is required");
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Invalid transform name");
  }
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(trimmed)) {
    throw new Error("Invalid transform name");
  }
  return trimmed;
}

function parseTransformHeader(snippet: string): { name?: string; description?: string } {
  const lines = snippet.split(/\r?\n/).slice(0, 25);
  const out: { name?: string; description?: string } = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("#")) break;
    const m = line.match(/^#\s*([a-zA-Z0-9_-]{1,32})\s*:\s*(.+)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "name" && value) out.name = value;
    if (key === "description" && value) out.description = value;
  }
  return out;
}

export class MontyTools {
  private programCache = new MontyProgramCache(48);

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    private fileTools: FileTools,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "monty_run",
        description:
          "Run deterministic, sandboxed Python-subset code (Monty) for fast local computation and post-processing. " +
          "The input object is available as `input` inside the script. No file/network/shell access.",
        input_schema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "Monty (Python-subset) code. The value of the last expression is returned.",
            },
            inputs: {
              type: "object",
              description:
                "Arbitrary JSON-like input object available as `input` inside the script.",
            },
            limits: {
              type: "object",
              description: "Optional resource limits (clamped).",
              properties: {
                maxAllocations: { type: "number" },
                maxDurationSecs: { type: "number" },
                maxMemory: { type: "number" },
                gcInterval: { type: "number" },
                maxRecursionDepth: { type: "number" },
              },
            },
          },
          required: ["code"],
        },
      },
      {
        name: "monty_list_transforms",
        description:
          "List workspace-local Monty transforms from .cowork/transforms/*.monty with basic metadata (name, description, file stats).",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "monty_run_transform",
        description:
          "Run a named workspace transform from .cowork/transforms/<name>.monty. The input object is available as `input`.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Transform name (file name without extension)." },
            inputs: { type: "object", description: "Input object available as `input`." },
            limits: {
              type: "object",
              description: "Optional resource limits (clamped).",
              properties: {
                maxAllocations: { type: "number" },
                maxDurationSecs: { type: "number" },
                maxMemory: { type: "number" },
                gcInterval: { type: "number" },
                maxRecursionDepth: { type: "number" },
              },
            },
          },
          required: ["name"],
        },
      },
      {
        name: "monty_transform_file",
        description:
          "Read a text file, run a named workspace transform, and write the result to an output file, returning only a small summary. " +
          "This keeps large file contents out of the LLM context.",
        input_schema: {
          type: "object",
          properties: {
            transform: {
              type: "string",
              description: "Transform name (file name without extension).",
            },
            inputPath: {
              type: "string",
              description: "Input file path (workspace-relative preferred).",
            },
            outputPath: {
              type: "string",
              description: 'Output file path (defaults to "<inputPath>.monty.out").',
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite output file if it exists (default: false).",
            },
            maxInputBytes: {
              type: "number",
              description: "Maximum bytes to read from input file (default: 1_000_000).",
            },
            limits: {
              type: "object",
              description: "Optional resource limits (clamped).",
              properties: {
                maxAllocations: { type: "number" },
                maxDurationSecs: { type: "number" },
                maxMemory: { type: "number" },
                gcInterval: { type: "number" },
                maxRecursionDepth: { type: "number" },
              },
            },
          },
          required: ["transform", "inputPath"],
        },
      },
      {
        name: "extract_json",
        description:
          "Extract and parse JSON objects/arrays from messy text (e.g., model output with prose and code fences). Returns parsed JSON.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text containing JSON." },
            mode: {
              type: "string",
              enum: ["first", "all"],
              description: "Return only the first JSON value or all found.",
            },
            allowRepair: {
              type: "boolean",
              description:
                "Attempt light JSON repairs (trailing commas, unquoted keys, etc.). Default: true.",
            },
            maxResults: {
              type: "number",
              description: 'Max number of JSON values to return when mode="all" (default: 5).',
            },
          },
          required: ["text"],
        },
      },
    ];
  }

  async montyRun(input: MontyRunInput): Promise<Any> {
    const code = String(input?.code ?? "");
    const inputs = (input as Any)?.inputs ?? null;

    const clamped = clampMontyLimits(input?.limits, MAX_LIMITS) || {};
    const limits: MontyResourceLimits = { ...DEFAULT_LIMITS, ...clamped };

    const stdlib = createMontySafeStdlib();
    const externalFunctions = Object.fromEntries(
      Object.entries(stdlib).map(([k, fn]) => [k, fn as Any]),
    );

    this.daemon.logEvent(this.taskId, "log", { message: "monty_run: executing code" });

    const res = await runMontyCode({
      code,
      input: inputs,
      scriptName: "monty_run.py",
      limits,
      externalFunctions,
    });

    if (!res.ok) {
      return { success: false, error: res.error };
    }

    return { success: true, output: res.output };
  }

  async listTransforms(_input?: MontyListTransformsInput): Promise<Any> {
    const dir = path.join(this.workspace.path, ".cowork", "transforms");
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: Any[] = [];
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!ent.name.toLowerCase().endsWith(".monty")) continue;

        const absPath = path.join(dir, ent.name);
        let stat: Any;
        try {
          stat = await fs.stat(absPath);
        } catch {
          continue;
        }

        let snippet = "";
        try {
          const buf = await fs.readFile(absPath, "utf8");
          snippet = buf.slice(0, 4096);
        } catch {
          // ignore snippet errors
        }

        const header = parseTransformHeader(snippet);
        const baseName = ent.name.replace(/\.monty$/i, "");
        out.push({
          name: header.name || baseName,
          id: baseName,
          relPath: path.join(".cowork", "transforms", ent.name).replace(/\\/g, "/"),
          description: header.description,
          sizeBytes: stat?.size,
          modifiedAt: stat?.mtimeMs,
        });
      }

      out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { success: true, transforms: out };
    } catch (error: Any) {
      if (error?.code === "ENOENT") {
        return { success: true, transforms: [] };
      }
      return { success: false, error: error?.message || String(error) };
    }
  }

  private async loadTransformCode(
    name: string,
  ): Promise<{ id: string; absPath: string; code: string }> {
    const safe = sanitizeTransformName(name);
    const file = safe.toLowerCase().endsWith(".monty") ? safe : `${safe}.monty`;
    const absPath = path.join(this.workspace.path, ".cowork", "transforms", file);
    const code = await fs.readFile(absPath, "utf8");
    const id = file.replace(/\.monty$/i, "");
    return { id, absPath, code };
  }

  async runTransform(input: MontyTransformRunInput): Promise<Any> {
    const { id, absPath, code } = await this.loadTransformCode(input?.name);

    const clamped = clampMontyLimits(input?.limits, MAX_LIMITS) || {};
    const limits: MontyResourceLimits = { ...DEFAULT_LIMITS, ...clamped };

    const stdlib = createMontySafeStdlib();
    const externalFunctions = Object.fromEntries(
      Object.entries(stdlib).map(([k, fn]) => [k, fn as Any]),
    );

    const cacheKey = `transform:${absPath}:${sha256Hex(code)}`;
    const res = await runMontyCode({
      code,
      input: (input as Any)?.inputs ?? null,
      scriptName: path.basename(absPath),
      limits,
      externalFunctions,
      cache: this.programCache,
      cacheKey,
    });

    if (!res.ok) {
      return { success: false, transform: id, error: res.error };
    }

    return { success: true, transform: id, output: res.output };
  }

  async transformFile(input: MontyTransformFileInput): Promise<Any> {
    const transformName = String((input as Any)?.transform ?? "");
    const inputPath = String((input as Any)?.inputPath ?? "");
    if (!transformName.trim()) throw new Error("transform is required");
    if (!inputPath.trim()) throw new Error("inputPath is required");

    const { id, absPath, code } = await this.loadTransformCode(transformName);

    const maxInputBytes =
      typeof input?.maxInputBytes === "number" && Number.isFinite(input.maxInputBytes)
        ? Math.max(1, Math.min(5_000_000, input.maxInputBytes))
        : 1_000_000;

    const raw = await this.fileTools.readTextFileRaw(inputPath, { maxBytes: maxInputBytes });
    const fileText = raw.content;

    const clamped = clampMontyLimits(input?.limits, MAX_LIMITS) || {};
    const limits: MontyResourceLimits = { ...DEFAULT_LIMITS, ...clamped };

    const stdlib = createMontySafeStdlib();
    const externalFunctions = Object.fromEntries(
      Object.entries(stdlib).map(([k, fn]) => [k, fn as Any]),
    );

    const cacheKey = `transform:${absPath}:${sha256Hex(code)}`;
    const res = await runMontyCode({
      code,
      input: {
        path: inputPath,
        text: fileText,
        truncated: !!raw.truncated,
        sizeBytes: raw.size,
      },
      scriptName: path.basename(absPath),
      limits,
      externalFunctions,
      cache: this.programCache,
      cacheKey,
    });

    if (!res.ok) {
      return { success: false, transform: id, error: res.error };
    }

    const outputPath =
      input.outputPath && String(input.outputPath).trim().length > 0
        ? String(input.outputPath).trim()
        : `${inputPath}.monty.out`;

    const overwrite = !!input.overwrite;
    if (!overwrite) {
      try {
        await this.fileTools.getFileInfo(outputPath);
        return {
          success: false,
          error: `Output path exists: ${outputPath} (set overwrite=true to overwrite)`,
        };
      } catch {
        // does not exist
      }
    }

    const outValue = res.output;
    const outText = typeof outValue === "string" ? outValue : JSON.stringify(outValue, null, 2);

    const writeRes = await this.fileTools.writeFile(outputPath, outText);
    return {
      success: true,
      transform: id,
      inputPath,
      inputSizeBytes: raw.size,
      inputTruncated: !!raw.truncated,
      outputPath: writeRes.path,
      outputSizeBytes: Buffer.byteLength(outText, "utf8"),
      outputType: typeof outValue,
    };
  }

  async extractJson(input: ExtractJsonInput): Promise<Any> {
    const text = String((input as Any)?.text ?? "");
    const allowRepair = input.allowRepair !== false;
    const maxResults =
      typeof input.maxResults === "number" && Number.isFinite(input.maxResults)
        ? Math.max(1, Math.min(50, input.maxResults))
        : 5;

    const values = extractJsonValues(text, { maxResults, allowRepair, maxCandidateChars: 400_000 });
    const mode = input.mode === "all" ? "all" : "first";

    if (mode === "first") {
      return {
        success: true,
        found: values.length > 0,
        value: values.length > 0 ? values[0] : null,
      };
    }

    return {
      success: true,
      count: values.length,
      values,
    };
  }
}
