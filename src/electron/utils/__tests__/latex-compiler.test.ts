import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compileLatex, findLatexEngine } from "../document-generators/latex-compiler";

describe("latex compiler", () => {
  async function makeWorkspace(): Promise<string> {
    const workspace = path.join(os.tmpdir(), `cowork-latex-${randomUUID()}`);
    await fs.mkdir(workspace, { recursive: true });
    return workspace;
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
    await fs.writeFile(path.join(workspace, "paper.tex"), "\\documentclass{article}\\begin{document}Hi\\end{document}");
    const execFileImpl = vi.fn(async () => {
      throw new Error("not found");
    });

    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      execFileImpl,
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
      if (file === "which") return { stdout: "/usr/bin/pdflatex\n", stderr: "" };
      expect(file).toBe("pdflatex");
      expect(args).toContain("-interaction=nonstopmode");
      expect(args).toContain("-halt-on-error");
      await fs.writeFile(path.join(workspace, "paper.pdf"), "%PDF-1.4\n");
      return { stdout: "ok", stderr: "" };
    });

    const result = await compileLatex({
      workspacePath: workspace,
      sourcePath: "paper.tex",
      engine: "pdflatex",
      execFileImpl,
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
      execFileImpl: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("inside the workspace");
  });
});
