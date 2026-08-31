import { describe, expect, it, vi } from "vitest";
import { YouTubeTools } from "../youtube-tools";

function createTools(): YouTubeTools {
  return new YouTubeTools(
    {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
      },
      createdAt: Date.now(),
    } as Any,
    {
      logEvent: vi.fn(),
    } as Any,
    "task-1",
  );
}

describe("YouTubeTools", () => {
  it("keeps youtube_ask_video read-only by rejecting URL ingestion", async () => {
    await expect(
      createTools().askVideo({
        question: "What is this about?",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      } as Any),
    ).rejects.toThrow("Use youtube_ask_or_ingest_video for URLs");
  });

  it("exposes separate cached and ingesting ask tools", () => {
    const names = YouTubeTools.getToolDefinitions().map((tool) => tool.name);

    expect(names).toContain("youtube_ask_video");
    expect(names).toContain("youtube_ask_or_ingest_video");
  });

  it("blocks ingestion when workspace network access is disabled", async () => {
    await expect(
      createTools().ingestVideo({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).rejects.toThrow(/Network access denied/i);
  });

  it("blocks local transcript subprocesses when domain rules are configured", async () => {
    const tools = new YouTubeTools(
      {
        id: "workspace-1",
        name: "Workspace",
        path: "/tmp/workspace",
        permissions: {
          read: true,
          write: true,
          network: true,
          shell: false,
          accessDomainRules: [{ pattern: "www.youtube.com", access: "allow" }],
        },
        createdAt: Date.now(),
      } as Any,
      { logEvent: vi.fn() } as Any,
      "task-1",
    );

    await expect(
      tools.ingestVideo({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).rejects.toThrow(/domain-scoped network rules/i);
  });

  it("blocks ingestion when the transcript cache is not writable", async () => {
    const tools = new YouTubeTools(
      {
        id: "workspace-1",
        name: "Workspace",
        path: "/tmp/workspace",
        permissions: {
          read: true,
          write: false,
          network: true,
          shell: false,
        },
        createdAt: Date.now(),
      } as Any,
      { logEvent: vi.fn() } as Any,
      "task-1",
    );

    await expect(
      tools.ingestVideo({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ).rejects.toThrow(/workspace_write_disabled|Write permission not granted/i);
  });
});
