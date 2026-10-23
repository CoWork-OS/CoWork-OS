import { parentPort, workerData } from "node:worker_threads";
import type { DiscoveryRequest } from "./file-discovery-client";
import { runWithDiscoveryContext } from "./file-discovery-context";
import { discoverGlob } from "./glob-discovery";
import { GrepDiscovery } from "./grep-discovery";

async function discover(request: DiscoveryRequest) {
  return runWithDiscoveryContext(request.context, async () => {
    if (request.kind === "glob") return discoverGlob(request.workspace, request.input).results;
    // Globs also run off-host; the parent's deadline can terminate pathological matching.
    const evaluator = {
      async evaluate(pattern: string, flags: string, texts: string[]) {
        const regex = new RegExp(pattern, flags);
        return texts.flatMap((text, index) => {
          regex.lastIndex = 0;
          return regex.test(text) ? [index] : [];
        });
      },
    };
    return new GrepDiscovery(request.workspace).findFilesToSearch(
      request.input.basePath,
      request.input.globPattern,
      request.input.agentRoleId,
      new Map(),
      evaluator,
    );
  });
}
const port = parentPort;
if (port) {
  void discover(workerData as DiscoveryRequest).then(
    (result) => port.postMessage({ result }),
    (error: unknown) =>
      port.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
}
