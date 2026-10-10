import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createSandbox } from "../../agent/sandbox/sandbox-factory";
import type { CompileLatexParams, LatexEngine } from "../document-generators/latex-compiler";
import type { ISandbox } from "../../agent/sandbox/sandbox-factory";
import { compileLatex, findLatexEngine } from "../document-generators/latex-compiler";

describe("latex compiler", () => {
  const workspaces: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(workspaces.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
  });
  function sandboxFor(execute: ISandbox["execute"], type: ISandbox["type"] = "macos") {
    const sandbox: ISandbox = {
      type,
      execute,
      initialize: vi.fn(),
      executeCode: vi.fn(),
      cleanup: vi.fn(),
    };
    return vi.fn(
      async (
        _workspace: Parameters<
          NonNullable<Parameters<typeof compileLatex>[0]["sandboxFactory"]>
        >[0],
      ) => sandbox,
    );
  }
  function ok(stdout = "") {
    return { exitCode: 0, stdout, stderr: "", killed: false, timedOut: false };
  }

  async function makeWorkspace(): Promise<string> {
    const workspace = path.join(os.tmpdir(), `cowork-latex-${randomUUID()}`);
    await fs.mkdir(workspace, { recursive: true });
    workspaces.push(workspace);
    return fs.realpath(workspace);
  }

  it("selects the first installed engine in priority order", async () => {
    const execFileImpl = vi.fn(async (file: string, args: string[]) => {
      if (file !== "which") throw new Error("unexpected command");
      if (args[0] === "latexmk") return { stdout: "/usr/bin/latexmk\n", stderr: "" };
      throw new Error("not found");
    });

    await expect(findLatexEngine("auto", execFileImpl)).resolves.toBe("latexmk");
    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      "which",
      ["tectonic"],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      "which",
      ["latexmk"],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("returns a clear failure when no engine is installed", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "paper.tex"),
      "\\documentclass{article}\\begin{document}Hi\\end{document}",
    );
    const execFileImpl = vi.fn(async () => {
      throw new Error("not found");
    });

    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      sandboxFactory: sandboxFor(execFileImpl as ISandbox["execute"]),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No LaTeX engine");
    await expect(fs.access(path.join(workspace, "paper.pdf"))).rejects.toThrow();
  });

  it("runs a selected engine with bounded args and returns the generated PDF", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "paper.tex");
    await fs.writeFile(sourcePath, "\\documentclass{article}\\begin{document}Hi\\end{document}");
    const execFileImpl = vi.fn(async (file: string, args: string[]) => {
      if (file === "which") return ok("/usr/bin/pdflatex\n");
      expect(file).toBe("/usr/bin/env");
      expect(args).toContain("pdflatex");
      expect(args).toContain("-interaction=nonstopmode");
      expect(args).toContain("-halt-on-error");
      const outputDir = args[args.indexOf("-output-directory") + 1];
      await fs.writeFile(path.join(outputDir, "paper.pdf"), "%PDF-1.4\n");
      return ok("ok");
    });

    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      engine: "pdflatex",
      sandboxFactory: sandboxFor(execFileImpl as ISandbox["execute"]),
    });

    expect(result.success).toBe(true);
    expect(result.engine).toBe("pdflatex");
    expect(result.pdfPath).toBe(path.join(workspace, "paper.pdf"));
    expect(result.size).toBeGreaterThan(0);
  });

  it("rejects source paths outside the workspace", async () => {
    const workspace = await makeWorkspace();
    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "../paper.tex",
      sandboxFactory: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("inside the workspace");
  });

  it("fails closed when process isolation is unavailable", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "paper.tex"), "hello");
    const execute = vi.fn();
    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      sandboxFactory: sandboxFor(execute, "none"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("refusing unsandboxed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["tectonic", "latexmk", "xelatex", "lualatex", "pdflatex"] as const)(
    "isolates %s with network disabled and private output",
    async (engine) => {
      const workspace = await makeWorkspace();
      await fs.writeFile(path.join(workspace, "paper.tex"), "hello");
      const execute = vi.fn(async (command, args = [], options) => {
        expect(options?.allowNetwork).toBe(false);
        expect(options?.envPassthrough).toEqual(["PATH", "LANG"]);
        if (command === "which" || command === "where") return ok();
        const outputFlag =
          engine === "tectonic"
            ? "--outdir"
            : engine === "latexmk"
              ? "-outdir"
              : "-output-directory";
        const scratch =
          engine === "latexmk"
            ? args.find((arg) => arg.startsWith("-outdir="))!.slice(8)
            : args[args.indexOf(outputFlag) + 1];
        expect(scratch).not.toBe(workspace);
        expect(args).toContain("openout_any=p");
        if (engine === "tectonic") {
          expect(args).toContain("--only-cached");
          expect(args).toContain("--untrusted");
        } else expect(args).toContain("-no-shell-escape");
        if (engine === "latexmk") expect(args).toContain("-norc");
        await fs.writeFile(path.join(scratch, "paper.pdf"), "%PDF-1.4\n");
        return ok();
      });
      const factory = sandboxFor(execute);
      const result = await compileLatex({
        workspacePath: workspace,
        sourcePath: "paper.tex",
        engine,
        sandboxFactory: factory,
      });
      expect(result.success).toBe(true);
      const policy = factory.mock.calls[0][0];
      expect(policy.permissions.accessFilesystemScoped).toBe(true);
      expect(policy.permissions.accessFilesystemRules).toContainEqual({
        path: workspace,
        access: "read",
      });
      await expect(fs.access(policy.path)).rejects.toThrow();
    },
  );

  it("rejects a source alias substituted after caller authorization", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await fs.writeFile(path.join(outside, "secret.tex"), "private");
    await fs.symlink(path.join(outside, "secret.tex"), path.join(workspace, "paper.tex"));
    const factory = vi.fn();
    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: path.join(workspace, "paper.tex"),
      allowExternalPaths: true,
      sandboxFactory: factory,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("changed after authorization");
    expect(factory).not.toHaveBeenCalled();
  });

  it("refuses a PDF destination redirected during compilation", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const secret = path.join(outside, "secret");
    await fs.writeFile(secret, "unchanged");
    await fs.writeFile(path.join(workspace, "paper.tex"), "hello");
    const execute = vi.fn(async (command, args = []) => {
      if (command === "which") return ok();
      const scratch = args[args.indexOf("-output-directory") + 1];
      await fs.writeFile(path.join(scratch, "paper.pdf"), "%PDF-1.4");
      await fs.symlink(secret, path.join(workspace, "paper.pdf"));
      return ok();
    });
    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      engine: "pdflatex",
      sandboxFactory: sandboxFor(execute),
    });
    expect(result.success).toBe(false);
    expect(await fs.readFile(secret, "utf8")).toBe("unchanged");
  });

  it("stages Tectonic resources without following cache symlinks", async () => {
    const workspace = await makeWorkspace();
    const home = await makeWorkspace();
    const cache = path.join(home, "Library", "Caches", "TectonicProject.Tectonic");
    await fs.mkdir(path.join(cache, "bundles"), { recursive: true });
    await fs.mkdir(path.join(cache, "formats"));
    await fs.writeFile(path.join(home, "secret"), "private");
    await fs.writeFile(path.join(cache, "bundles", "public-resource"), "public");
    await fs.symlink(path.join(home, "secret"), path.join(cache, "bundles", "alias"));
    await fs.writeFile(path.join(workspace, "paper.tex"), "hello");
    vi.stubEnv("HOME", home);
    const execute = vi.fn(async (command, args = []) => {
      if (command === "which") return ok();
      const privateCache = args.find((arg) => arg.startsWith("TECTONIC_CACHE_DIR="))!.split("=")[1];
      expect(privateCache).not.toBe(cache);
      expect(await fs.readFile(path.join(privateCache, "bundles", "public-resource"), "utf8")).toBe(
        "public",
      );
      await expect(fs.lstat(path.join(privateCache, "bundles", "alias"))).rejects.toThrow();
      const scratch = args[args.indexOf("--outdir") + 1];
      await fs.writeFile(path.join(scratch, "paper.pdf"), "%PDF-1.4");
      return ok();
    });
    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      engine: "tectonic",
      sandboxFactory: sandboxFor(execute),
    });
    expect(result.success, result.diagnostic).toBe(true);
  });

  const live = process.env.COWORK_LATEX_SANDBOX_LIVE === "1";
  const engines = (
    process.env.COWORK_LATEX_LIVE_ENGINES || "latexmk,xelatex,lualatex,pdflatex"
  ).split(",") as LatexEngine[];
  const dockerImage = process.env.COWORK_LATEX_DOCKER_IMAGE;
  it.runIf(live).each(engines)(
    "live %s blocks host reads and retains local includes",
    async (engine) => {
      let networkVerified = false;
      const compileLive = (params: CompileLatexParams) =>
        compileLatex({
          ...params,
          ...(dockerImage
            ? {
                workspacePermissions: {
                  read: true,
                  write: true,
                  delete: true,
                  shell: true,
                  network: false,
                  ...params.workspacePermissions,
                  dockerConfig: { image: dockerImage },
                },
              }
            : {}),
          sandboxFactory: async (sandboxWorkspace) => {
            const expectedType = dockerImage ? "docker" : "macos";
            const sandbox = await createSandbox(sandboxWorkspace, expectedType);
            expect(sandbox.type).toBe(expectedType);
            if (!networkVerified) {
              const probe = await sandbox.execute(
                "node",
                [
                  "-e",
                  "const net=require('node:net');const s=net.createConnection({host:'198.51.100.1',port:443});s.on('connect',()=>process.exit(1));s.on('error',e=>{console.log(e.code);process.exit(0)});setTimeout(()=>process.exit(2),2000)",
                ],
                {
                  cwd: sandboxWorkspace.path,
                  allowNetwork: false,
                  privateDocumentWorkspace: true,
                  timeout: 5000,
                },
              );
              expect(probe.exitCode, probe.stderr).toBe(0);
              expect(probe.stdout.trim()).toMatch(/^(EPERM|EACCES|ENETUNREACH)$/);
              networkVerified = true;
            }
            return sandbox;
          },
        });
      const workspace = await makeWorkspace();
      const outside = await makeWorkspace();
      const sentinel = "LATEX_HOST_SENTINEL_" + randomUUID().replaceAll("-", "");
      const secretPath = path.join(outside, "secret.tex");
      await fs.writeFile(secretPath, sentinel);
      await fs.writeFile(path.join(workspace, "local.tex"), "Local dependency");
      await fs.mkdir(path.join(workspace, "nested"));
      await fs.writeFile(
        path.join(workspace, "nested", "paper.tex"),
        String.raw`\documentclass{article}\begin{document}\input{../local.tex}\end{document}`,
      );
      const good = await compileLive({
        workspacePath: workspace,
        sourcePath: "nested/paper.tex",
        outputPath: "custom.pdf",
        engine,
      });
      expect(good.success, good.diagnostic).toBe(true);
      expect((await fs.readFile(good.pdfPath)).subarray(0, 5).toString()).toBe("%PDF-");
      await fs.writeFile(path.join(outside, "chapter.tex"), "Approved dependency");
      await fs.writeFile(
        path.join(outside, "approved.tex"),
        String.raw`\documentclass{article}\begin{document}\input{chapter.tex}\end{document}`,
      );
      const approved = await compileLive({
        workspacePath: workspace,
        sourcePath: path.join(outside, "approved.tex"),
        outputPath: "approved.pdf",
        engine,
        allowExternalPaths: true,
        workspacePermissions: {
          read: true,
          write: true,
          delete: true,
          shell: true,
          network: false,
          accessFilesystemScoped: true,
          accessFilesystemRules: [{ path: outside, access: "read" }],
        },
      });
      expect(approved.success, approved.diagnostic).toBe(true);
      // Establish the original host-execution trigger without exposing real secrets.
      const trigger = String.raw`\documentclass{article}\begin{document}\newread\secret\openin\secret=${secretPath}\relax\ifeof\secret\errmessage{Blocked input}\else\read\secret to\stolen\typeout{\stolen}\fi Control page\end{document}`;
      await fs.writeFile(
        path.join(outside, "control.tex"),
        dockerImage ? trigger.replace(secretPath, "/control/secret.tex") : trigger,
      );
      const hostArgs =
        engine === "tectonic"
          ? ["--only-cached", "--print", "control.tex"]
          : engine === "latexmk"
            ? ["-norc", "-no-shell-escape", "-pdf", "control.tex"]
            : ["-no-shell-escape", "-interaction=nonstopmode", "control.tex"];
      const hostOutput = execFileSync(
        dockerImage ? "docker" : engine,
        dockerImage
          ? [
              "run",
              "--rm",
              "--network=none",
              "-v",
              `${outside}:/control`,
              "-w",
              "/control",
              dockerImage,
              engine,
              ...hostArgs,
            ]
          : hostArgs,
        {
          cwd: outside,
          encoding: "utf8",
          timeout: 120000,
        },
      );
      expect(hostOutput).toContain(sentinel);
      await fs.symlink(secretPath, path.join(workspace, "alias.tex"));
      await fs.writeFile(path.join(outside, ".gitconfig"), sentinel);
      await fs.mkdir(path.join(outside, ".npm"));
      await fs.writeFile(path.join(outside, ".npm", "secret.tex"), sentinel);
      if (engine !== "tectonic") vi.stubEnv("HOME", outside);
      for (const target of [
        secretPath,
        path.relative(workspace, secretPath),
        "alias.tex",
        path.join(outside, ".gitconfig"),
        path.join(outside, ".npm", "secret.tex"),
      ]) {
        await fs.writeFile(path.join(workspace, "paper.tex"), trigger.replace(secretPath, target));
        const bad = await compileLive({
          workspacePath: workspace,
          sourcePath: "paper.tex",
          engine,
        });
        expect(bad.success).toBe(false);
        expect(bad.diagnostic).not.toContain(sentinel);
        await expect(fs.access(path.join(workspace, "paper.pdf"))).rejects.toThrow();
      }
    },
    120000,
  );
});
