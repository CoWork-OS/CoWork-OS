import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComposerDraftAttachmentPutRequest,
  ComposerDraftAttachmentReleaseRequest,
  ComposerDraftAttachmentResolveRequest,
} from "../../shared/composer-drafts";
import type { Workspace } from "../../shared/types";
import { createBrowserFileBridge } from "./browser-file-bridge";

const writableWorkspace: Workspace = {
  id: "workspace-1",
  name: "Project",
  path: "/work/project",
  createdAt: 1,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
};

const owner: Omit<ComposerDraftAttachmentPutRequest, "name"> = {
  draftKey: "local:workspace-1:main:new",
  scope: "local",
  workspaceId: writableWorkspace.id,
  surface: "main",
  taskId: null,
};

type FileBridgeMethods = {
  selectFiles: (
    defaultPath?: string,
  ) => Promise<Array<{ path: string; name: string; size: number }>>;
  importFilesToWorkspace: (request: {
    workspaceId: string;
    files: string[];
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  importDataToWorkspace: (request: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  putComposerDraftAttachment: (request: ComposerDraftAttachmentPutRequest) => Promise<{
    refId: string;
    name: string;
    size: number;
    sha256: string;
    status?: "available" | "unavailable";
  }>;
  resolveComposerDraftAttachment: (
    request: ComposerDraftAttachmentResolveRequest,
  ) => Promise<{ ref: { refId: string }; path: string } | null>;
  releaseComposerDraftAttachment: (
    request: ComposerDraftAttachmentReleaseRequest,
  ) => Promise<{ released: boolean }>;
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: { includeImageContent?: boolean },
  ) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
};

class FakeFileInput {
  type = "";
  multiple = false;
  hidden = false;
  files: FileList | null = null;
  removed = false;
  href = "";
  download = "";
  rel = "";
  clickCount = 0;
  private readonly handlers = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.handlers.set(type, callback);
  }

  remove(): void {
    this.removed = true;
  }

  click(): void {
    this.clickCount += 1;
  }

  fire(type: string): void {
    this.handlers.get(type)?.(new Event(type));
  }
}

let fakeInput: FakeFileInput;
let fetchMock: ReturnType<typeof vi.fn>;
let active: boolean;
let listWorkspaces: () => Promise<Workspace[]>;

function installDocument(): void {
  fakeInput = new FakeFileInput();
  const fakeDocument = {
    baseURI: "https://cowork.example/app/",
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => fakeInput),
  };
  vi.stubGlobal("document", fakeDocument);
}

function createBridge(
  workspaces: Workspace[] = [writableWorkspace],
  createMediaHandle = vi.fn(async () => ({
    handle: "a".repeat(43),
    mimeType: "video/mp4",
    size: 64,
  })),
) {
  active = true;
  listWorkspaces = vi.fn(async () => workspaces);
  const bridge = createBrowserFileBridge({
    session: { csrfToken: "csrf-secret" } as never,
    listWorkspaces,
    createMediaHandle,
    isActive: () => active,
  });
  return { ...bridge, api: bridge.methods as unknown as FileBridgeMethods, createMediaHandle };
}

function setPickedFiles(files: File[]): void {
  fakeInput.files = files as unknown as FileList;
  fakeInput.fire("change");
}

