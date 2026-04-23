import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type LatexEngine = "tectonic" | "latexmk" | "xelatex" | "lualatex" | "pdflatex";
export type LatexEngineInput = "auto" | LatexEngine;

type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

export type CompileLatexParams = {
  workspacePath: string;
  sourcePath: string;
  outputPath?: string;
  engine?: LatexEngineInput;
  execFileImpl?: ExecFileLike;
};

export type CompileLatexResult = {
  success: boolean;
  sourcePath: string;
  pdfPath: string;
  logPath: string;
  engine?: LatexEngine;
  diagnostic: string;
  size?: number;
  error?: string;
};

const ENGINE_ORDER: LatexEngine[] = ["tectonic", "latexmk", "xelatex", "lualatex", "pdflatex"];
const COMPILE_TIMEOUT_MS = 120_000;
const COMPILE_MAX_BUFFER = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 8_000;

function isPathInsideWorkspace(targetPath: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(workspacePath: string, requestedPath: string, label: string): string {
  const trimmed = String(requestedPath || "").trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspacePath, trimmed);
  if (!isPathInsideWorkspace(resolved, workspacePath)) {
    throw new Error(`${label} must be inside the workspace`);
  }
  return resolved;
}

function stringifyOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : "";
}

function trimDiagnostic(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_DIAGNOSTIC_CHARS) return normalized;
  return normalized.slice(normalized.length - MAX_DIAGNOSTIC_CHARS).trimStart();
}

function createDiagnostic(stdout?: unknown, stderr?: unknown): string {
  return trimDiagnostic([stringifyOutput(stdout), stringifyOutput(stderr)].filter(Boolean).join("\n"));
}

async function commandExists(command: string, execImpl: ExecFileLike): Promise<boolean> {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    await execImpl(locator, [command], { timeout: 5_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function findLatexEngine(
  requested: LatexEngineInput | undefined,
  execImpl: ExecFileLike = execFile,
): Promise<LatexEngine | null> {
  const candidates = requested && requested !== "auto" ? [requested] : ENGINE_ORDER;
  for (const candidate of candidates) {
    if (await commandExists(candidate, execImpl)) {
      return candidate;
    }
  }
  return null;
}

function buildLatexCommand(engine: LatexEngine, sourcePath: string, outputDir: string): string[] {
  switch (engine) {
    case "tectonic":
      return ["--keep-logs", "--keep-intermediates", "--outdir", outputDir, sourcePath];
    case "latexmk":
      return [
        "-pdf",
        "-interaction=nonstopmode",
        "-halt-on-error",
        `-outdir=${outputDir}`,
        sourcePath,
      ];
    case "xelatex":
    case "lualatex":
    case "pdflatex":
      return [
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-output-directory",
        outputDir,
        sourcePath,
      ];
  }
}

export async function compileLatex(params: CompileLatexParams): Promise<CompileLatexResult> {
  const workspacePath = path.resolve(params.workspacePath);
  const execImpl = params.execFileImpl || execFile;
  let sourcePath = "";
  let pdfPath = "";
  let logPath = "";

  try {
    sourcePath = resolveWorkspacePath(workspacePath, params.sourcePath, "sourcePath");
    if (path.extname(sourcePath).toLowerCase() !== ".tex") {
      throw new Error("sourcePath must point to a .tex file");
    }

    const outputPath = params.outputPath
      ? resolveWorkspacePath(workspacePath, params.outputPath, "outputPath")
      : path.join(path.dirname(sourcePath), `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
    if (path.extname(outputPath).toLowerCase() !== ".pdf") {
      throw new Error("outputPath must point to a .pdf file");
    }

    pdfPath = outputPath;
    const outputDir = path.dirname(outputPath);
    const sourceBase = path.basename(sourcePath, ".tex");
    const compilerPdfPath = path.join(outputDir, `${sourceBase}.pdf`);
    logPath = path.join(outputDir, `${sourceBase}.log`);

    await fs.access(sourcePath);
    await fs.mkdir(outputDir, { recursive: true });

    const engine = await findLatexEngine(params.engine || "auto", execImpl);
    if (!engine) {
      const requested = params.engine && params.engine !== "auto" ? ` "${params.engine}"` : "";
      const error =
        `No LaTeX engine${requested} found. Install tectonic, latexmk, xelatex, lualatex, or pdflatex and retry.`;
      return {
        success: false,
        sourcePath,
        pdfPath,
        logPath,
        error,
        diagnostic: error,
      };
    }

    let diagnostic = "";
    try {
      const commandResult = await execImpl(engine, buildLatexCommand(engine, sourcePath, outputDir), {
        cwd: path.dirname(sourcePath),
        timeout: COMPILE_TIMEOUT_MS,
        maxBuffer: COMPILE_MAX_BUFFER,
      });
      diagnostic = createDiagnostic(commandResult.stdout, commandResult.stderr);
    } catch (compileError: unknown) {
      const error = compileError as { stdout?: unknown; stderr?: unknown; message?: string };
      diagnostic = createDiagnostic(error.stdout, error.stderr) || String(error.message || compileError);
      return {
        success: false,
        sourcePath,
        pdfPath,
        logPath,
        engine,
        error: "LaTeX compilation failed",
        diagnostic,
      };
    }

    try {
      await fs.access(compilerPdfPath);
    } catch {
      return {
        success: false,
        sourcePath,
        pdfPath,
        logPath,
        engine,
        error: "LaTeX compiler completed but did not produce a PDF",
        diagnostic,
      };
    }

    if (compilerPdfPath !== pdfPath) {
      await fs.rename(compilerPdfPath, pdfPath);
    }

    const stats = await fs.stat(pdfPath);
    return {
      success: true,
      sourcePath,
      pdfPath,
      logPath,
      engine,
      size: stats.size,
      diagnostic,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sourcePath,
      pdfPath,
      logPath,
      error: message,
      diagnostic: message,
    };
  }
}
