import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkspacePermissions } from "../../../shared/types";
import { createSandbox, type ISandbox } from "../../agent/sandbox/sandbox-factory";
import {
  evaluateWorkspaceFilesystemAccess,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";

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
  /** Set only after the caller has separately approved each external path. */
  allowExternalPaths?: boolean;
  workspacePermissions?: WorkspacePermissions;
  sandboxFactory?: typeof createSandbox;
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

function resolveWorkspacePath(
  workspacePath: string,
  requestedPath: string,
  label: string,
  allowExternalPaths = false,
): string {
  const trimmed = String(requestedPath || "").trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspacePath, trimmed);
  if (!allowExternalPaths && !isPathInsideWorkspace(resolved, workspacePath)) {
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
  return trimDiagnostic(
    [stringifyOutput(stdout), stringifyOutput(stderr)].filter(Boolean).join("\n"),
  );
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
      return [
        "--only-cached",
        "--untrusted",
        "--keep-logs",
        "--keep-intermediates",
        "--outdir",
        outputDir,
        sourcePath,
      ];
    case "latexmk":
      return [
        // -norc: latexmk otherwise evaluates ./latexmkrc and ./.latexmkrc from
        // its working directory as Perl. That directory holds the agent-authored
        // .tex file, so an agent that can write the workspace could drop a
        // .latexmkrc containing system(...) and get it executed by asking for a
        // compile — no shell tool, no approval prompt.
        "-norc",
        // Shell-escape lets \write18 run commands from inside the document.
        "-no-shell-escape",
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
        // Same reasoning as above: block \write18 from the document itself.
        "-no-shell-escape",
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
  const workspacePath = resolveAccessControlledPath(params.workspacePath, params.workspacePath);
  let sandbox: ISandbox | undefined;
  let scratchPath: string | undefined;
  let sourcePath = "";
  let pdfPath = "";
  let logPath = "";

  try {
    sourcePath = resolveAccessControlledPath(
      workspacePath,
      resolveWorkspacePath(
        workspacePath,
        params.sourcePath,
        "sourcePath",
        params.allowExternalPaths,
      ),
    );
    if (
      params.allowExternalPaths &&
      sourcePath !== path.resolve(workspacePath, params.sourcePath)
    ) {
      throw new Error("LaTeX source path changed after authorization");
    }
    if (path.extname(sourcePath).toLowerCase() !== ".tex") {
      throw new Error("sourcePath must point to a .tex file");
    }

    const requestedOutputPath = params.outputPath
      ? resolveWorkspacePath(
          workspacePath,
          params.outputPath,
          "outputPath",
          params.allowExternalPaths,
        )
      : path.join(
          path.dirname(sourcePath),
          `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
        );
    const outputPath = resolveAccessControlledPath(workspacePath, requestedOutputPath);
    if (params.allowExternalPaths && outputPath !== requestedOutputPath) {
      throw new Error("LaTeX output path changed after authorization");
    }
    if (
      !params.allowExternalPaths &&
      (!isPathInsideWorkspace(sourcePath, workspacePath) ||
        !isPathInsideWorkspace(outputPath, workspacePath))
    ) {
      throw new Error("Source and output must be inside the workspace (including symlink targets)");
    }
    if (path.extname(outputPath).toLowerCase() !== ".pdf") {
      throw new Error("outputPath must point to a .pdf file");
    }

    pdfPath = outputPath;
    const outputDir = path.dirname(outputPath);
    const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
    // The interpreter writes only to private scratch. One approved PDF path
    // must never grant it write access to that path's parent directory.
    scratchPath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-latex-"));
    const compilerPdfPath = path.join(scratchPath, `${sourceBase}.pdf`);
    logPath = path.join(outputDir, `${sourceBase}.log`);

    await fs.access(sourcePath);
    const permissions = params.workspacePermissions;
    const policyWorkspace = {
      path: workspacePath,
      permissions: permissions || {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
      },
    };
    for (const [target, operation] of [
      [sourcePath, "read"],
      [pdfPath, "write"],
    ] as const) {
      const access = evaluateWorkspaceFilesystemAccess(policyWorkspace, target, operation);
      if (
        access.decision !== "allow" &&
        !(params.allowExternalPaths && access.reason === "outside_workspace")
      ) {
        throw new Error(`LaTeX ${operation} access denied: ${access.reason}`);
      }
    }
    const sandboxWorkspace = {
      id: "latex-compiler",
      name: "LaTeX compiler",
      path: scratchPath,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessFilesystemScoped: true,
        accessSandboxMode: "workspace-write" as const,
        accessNetworkMode: "disabled" as const,
        accessWorkspaceRoots: [scratchPath],
        accessFilesystemRules: [
          ...(permissions?.read === false
            ? []
            : [{ path: workspacePath, access: "read" as const }]),
          ...[...(permissions?.accessWorkspaceRoots || []), ...(permissions?.allowedPaths || [])]
            .map((root) => resolveAccessControlledPath(workspacePath, root))
            .filter(
              (root) =>
                evaluateWorkspaceFilesystemAccess(policyWorkspace, root, "read").decision ===
                "allow",
            )
            .map((root) => ({ path: root, access: "read" as const })),
          ...(permissions?.accessFilesystemRules || []).map((rule) => ({
            path: resolveAccessControlledPath(workspacePath, rule.path),
            access: rule.access === "write" ? ("read" as const) : rule.access,
          })),
        ],
        ...(permissions?.dockerConfig ? { dockerConfig: permissions.dockerConfig } : {}),
      },
    };
    sandbox = await (params.sandboxFactory || createSandbox)(sandboxWorkspace);
    if (sandbox.type === "none") {
      throw new Error(
        "LaTeX compilation requires an OS process sandbox; refusing unsandboxed execution",
      );
    }
    const execImpl: ExecFileLike = async (command, args, options) => {
      const result = await sandbox!.execute(command, args, {
        cwd: options.cwd || scratchPath,
        timeout: options.timeout,
        maxOutputSize: options.maxBuffer,
        allowNetwork: false,
        privateDocumentWorkspace: true,
        envPassthrough: ["PATH", "LANG"],
      });
      if (result.exitCode !== 0 || result.killed || result.timedOut || result.error) {
        throw Object.assign(new Error(result.error || "LaTeX sandbox command failed"), {
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      return result;
    };
    // Only the separately approved external source is staged. Its siblings do
    // not become implicit dependencies with host access.
    let compilerSourcePath = sourcePath;
    if (
      !isPathInsideWorkspace(sourcePath, workspacePath) &&
      evaluateWorkspaceFilesystemAccess(sandboxWorkspace, sourcePath, "read").decision !== "allow"
    ) {
      compilerSourcePath = path.join(scratchPath, path.basename(sourcePath));
      const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await fs.writeFile(compilerSourcePath, await source.readFile());
      } finally {
        await source.close();
      }
    }

    const engine = await findLatexEngine(params.engine || "auto", execImpl);
    if (!engine) {
      const requested = params.engine && params.engine !== "auto" ? ` "${params.engine}"` : "";
      const error = `No LaTeX engine${requested} found. Install tectonic, latexmk, xelatex, lualatex, or pdflatex and retry.`;
      return {
        success: false,
        sourcePath,
        pdfPath,
        logPath,
        error,
        diagnostic: error,
      };
    }

    // Docker maps the private sandbox workspace to /workspace. Embedded
    // option/environment values are not rewritten by its argv mapper.
    const engineOutputDir = sandbox.type === "docker" ? "/workspace" : scratchPath;
    const resourceEnv: string[] = [];
    if (engine === "tectonic" && sandbox.type === "macos") {
      // Tectonic needs its public bundle and format cache even in offline
      // mode. Stage those resources, not user configuration, and never follow
      // links from the cache into other host files.
      const cacheRoot = path.join(os.homedir(), "Library", "Caches", "TectonicProject.Tectonic");
      const privateCache = path.join(scratchPath, "tectonic-cache");
      await fs.mkdir(privateCache);
      for (const resource of ["bundles", "formats"]) {
        const cached = path.join(cacheRoot, resource);
        try {
          if (
            !(await fs.lstat(cacheRoot)).isDirectory() ||
            !(await fs.lstat(cached)).isDirectory()
          ) {
            throw new Error("Tectonic cache must contain regular resource directories");
          }
          await fs.cp(cached, path.join(privateCache, resource), {
            recursive: true,
            dereference: false,
            filter: async (entry) => !(await fs.lstat(entry)).isSymbolicLink(),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      resourceEnv.push(`TECTONIC_CACHE_DIR=${privateCache}`);
    }
    let diagnostic = "";
    try {
      const commandResult = await execImpl(
        "/usr/bin/env",
        [
          // C locale needs no host locale files (Perl and LuaTeX otherwise
          // fail inside a restricted macOS process sandbox).
          "LC_ALL=C",
          "LC_CTYPE=C",
          "LANG=C",
          `TEXMFVAR=${engineOutputDir}`,
          `TEXMFCACHE=${engineOutputDir}`,
          ...resourceEnv,
          "openin_any=a",
          "openout_any=p",
          engine,
          ...buildLatexCommand(engine, path.basename(compilerSourcePath), engineOutputDir),
        ],
        {
          cwd: path.dirname(compilerSourcePath),
          timeout: COMPILE_TIMEOUT_MS,
          maxBuffer: COMPILE_MAX_BUFFER,
        },
      );
      diagnostic = createDiagnostic(commandResult.stdout, commandResult.stderr);
    } catch (compileError: unknown) {
      const error = compileError as { stdout?: unknown; stderr?: unknown; message?: string };
      diagnostic =
        createDiagnostic(error.stdout, error.stderr) || String(error.message || compileError);
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

    if (!(await fs.lstat(compilerPdfPath)).isFile()) {
      throw new Error("LaTeX output must be a regular file");
    }
    await fs.mkdir(outputDir, { recursive: true });
    if (resolveAccessControlledPath(workspacePath, pdfPath) !== pdfPath) {
      throw new Error("LaTeX output path changed after authorization");
    }
    const output = await fs.open(
      pdfPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (resolveAccessControlledPath(workspacePath, pdfPath) !== pdfPath) {
        throw new Error("LaTeX output path changed after authorization");
      }
      await output.truncate(0);
      const compiled = await fs.open(compilerPdfPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await compiled.stat()).isFile())
          throw new Error("LaTeX output must be a regular file");
        await pipeline(compiled.createReadStream(), output.createWriteStream());
      } finally {
        await compiled.close();
      }
    } finally {
      await output.close();
    }
    // External approval covers the requested PDF, not a sibling log file.
    logPath = resolveAccessControlledPath(workspacePath, logPath);
    if (
      isPathInsideWorkspace(logPath, workspacePath) &&
      evaluateWorkspaceFilesystemAccess(policyWorkspace, logPath, "write").decision === "allow"
    ) {
      const compilerLog = path.join(scratchPath, `${sourceBase}.log`);
      try {
        if ((await fs.lstat(compilerLog)).isFile()) await fs.copyFile(compilerLog, logPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      logPath = "";
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
  } finally {
    sandbox?.cleanup();
    if (scratchPath) await fs.rm(scratchPath, { recursive: true, force: true });
  }
}
