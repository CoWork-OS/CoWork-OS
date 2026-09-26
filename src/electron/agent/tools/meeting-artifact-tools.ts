import type { LLMTool } from "../llm/types";
import { MeetingArtifactsService } from "../../meetings/meeting-artifacts-service";

const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Read-only access to locally saved meeting artifacts (Teams transcripts and
 * Google Meet notes saved by CoWork). Nothing here reaches the provider APIs.
 */
export class MeetingArtifactTools {
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "meeting_artifacts_list",
        description:
          "List meeting transcripts CoWork has saved locally (Teams meetings the user organized, and Google Meet artifacts). Use before summarizing a meeting, extracting action items, or answering 'what was decided in…' questions; then read one with meeting_artifact_get.",
        input_schema: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["teams", "google-meet"],
              description: "Only list artifacts from this provider",
            },
            query: {
              type: "string",
              description: "Case-insensitive match on meeting title or organizer",
            },
            limit: { type: "number", description: "Maximum results, default 20, max 100" },
          },
        },
      },
      {
        name: "meeting_artifact_get",
        description:
          "Read one saved meeting transcript (Markdown with speakers and timestamps) by the id returned from meeting_artifacts_list. Long transcripts are returned in pages via offset.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Artifact id, e.g. teams:abc123..." },
            offset: {
              type: "number",
              description: "Character offset for long transcripts, default 0",
            },
          },
          required: ["id"],
        },
      },
    ];
  }

  list(input: { provider?: "teams" | "google-meet"; query?: string; limit?: number }) {
    const service = MeetingArtifactsService.getInstance();
    if (!service) return { artifacts: [], note: "Meeting capture is not initialized." };
    const limit = Math.max(1, Math.min(Math.floor(Number(input?.limit) || 20), 100));
    const query = typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
    const artifacts = service
      .listArtifacts({ provider: input?.provider })
      .filter(
        (artifact) =>
          !query ||
          artifact.title.toLowerCase().includes(query) ||
          (artifact.organizer || "").toLowerCase().includes(query),
      )
      .slice(0, limit)
      .map((artifact) => ({
        id: artifact.id,
        provider: artifact.provider,
        title: artifact.title,
        organizer: artifact.organizer,
        startTime: artifact.startTime,
        endTime: artifact.endTime,
        turns: artifact.cueCount,
        recordings: artifact.recordings.length,
      }));
    return {
      artifacts,
      note:
        artifacts.length === 0
          ? "No saved meeting transcripts. The user can connect Teams meeting transcripts in Settings > Integrations."
          : undefined,
    };
  }

  get(input: { id?: string; offset?: number }) {
    const service = MeetingArtifactsService.getInstance();
    if (!service) throw new Error("Meeting capture is not initialized.");
    if (typeof input?.id !== "string" || !input.id) throw new Error("id is required");
    const artifact = service.getArtifact(input.id);
    if (!artifact) throw new Error(`No saved meeting artifact with id ${input.id}`);
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const content = artifact.markdown.slice(offset, offset + MAX_TRANSCRIPT_CHARS);
    const nextOffset = offset + content.length;
    return {
      id: artifact.summary.id,
      title: artifact.summary.title,
      startTime: artifact.summary.startTime,
      content,
      truncated: nextOffset < artifact.markdown.length,
      nextOffset: nextOffset < artifact.markdown.length ? nextOffset : undefined,
    };
  }
}
