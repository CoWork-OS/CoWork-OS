import * as fs from "fs/promises";
import * as path from "path";
import { inlineLocalHtmlPreviewAssets } from "./html-preview-assets";
import type { WebPagePreview } from "../../shared/web-page-preview";

const REACT_BUILD_DIRS = ["dist", "build", "out"];

export interface WebPreviewReadOptions {
  /** Resolves an authorized canonical path for every content read. */
  authorizeReadPath?: (filePath: string) => Promise<string>;
}

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

async function readPackageJson(
  packageJsonPath: string,
  options: WebPreviewReadOptions,
): Promise<PackageJsonShape | null> {
  const readablePath = options.authorizeReadPath
    ? await options.authorizeReadPath(packageJsonPath)
    : packageJsonPath;
  try {
    return JSON.parse(await fs.readFile(readablePath, "utf-8")) as PackageJsonShape;
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

async function findReactProjectRoot(
  startPath: string,
  workspaceRoot: string,
  options: WebPreviewReadOptions,
): Promise<{ path: string; packageJson: PackageJsonShape } | null> {
  let current = startPath;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  while (current.startsWith(normalizedWorkspaceRoot)) {
    const packageJsonPath = path.join(current, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = await readPackageJson(packageJsonPath, options);
      if (packageJson && detectFramework(packageJson)) return { path: current, packageJson };
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
  options: WebPreviewReadOptions;
}): Promise<WebPagePreview> {
  const htmlPath = args.options.authorizeReadPath
    ? await args.options.authorizeReadPath(args.htmlPath)
    : args.htmlPath;
  const rawHtmlContent = await fs.readFile(htmlPath, "utf-8");
  const htmlContent = await inlineLocalHtmlPreviewAssets({
    htmlContent: rawHtmlContent,
    htmlFilePath: htmlPath,
    workspaceRoot: args.workspaceRoot,
    authorizeReadPath: args.options.authorizeReadPath,
  });

  return {
    format: "html",
    previewMode: "sandboxed_iframe",
    title: path.basename(args.htmlPath),
    htmlContent,
    sourcePath: htmlPath,
    baseDir: path.dirname(htmlPath),
    projectRoot: args.projectRoot,
    framework: args.framework ?? "html",
    canPreview: true,
  };
}

export async function buildWebPagePreviewFromPath(
  sourcePath: string,
  workspaceRoot: string,
  options: WebPreviewReadOptions = {},
): Promise<WebPagePreview> {
  if (options.authorizeReadPath) {
    // Compare discovery and asset paths in the same canonical namespace, including
    // macOS /var aliases and workspaces reached through a symlink.
    [sourcePath, workspaceRoot] = await Promise.all([
      fs.realpath(sourcePath),
      fs.realpath(workspaceRoot),
    ]);
  }
  const stats = await fs.stat(sourcePath);
  const sourceDir = stats.isDirectory() ? sourcePath : path.dirname(sourcePath);
  const extension = stats.isDirectory() ? "" : path.extname(sourcePath).toLowerCase();

  if (!stats.isDirectory() && (extension === ".html" || extension === ".htm")) {
    const projectRoot = await findReactProjectRoot(
      path.dirname(sourcePath),
      workspaceRoot,
      options,
    );
    const framework = projectRoot ? detectFramework(projectRoot.packageJson) : "html";
    return buildPreviewFromHtmlFile({
      htmlPath: sourcePath,
      workspaceRoot,
      projectRoot: projectRoot?.path,
      framework,
      options,
    });
  }

  const projectRoot = stats.isDirectory()
    ? await findReactProjectRoot(sourcePath, workspaceRoot, options)
    : path.basename(sourcePath) === "package.json"
      ? await findReactProjectRoot(path.dirname(sourcePath), workspaceRoot, options)
      : await findReactProjectRoot(sourceDir, workspaceRoot, options);
  if (projectRoot) {
    const framework = detectFramework(projectRoot.packageJson);
    const builtEntry = await findBuiltHtmlEntry(projectRoot.path);
    if (builtEntry) {
      return buildPreviewFromHtmlFile({
        htmlPath: builtEntry,
        workspaceRoot,
        projectRoot: projectRoot.path,
        framework,
        options,
      });
    }

    return {
      format: "html",
      previewMode: "sandboxed_iframe",
      sourcePath,
      baseDir: projectRoot.path,
      projectRoot: projectRoot.path,
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
