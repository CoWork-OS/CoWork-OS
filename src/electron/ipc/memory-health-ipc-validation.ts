import { z } from "zod";
import { WorkspaceIdSchema } from "../utils/validation";

/**
 * Schema for the Memory Hub "Sources" and "Health" IPC (memoryHub:sources,
 * memoryHub:health). Payloads come from the renderer, which is untrusted: each request
 * names the workspace the Hub is showing, and unknown fields are refused.
 */
export const MemoryHubWorkspaceRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema })
  .strict();
