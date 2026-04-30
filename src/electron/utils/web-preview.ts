import * as fs from "fs/promises";
import * as path from "path";
import { inlineLocalHtmlPreviewAssets } from "./html-preview-assets";
import type { WebPagePreview } from "../../shared/web-page-preview";

const REACT_BUILD_DIRS = ["dist", "build", "out"];

type PackageJsonShape = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJsonShape | null> {
  try {
    return JSON.parse(await fs.readFile(packageJsonPath, "utf-8")) as PackageJsonShape;
  } catch {
    return null;
  }
}

function detectFramework(packageJson: PackageJsonShape | null): WebPagePreview["framework"] {
  if (!packageJson) return undefined;
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  if ("next" in deps) return "next";
  if ("vite" in deps) return "vite";
  if ("react" in deps || "react-dom" in deps) return "react";
  return undefined;
}

async function findReactProjectRoot(startPath: string, workspaceRoot: string): Promise<string | null> {
  let current = startPath;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  while (current.startsWith(normalizedWorkspaceRoot)) {
    const packageJsonPath = path.join(current, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      if (detectFramework(packageJson)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function findBuiltHtmlEntry(projectRoot: string): Promise<string | null> {
  for (const dirName of REACT_BUILD_DIRS) {
    const candidate = path.join(projectRoot, dirName, "index.html");
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function buildPreviewFromHtmlFile(args: {
  htmlPath: string;
  workspaceRoot: string;
  projectRoot?: string;
  framework?: WebPagePreview["framework"];
}): Promise<WebPagePreview> {
  const rawHtmlContent = await fs.readFile(args.htmlPath, "utf-8");
  const htmlContent = await inlineLocalHtmlPreviewAssets({
    htmlContent: rawHtmlContent,
    htmlFilePath: args.htmlPath,
    workspaceRoot: args.workspaceRoot,
  });

  return {
    format: "html",
    previewMode: "sandboxed_iframe",
    title: path.basename(args.htmlPath),
    htmlContent,
    sourcePath: args.htmlPath,
    baseDir: path.dirname(args.htmlPath),
    projectRoot: args.projectRoot,
    framework: args.framework ?? "html",
    canPreview: true,
  };
}

export async function buildWebPagePreviewFromPath(
  sourcePath: string,
  workspaceRoot: string,
): Promise<WebPagePreview> {
  const stats = await fs.stat(sourcePath);
  const sourceDir = stats.isDirectory() ? sourcePath : path.dirname(sourcePath);
  const extension = stats.isDirectory() ? "" : path.extname(sourcePath).toLowerCase();

  if (!stats.isDirectory() && (extension === ".html" || extension === ".htm")) {
    const projectRoot = await findReactProjectRoot(path.dirname(sourcePath), workspaceRoot);
    const framework = projectRoot
      ? detectFramework(await readPackageJson(path.join(projectRoot, "package.json")))
      : "html";
    return buildPreviewFromHtmlFile({
      htmlPath: sourcePath,
      workspaceRoot,
      projectRoot: projectRoot ?? undefined,
      framework,
    });
  }

  const projectRoot =
    stats.isDirectory() ? await findReactProjectRoot(sourcePath, workspaceRoot) :
    path.basename(sourcePath) === "package.json" ? await findReactProjectRoot(path.dirname(sourcePath), workspaceRoot) :
    await findReactProjectRoot(sourceDir, workspaceRoot);
  if (projectRoot) {
    const packageJson = await readPackageJson(path.join(projectRoot, "package.json"));
    const framework = detectFramework(packageJson);
    const builtEntry = await findBuiltHtmlEntry(projectRoot);
    if (builtEntry) {
      return buildPreviewFromHtmlFile({
        htmlPath: builtEntry,
        workspaceRoot,
        projectRoot,
        framework,
      });
    }

    return {
      format: "html",
      previewMode: "sandboxed_iframe",
      sourcePath,
      baseDir: projectRoot,
      projectRoot,
      framework,
      canPreview: false,
      previewMessage:
        "This looks like a React project, but no built index.html was found in dist, build, or out.",
    };
  }

  return {
    format: "html",
    previewMode: "sandboxed_iframe",
    sourcePath,
    baseDir: sourceDir,
    canPreview: false,
    previewMessage: "No previewable web page was found for this path.",
  };
}
