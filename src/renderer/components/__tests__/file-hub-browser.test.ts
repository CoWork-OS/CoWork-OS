import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/types";
import { createBrowserFileHubAdapter, type BrowserFileHubApi } from "../file-hub-browser";

const workspace = (id: string, read = true): Workspace => ({
  id,
  name: `Workspace ${id}`,
  path: "/host/path/is/not/exposed",
  createdAt: 1,
  permissions: { read, write: false, delete: false, network: false, shell: false },
});

const adapterFor = (
  overrides: Partial<BrowserFileHubApi> = {},
  fetchImpl: typeof fetch = vi.fn(async () => new Response("payload")) as unknown as typeof fetch,
) => {
  const api: BrowserFileHubApi = {
    listWorkspaces: vi.fn(async () => [workspace("workspace-1")]),
    listTasks: vi.fn(async () => []),
    listBrowserWorkspaceFiles: vi.fn(async ({ workspaceId, relativePath }) => ({
      workspaceId,
      relativePath,
      entries: [],
      truncated: false,
    })),
    listBrowserTaskArtifacts: vi.fn(async ({ taskId, workspaceId, limit, offset }) => ({
      taskId,
      workspaceId,
      artifacts: [],
      limit,
      offset,
      nextOffset: offset,
      hasMore: false,
    })),
    createBrowserArtifactDownload: vi.fn(async ({ artifactId }) => ({
      handle: "one-use-handle",
      artifactId,
      fileName: "report.txt",
      mimeType: "text/plain",
      size: 7,
      expiresAt: Date.now() + 30_000,
    })),
    ...overrides,
  };
  const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
  const adapter = createBrowserFileHubAdapter(api, {
    fetch: fetchImpl,
    endpoint: (path) => new URL(`https://unit.test/api/web/v1/${path}`),
  });
  return { adapter, api, fetchMock };
};

