import { parentPort, workerData } from "node:worker_threads";
import { WorkspaceArtifactEvidenceInspector } from "../sessions/WorkspaceArtifactEvidenceInspector";
import type { Workspace } from "../../shared/types";
import type { BotWorkResultManifest, BotWorkResult } from "../../shared/bot-work-result";
export interface BotArtifactCheckInput {
  workspace: Workspace;
  artifacts: BotWorkResultManifest["artifacts"];
}
export function checkBotArtifacts(input: BotArtifactCheckInput): BotWorkResult["outputs"] {
  const inspector = new WorkspaceArtifactEvidenceInspector({ maxBytes: 4 * 1024 * 1024 });
  return input.artifacts.map((a) => {
    const output = {
      id: a.id,
      artifactId: a.artifactId,
      path: a.path,
      revision: a.revision,
      sha256: a.sha256,
      status: a.status,
    };
    if (a.status !== "committed") return { ...output, check: "not_current" as const };
    if (!input.workspace.permissions.read)
      return { ...output, check: "unavailable" as const, reason: "access_denied" };
    const inspected = inspector.inspect(input.workspace, a.path);
    if (inspected.status === "present")
      return {
        ...output,
        check: (inspected.sha256 === a.sha256 && inspected.size === a.size
          ? "matches"
          : "changed") as "matches" | "changed",
      };
    if (inspected.status === "missing") return { ...output, check: "missing" as const };
    return { ...output, check: "unavailable" as const, reason: inspected.reason };
  });
}
if (parentPort && workerData?.kind === "botWorkArtifactCheck")
  parentPort.postMessage(checkBotArtifacts(workerData.input as BotArtifactCheckInput));
