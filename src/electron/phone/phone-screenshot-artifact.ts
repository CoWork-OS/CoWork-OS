import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentDaemon } from "../agent/daemon";
import { FileTools } from "../agent/tools/file-tools";
import type { AndroidPhoneObservation } from "../../shared/android-phone";
import type { AndroidPhoneService } from "./AndroidPhoneService";

/** Publish approved pixels as a normal task deliverable without exposing profile paths. */
export async function publishPhoneScreenshot(
  daemon: AgentDaemon,
  taskId: string,
  service: AndroidPhoneService,
  observation: AndroidPhoneObservation,
) {
  const task = daemon.getTask(taskId);
  const workspace = task?.workspaceId && daemon.getWorkspaceById?.(task.workspaceId);
  if (!workspace) return observation;
  if (!workspace.permissions.write)
    return {
      ...observation,
      artifactWarning:
        "Screenshot is attached, but this workspace does not permit saving a PNG deliverable.",
    };
  const files = new FileTools(workspace, daemon, taskId);
  const destination = await files.authorizeApplicationPath(
    path.join(workspace.path, `android-screen-${observation.captureId}.png`),
    "write",
  );
  const bytes = await fs.readFile(service.capturePath(observation.captureId));
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("Invalid Android screenshot artifact");
  // Unique capture IDs and exclusive/no-follow creation cannot overwrite user files.
  try {
    const handle = await fs.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await files.authorizeApplicationPath(destination, "read");
    const existing = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (
        !(await existing.stat()).isFile() ||
        (await existing.stat()).size !== bytes.length ||
        !(await existing.readFile()).equals(bytes)
      )
        throw new Error("Android screenshot destination already contains different bytes");
    } finally {
      await existing.close();
    }
  }
  const screenshot = {
    taskId,
    path: destination,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await daemon.registerArtifact(taskId, destination, "image/png");
  daemon.logEvent(taskId, "file_created", {
    path: destination,
    type: "image",
    mimeType: "image/png",
    size: bytes.length,
    source: "android-phone",
    captureId: observation.captureId,
  });
  return { ...observation, path: destination, screenshot };
}