describe("browser FileHub adapter", () => {
  it("lists only validated children under a readable selected workspace", async () => {
    const { adapter, api } = adapterFor({
      listBrowserWorkspaceFiles: vi.fn(
        async ({
          workspaceId,
          relativePath,
        }: {
          workspaceId: string;
          relativePath: string;
          limit: number;
        }) => ({
          workspaceId,
          relativePath,
          entries: [
            { name: "notes.txt", relativePath: "docs/notes.txt", type: "file" as const, size: 10 },
            { name: "outside", relativePath: "../outside", type: "file" as const, size: 1 },
            {
              name: "wrong-root",
              relativePath: "private/secret.txt",
              type: "file" as const,
              size: 1,
            },
            { name: "docs", relativePath: "docs", type: "directory" as const, size: 0 },
          ],
          truncated: false,
        }),
      ),
    });

    const listing = await adapter.listWorkspaceDirectory("workspace-1", "docs");
    expect(api.listBrowserWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      relativePath: "docs",
      limit: 100,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["docs/notes.txt"]);
    expect(listing.entries[0]).toMatchObject({ source: "local", mimeType: "text/plain" });
  });

  it("rejects forged workspace ids and unsafe download paths before issuing HTTP requests", async () => {
    const { adapter, api, fetchMock } = adapterFor();

    await expect(adapter.listWorkspaceDirectory("attacker-workspace")).rejects.toThrow(
      "not available",
    );
    await expect(adapter.downloadWorkspaceFile("workspace-1", "../secret.txt")).rejects.toThrow(
      "file path",
    );
    await expect(adapter.downloadWorkspaceFile("workspace-1", "/etc/passwd")).rejects.toThrow(
      "file path",
    );
    expect(api.listBrowserWorkspaceFiles).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses workspaces without read permission and temporary workspaces", async () => {
    const noRead = adapterFor({
      listWorkspaces: vi.fn(async () => [workspace("workspace-1", false)]),
    });
    await expect(noRead.adapter.listWorkspaceDirectory("workspace-1")).rejects.toThrow(
      "not available",
    );

    const temporary = adapterFor({
      listWorkspaces: vi.fn(async () => [workspace("__temp_workspace__:session")]),
    });
    await expect(
      temporary.adapter.listWorkspaceDirectory("__temp_workspace__:session"),
    ).rejects.toThrow("not available");
  });

  it("searches recursively within the requested workspace directory with bounded traversal", async () => {
    const listBrowserWorkspaceFiles = vi.fn(
      async ({ workspaceId, relativePath }: { workspaceId: string; relativePath: string }) => ({
        workspaceId,
        relativePath,
        entries:
          relativePath === "docs"
            ? [
                {
                  name: "nested",
                  relativePath: "docs/nested",
                  type: "directory" as const,
                  size: 0,
                },
                {
                  name: "guide.md",
                  relativePath: "docs/guide.md",
                  type: "file" as const,
                  size: 15,
                },
              ]
            : [
                {
                  name: "match.txt",
                  relativePath: "docs/nested/match.txt",
                  type: "file" as const,
                  size: 5,
                },
              ],
        truncated: false,
      }),
    );
    const { adapter } = adapterFor({ listBrowserWorkspaceFiles });

    const result = await adapter.searchWorkspaceFiles("workspace-1", "match", "docs");
    expect(listBrowserWorkspaceFiles).toHaveBeenCalledTimes(2);
    expect(listBrowserWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      relativePath: "docs/nested",
      limit: 100,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual(["docs/nested/match.txt"]);
  });

  it("lists artifacts only for tasks in the requested workspace", async () => {
    const listTasks = vi.fn(async () => [
      { id: "task-a", workspaceId: "workspace-1" },
      { id: "task-b", workspaceId: "workspace-2" },
    ]);
    const listBrowserTaskArtifacts = vi.fn(async ({ taskId, workspaceId, limit, offset }) => ({
      taskId,
      workspaceId,
      artifacts: [
        {
          artifactId: `artifact-${taskId}`,
          name: `${taskId}.txt`,
          mimeType: "text/plain",
          size: 4,
          createdAt: 5,
        },
      ],
      limit,
      offset,
      nextOffset: offset,
      hasMore: false,
    }));
    const { adapter } = adapterFor({ listTasks, listBrowserTaskArtifacts });

    const result = await adapter.listWorkspaceArtifacts("workspace-1");
    expect(listBrowserTaskArtifacts).toHaveBeenCalledTimes(1);
    expect(listBrowserTaskArtifacts).toHaveBeenCalledWith({
      taskId: "task-a",
      workspaceId: "workspace-1",
      limit: 100,
      offset: 0,
    });
    expect(result.entries.map((entry) => entry.metadata?.artifactId)).toEqual(["artifact-task-a"]);
  });

  it("downloads workspace files with a session CSRF token and exact workspace-relative path", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("session/bootstrap"))
        return new Response(JSON.stringify({ csrfToken: "csrf-value" }));
      return new Response("file-bytes", { headers: { "Content-Type": "text/plain" } });
    }) as unknown as typeof fetch;
    const { adapter } = adapterFor({}, fetchImpl);

    const blob = await adapter.downloadWorkspaceFile("workspace-1", "docs/notes.txt");
    expect(await blob.text()).toBe("file-bytes");
    const downloadCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(String(downloadCall?.[0])).toBe("https://unit.test/api/web/v1/workspace-files/download");
    expect(downloadCall?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CoWork-CSRF": "csrf-value" },
      body: JSON.stringify({ workspaceId: "workspace-1", relativePath: "docs/notes.txt" }),
    });
  });

  it("uses a scoped one-use artifact download handle and never accepts a mismatched artifact", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("session/bootstrap"))
        return new Response(JSON.stringify({ csrfToken: "csrf-value" }));
      return new Response("artifact-bytes", { headers: { "Content-Type": "text/plain" } });
    }) as unknown as typeof fetch;
    const { adapter, api } = adapterFor({}, fetchImpl);

    const downloaded = await adapter.downloadArtifact("artifact-a");
    expect(downloaded.fileName).toBe("report.txt");
    expect(await downloaded.blob.text()).toBe("artifact-bytes");
    expect(api.createBrowserArtifactDownload).toHaveBeenCalledWith({ artifactId: "artifact-a" });
    const downloadCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(downloadCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "X-CoWork-CSRF": "csrf-value" },
      body: JSON.stringify({ handle: "one-use-handle" }),
    });

    const mismatched = adapterFor({
      createBrowserArtifactDownload: vi.fn(async () => ({
        handle: "not-for-this-id",
        artifactId: "artifact-other",
        fileName: "other.txt",
        mimeType: "text/plain",
        size: 1,
        expiresAt: 1,
      })),
    });
    await expect(mismatched.adapter.downloadArtifact("artifact-a")).rejects.toThrow(
      "prepare this artifact",
    );
    expect(mismatched.fetchMock).not.toHaveBeenCalled();
  });
});
