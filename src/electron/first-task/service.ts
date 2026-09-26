import { app } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RELEASE_BRIEF_ID, releaseBriefInputHashes } from "./verify-release-brief";
import { ensureTempWorkspaceRootSync } from "../utils/temp-workspace";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function fixtureDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "starter-missions", RELEASE_BRIEF_ID)
    : path.join(app.getAppPath(), "resources", "starter-missions", RELEASE_BRIEF_ID);
}

export async function verifyReleaseBriefInputs(): Promise<Array<{ name: string; content: Buffer }>> {
  const fixture = fixtureDirectory();
  return Promise.all(
    Object.entries(releaseBriefInputHashes()).map(async ([name, expectedHash]) => {
      const filePath = path.join(fixture, name);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
        throw new Error(`Invalid packaged sample input: ${name}`);
      }
      const content = await fs.readFile(filePath);
      if (sha256(content) !== expectedHash)
        throw new Error(`Packaged sample input failed integrity check: ${name}`);
      return { name, content };
    }),
  );
}

/** Check the same sample inputs and temp root used at launch without creating a task. */
export async function checkReleaseBriefRuntime(tempWorkspaceRoot: string): Promise<void> {
  await verifyReleaseBriefInputs();
  const safeRoot = ensureTempWorkspaceRootSync(tempWorkspaceRoot);
  const probe = await fs.mkdtemp(path.join(safeRoot, "first-task-readiness-"));
  try {
    const file = path.join(probe, "readiness.txt");
    await fs.writeFile(file, "ready", { flag: "wx", mode: 0o600 });
    if (await fs.readFile(file, "utf8") !== "ready") throw new Error("Sample workspace read failed");
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

/** Seed only an application-created empty temporary workspace. */
export async function seedReleaseBriefWorkspace(workspacePath: string): Promise<void> {
  const rootStat = await fs.lstat(workspacePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe sample workspace");
  const entries = await fs.readdir(workspacePath);
  if (entries.length !== 0) throw new Error("Sample workspace is not empty");

  const data = await verifyReleaseBriefInputs();
  for (const { name, content } of data) {
    await fs.writeFile(path.join(workspacePath, name), content, { flag: "wx", mode: 0o600 });
  }
  await fs.mkdir(path.join(workspacePath, "outputs"), { mode: 0o700 });
}

export const RELEASE_BRIEF_PROMPT = `<no-memory />\nUse only the files in this sample workspace. Read brief-instructions.md, release-notes.md, and issues.csv. Create the three requested files in outputs/ using workspace file tools. Do not use shell, browser, network, integrations, external agents, or files outside this workspace. Report the output paths and any limitations. A separate application checker will validate the result.`;