function makeSizedFile(name: string, size: number): File {
  const file = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function validUploadResponse(): Response {
  return new Response(null, { status: 201 });
}

beforeEach(() => {
  installDocument();
  fetchMock = vi.fn(async () => validUploadResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser file bridge", () => {
  it("maps chooser selections to opaque paths and imports the same bytes after draft release", async () => {
    const { api } = createBridge();
    const file = new File(["selected bytes"], "notes.txt", { type: "text/plain" });
    const pending = api.selectFiles("/host/path/is-ignored");
    setPickedFiles([file]);
    const [selection] = await pending;

    expect(selection.path).toMatch(/^browser-file:/);
    expect(selection.path).not.toContain("/host/");

    const ref = await api.putComposerDraftAttachment({
      ...owner,
      name: selection.name,
      size: selection.size,
      sourcePath: selection.path,
    });
    await expect(
      api.resolveComposerDraftAttachment({ ...owner, refId: ref.refId }),
    ).resolves.toMatchObject({
      ref: { refId: ref.refId, name: "notes.txt", size: file.size },
      path: selection.path,
    });

    await expect(
      api.resolveComposerDraftAttachment({ ...owner, draftKey: "another-draft", refId: ref.refId }),
    ).resolves.toBeNull();
    await expect(
      api.releaseComposerDraftAttachment({ ...owner, draftKey: "another-draft", refId: ref.refId }),
    ).resolves.toEqual({ released: false });
    await expect(
      api.releaseComposerDraftAttachment({ ...owner, refId: ref.refId }),
    ).resolves.toEqual({ released: true });

    await expect(
      api.importFilesToWorkspace({ workspaceId: writableWorkspace.id, files: [selection.path] }),
    ).resolves.toMatchObject([{ fileName: "notes.txt", size: file.size }]);
    const uploadCall = fetchMock.mock.calls[0];
    const init = uploadCall?.[1] as RequestInit;
    expect(uploadCall?.[0]).toBeInstanceOf(URL);
    expect((init.body as File).arrayBuffer).toBeDefined();
    expect((init.body as File).name).toBe("notes.txt");
    expect(new Headers(init.headers).get("X-CoWork-CSRF")).toBe("csrf-secret");
    expect(new Headers(init.headers).get("X-CoWork-Workspace-Id")).toBe(writableWorkspace.id);
    expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
    expect(
      decodeURIComponent(new Headers(init.headers).get("X-CoWork-Relative-Path") || ""),
    ).toMatch(/^attachment-[a-f0-9]{20}-notes\.txt$/);
    expect(fakeInput.removed).toBe(true);
  });

  it("rekeys staged refs within the same workspace and aliases in-flight puts to the new task", async () => {
    const bridge = createBridge();
    const file = new File(["selected bytes"], "notes.txt", { type: "text/plain" });
    const pending = bridge.api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await pending;
    const nextOwner = {
      ...owner,
      draftKey: "local:workspace-1:main:task-1",
      taskId: "task-1",
    };

    expect(bridge.rekeyAttachments(owner, nextOwner)).toMatchObject({ rekeyedAttachmentCount: 0 });
    const ref = await bridge.api.putComposerDraftAttachment({
      ...owner,
      name: selection.name,
      size: selection.size,
      sourcePath: selection.path,
    });
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...nextOwner, refId: ref.refId }),
    ).resolves.toMatchObject({ ref: { refId: ref.refId }, path: selection.path });
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...owner, refId: ref.refId }),
    ).resolves.toBeNull();

    expect(
      bridge.rekeyAttachments(nextOwner, {
        ...nextOwner,
        taskId: "task-2",
        draftKey: "local:workspace-1:main:task-2",
      }),
    ).toMatchObject({
      rekeyedAttachmentCount: 1,
    });
    const finalOwner = {
      ...nextOwner,
      taskId: "task-2",
      draftKey: "local:workspace-1:main:task-2",
    };
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...finalOwner, refId: ref.refId }),
    ).resolves.toMatchObject({ ref: { refId: ref.refId }, path: selection.path });
    expect(() =>
      bridge.rekeyAttachments(finalOwner, { ...finalOwner, workspaceId: "workspace-2" }),
    ).toThrow("cannot move between workspaces");
  });

  it("stores a put that finishes after its source draft owner was rekeyed under the target owner", async () => {
    const bridge = createBridge();
    const file = new File(["selected bytes"], "notes.txt", { type: "text/plain" });
    const pending = bridge.api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await pending;
    const targetOwner = {
      ...owner,
      draftKey: "local:workspace-1:main:task-1",
      taskId: "task-1",
    };
    const readStarted = Promise.withResolvers<void>();
    const readDone = Promise.withResolvers<ArrayBuffer>();
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: () => {
        readStarted.resolve();
        return readDone.promise;
      },
    });

    const putting = bridge.api.putComposerDraftAttachment({
      ...owner,
      name: selection.name,
      size: selection.size,
      sourcePath: selection.path,
    });
    await readStarted.promise;
    expect(bridge.rekeyAttachments(owner, targetOwner)).toMatchObject({
      rekeyedAttachmentCount: 0,
    });
    readDone.resolve(await originalArrayBuffer());
    const ref = await putting;

    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...targetOwner, refId: ref.refId }),
    ).resolves.toMatchObject({ ref: { refId: ref.refId }, path: selection.path });
  });

  it("rolls back only the refs moved by a draft rekey and removes its owner alias", async () => {
    const bridge = createBridge();
    const first = new File(["source bytes"], "source.txt", { type: "text/plain" });
    const second = new File(["destination bytes"], "destination.txt", { type: "text/plain" });
    const firstSelectionPromise = bridge.api.selectFiles();
    setPickedFiles([first]);
    const [firstSelection] = await firstSelectionPromise;
    const sourceRef = await bridge.api.putComposerDraftAttachment({
      ...owner,
      name: firstSelection.name,
      size: firstSelection.size,
      sourcePath: firstSelection.path,
    });

    const targetOwner = {
      ...owner,
      draftKey: "local:workspace-1:main:task-1",
      taskId: "task-1",
    };
    const secondSelectionPromise = bridge.api.selectFiles();
    setPickedFiles([second]);
    const [secondSelection] = await secondSelectionPromise;
    const targetRef = await bridge.api.putComposerDraftAttachment({
      ...targetOwner,
      name: secondSelection.name,
      size: secondSelection.size,
      sourcePath: secondSelection.path,
    });

    const move = bridge.rekeyAttachments(owner, targetOwner);
    expect(move.rekeyedAttachmentCount).toBe(1);
    move.rollback();
    move.rollback();

    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...owner, refId: sourceRef.refId }),
    ).resolves.toMatchObject({ ref: { refId: sourceRef.refId }, path: firstSelection.path });
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...targetOwner, refId: sourceRef.refId }),
    ).resolves.toBeNull();
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...targetOwner, refId: targetRef.refId }),
    ).resolves.toMatchObject({ ref: { refId: targetRef.refId }, path: secondSelection.path });
  });

  it("routes an in-flight attachment put to its original owner after rollback", async () => {
    const bridge = createBridge();
    const file = new File(["selected bytes"], "notes.txt", { type: "text/plain" });
    const selectionPromise = bridge.api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await selectionPromise;
    const readStarted = Promise.withResolvers<void>();
    const readDone = Promise.withResolvers<ArrayBuffer>();
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: () => {
        readStarted.resolve();
        return readDone.promise;
      },
    });

    const putting = bridge.api.putComposerDraftAttachment({
      ...owner,
      name: selection.name,
      size: selection.size,
      sourcePath: selection.path,
    });
    await readStarted.promise;
    const targetOwner = {
      ...owner,
      draftKey: "local:workspace-1:main:task-1",
      taskId: "task-1",
    };
    const move = bridge.rekeyAttachments(owner, targetOwner);
    move.rollback();
    readDone.resolve(await originalArrayBuffer());
    const ref = await putting;

    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...owner, refId: ref.refId }),
    ).resolves.toMatchObject({ ref: { refId: ref.refId }, path: selection.path });
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...targetOwner, refId: ref.refId }),
    ).resolves.toBeNull();
  });

  it("releases refs for only the exact owner while retaining selected bytes through an import race", async () => {
    const bridge = createBridge();
    const file = new File(["selected bytes"], "notes.txt", { type: "text/plain" });
    const pending = bridge.api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await pending;
    const ref = await bridge.api.putComposerDraftAttachment({
      ...owner,
      name: selection.name,
      size: selection.size,
      sourcePath: selection.path,
    });

    expect(bridge.releaseAttachments({ ...owner, taskId: "another-task" })).toEqual({
      releasedAttachmentCount: 0,
    });
    expect(bridge.releaseAttachments(owner, [ref.refId])).toEqual({ releasedAttachmentCount: 1 });
    await expect(
      bridge.api.resolveComposerDraftAttachment({ ...owner, refId: ref.refId }),
    ).resolves.toBeNull();
    await expect(
      bridge.api.importFilesToWorkspace({
        workspaceId: writableWorkspace.id,
        files: [selection.path],
      }),
    ).resolves.toMatchObject([{ fileName: "notes.txt" }]);
  });

  it("reconciles a lost upload reply only after an exact-byte scoped download", async () => {
    const { api } = createBridge();
    const file = new File(["committed before disconnect"], "draft.txt", { type: "text/plain" });
    const pending = api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await pending;
    fetchMock
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockResolvedValueOnce(
        new Response("committed before disconnect", {
          status: 200,
          headers: { "Content-Type": "text/plain", "Content-Length": String(file.size) },
        }),
      );

    await expect(
      api.importFilesToWorkspace({ workspaceId: writableWorkspace.id, files: [selection.path] }),
    ).resolves.toMatchObject([{ fileName: "draft.txt", size: file.size }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [downloadUrl, downloadInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(downloadUrl.pathname).toContain("workspace-files/download");
    expect(new Headers(downloadInit.headers).get("X-CoWork-CSRF")).toBe("csrf-secret");
    expect(JSON.parse(String(downloadInit.body))).toMatchObject({
      workspaceId: writableWorkspace.id,
      relativePath: expect.stringMatching(/^attachment-[a-f0-9]{20}-draft\.txt$/),
    });
  });

  it("rejects a conflict when downloaded bytes do not match the selected file", async () => {
    const { api } = createBridge();
    const file = new File(["selected"], "same-name.txt", { type: "text/plain" });
    const pending = api.selectFiles();
    setPickedFiles([file]);
    const [selection] = await pending;
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response("different", { status: 200 }));

    await expect(
      api.importFilesToWorkspace({ workspaceId: writableWorkspace.id, files: [selection.path] }),
    ).rejects.toThrow("The host did not confirm this attachment");
  });

  it("rejects arbitrary paths and workspaces before making a request", async () => {
    const { api } = createBridge();
    const pending = api.selectFiles();
    setPickedFiles([new File(["safe"], "safe.txt")]);
    const [selection] = await pending;

    await expect(
      api.importFilesToWorkspace({ workspaceId: "unlisted-workspace", files: [selection.path] }),
    ).rejects.toThrow("Choose a workspace where you can add files");
    await expect(
      api.importFilesToWorkspace({ workspaceId: writableWorkspace.id, files: ["/etc/passwd"] }),
    ).rejects.toThrow("Choose this file again");
    await expect(
      api.readFileForViewer("/etc/passwd", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: false,
    });
    await expect(api.readFileForViewer("secret.txt", "/etc")).resolves.toMatchObject({
      success: false,
    });
    await expect(
      api.readFileForViewer("/work/project-evil/secret.txt", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: false,
      error: "This file path is unavailable in the browser.",
    });
    await expect(
      api.openFile("/work/project-evil/secret.txt", writableWorkspace.path),
    ).resolves.toBe("This file path is unavailable in the browser.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an absolute viewer path only below the exact authorized workspace root", async () => {
    const { api } = createBridge();
    fetchMock.mockResolvedValueOnce(
      new Response("hello", {
        status: 200,
        headers: { "Content-Type": "text/plain", "Content-Length": "5" },
      }),
    );

    await expect(
      api.readFileForViewer("/work/project/docs/readme.txt", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: true,
      data: { path: "docs/readme.txt", content: "hello" },
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain("workspace-files/download");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: writableWorkspace.id,
      relativePath: "docs/readme.txt",
    });
  });

  it("translates Windows absolute paths by separator-aware workspace components", async () => {
    const windowsWorkspace = { ...writableWorkspace, path: "C:\\Users\\Mesut\\project" };
    const { api } = createBridge([windowsWorkspace]);
    fetchMock.mockResolvedValueOnce(
      new Response("windows bytes", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(
      api.readFileForViewer("c:\\users\\mesut\\PROJECT\\docs\\readme.txt", windowsWorkspace.path),
    ).resolves.toMatchObject({ success: true, data: { path: "docs/readme.txt" } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain("workspace-files/download");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: writableWorkspace.id,
      relativePath: "docs/readme.txt",
    });
  });

  it("downloads openFile content as an inert Blob instead of navigating active HTML or SVG", async () => {
    const { api } = createBridge();
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchorClick = vi.spyOn(fakeInput, "click");
    fetchMock.mockResolvedValueOnce(
      new Response("<svg onload=alert(1) />", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
    );

    await expect(
      api.openFile("/work/project/docs/active.svg", writableWorkspace.path),
    ).resolves.toBe("");
    expect(fakeInput.href).toBe("blob:download");
    expect(fakeInput.download).toBe("active.svg");
    expect(fakeInput.rel).toBe("noopener");
    expect(fakeInput.clickCount).toBe(1);
    const appendChild = vi.mocked(document.body.appendChild);
    expect(appendChild).toHaveBeenCalledWith(fakeInput);
    expect(appendChild.mock.invocationCallOrder[0]).toBeLessThan(
      anchorClick.mock.invocationCallOrder[0] || Number.POSITIVE_INFINITY,
    );
    expect(fakeInput.removed).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "application/octet-stream" }),
    );
    const downloadBlob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(downloadBlob.type).toBe("application/octet-stream");
    await expect(downloadBlob.text()).resolves.toBe("<svg onload=alert(1) />");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toContain("workspace-files/download");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: writableWorkspace.id,
      relativePath: "docs/active.svg",
    });
  });

  it("returns safe relative text and raster image previews and rejects active SVG", async () => {
    const { api } = createBridge();
    fetchMock
      .mockResolvedValueOnce(
        new Response("hello", {
          status: 200,
          headers: { "Content-Type": "text/plain", "Content-Length": "5" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": "4" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<svg onload=alert(1) />", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
      );

    await expect(
      api.readFileForViewer("docs/readme.txt", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: true,
      data: { path: "docs/readme.txt", fileType: "text", content: "hello", size: 5 },
    });
    await expect(
      api.readFileForViewer("images/logo.png", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: true,
      data: {
        path: "images/logo.png",
        fileType: "image",
        content: "data:image/png;base64,iVBORw==",
      },
    });
    await expect(
      api.readFileForViewer("images/active.svg", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: true,
      data: { fileType: "unsupported", content: null },
    });
  });

  it("returns an authenticated range-stream URL for supported video previews", async () => {
    const createMediaHandle = vi.fn(async () => ({
      handle: "b".repeat(43),
      mimeType: "video/mp4",
      size: 2_000_000_000,
    }));
    const { api } = createBridge([writableWorkspace], createMediaHandle);

    await expect(
      api.readFileForViewer("/work/project/media/demo.mp4", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: true,
      data: {
        path: "media/demo.mp4",
        fileName: "demo.mp4",
        fileType: "video",
        content: null,
        mimeType: "video/mp4",
        size: 2_000_000_000,
        playbackUrl: "https://cowork.example/api/web/v1/workspace-files/media/" + "b".repeat(43),
      },
    });
    expect(createMediaHandle).toHaveBeenCalledWith(writableWorkspace.id, "media/demo.mp4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed video handles without exposing them to the browser", async () => {
    const { api } = createBridge(
      [writableWorkspace],
      vi.fn(async () => ({
        handle: "../private.mp4",
        mimeType: "video/mp4",
        size: 64,
      })),
    );

    await expect(
      api.readFileForViewer("media/demo.mp4", writableWorkspace.path),
    ).resolves.toMatchObject({
      success: false,
      error: "Video preview is unavailable for this file.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces picker count and aggregate byte limits before retaining selections", async () => {
    const { api } = createBridge();
    const pending = api.selectFiles();
    setPickedFiles(
      Array.from({ length: 5 }, (_, index) => makeSizedFile(`file-${index}.txt`, 25 * 1024 * 1024)),
    );
    await expect(pending).rejects.toThrow("100 MiB total");
    expect(fakeInput.removed).toBe(true);

    const next = api.selectFiles();
    setPickedFiles(Array.from({ length: 33 }, (_, index) => makeSizedFile(`file-${index}.txt`, 0)));
    await expect(next).rejects.toThrow("32 files");
  });

  it("limits staged draft bytes and rejects malformed base64 before upload", async () => {
    const { api } = createBridge();
    const pending = api.selectFiles();
    const file = makeSizedFile("large.txt", 25 * 1024 * 1024);
    setPickedFiles([file]);
    const [selection] = await pending;

    for (let index = 0; index < 4; index += 1) {
      await api.putComposerDraftAttachment({
        ...owner,
        name: selection.name,
        size: selection.size,
        sourcePath: selection.path,
      });
    }
    await expect(
      api.putComposerDraftAttachment({
        ...owner,
        name: selection.name,
        size: selection.size,
        sourcePath: selection.path,
      }),
    ).rejects.toThrow("100 MiB total");
    await expect(
      api.importDataToWorkspace({
        workspaceId: writableWorkspace.id,
        files: [{ name: "bad.txt", data: "%%%" }],
      }),
    ).rejects.toThrow("file data is invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears ephemeral files and rejects every file method after disposal", async () => {
    const bridge = createBridge();
    const pending = bridge.api.selectFiles();
    bridge.dispose();
    await expect(pending).rejects.toThrow("session has ended");
    const methods = bridge.api;

    await expect(methods.selectFiles()).rejects.toThrow("session has ended");
    await expect(
      methods.importFilesToWorkspace({ workspaceId: writableWorkspace.id, files: [] }),
    ).rejects.toThrow("session has ended");
    await expect(
      methods.importDataToWorkspace({ workspaceId: writableWorkspace.id, files: [] }),
    ).rejects.toThrow("session has ended");
    await expect(
      methods.putComposerDraftAttachment({ ...owner, name: "file.txt" }),
    ).rejects.toThrow("session has ended");
    await expect(
      methods.resolveComposerDraftAttachment({ ...owner, refId: "forged" }),
    ).rejects.toThrow("session has ended");
    await expect(
      methods.releaseComposerDraftAttachment({ ...owner, refId: "forged" }),
    ).rejects.toThrow("session has ended");
    await expect(methods.readFileForViewer("readme.txt", writableWorkspace.path)).rejects.toThrow(
      "session has ended",
    );
    await expect(methods.openFile("readme.txt", writableWorkspace.path)).rejects.toThrow(
      "session has ended",
    );
    expect(() => bridge.rekeyAttachments(owner, owner)).toThrow("session has ended");
    expect(() => bridge.releaseAttachments(owner)).toThrow("session has ended");
    expect(fakeInput.removed).toBe(true);
  });

  it("checks the session again after an in-flight upload returns", async () => {
    const bridge = createBridge();
    const pending = bridge.api.selectFiles();
    setPickedFiles([new File(["late"], "late.txt")]);
    const [selection] = await pending;
    let finishUpload!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (finishUpload = resolve)),
    );
    const importPromise = bridge.api.importFilesToWorkspace({
      workspaceId: writableWorkspace.id,
      files: [selection.path],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    bridge.dispose();
    finishUpload(validUploadResponse());
    await expect(importPromise).rejects.toThrow("session has ended");
  });
});
