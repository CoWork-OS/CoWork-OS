import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  getGoogleWorkspaceAccessToken: vi.fn(),
  refreshGoogleWorkspaceAccessToken: vi.fn(),
}));

vi.mock("../google-workspace-auth", () => fixture);

import { googleDriveRequest, googleDriveUpload } from "../google-workspace-api";
import { dropboxContentUpload, dropboxRequest } from "../dropbox-api";
import { sharepointRequest } from "../sharepoint-api";
import { onedriveRequest } from "../onedrive-api";
import { boxRequest } from "../box-api";

const operations = [
  {
    name: "Google Drive metadata",
    send: (beforeSend: () => void | Promise<void>) =>
      googleDriveRequest(
        { enabled: true, accessToken: "google-token" },
        { method: "POST", path: "/files", body: { name: "reviewed.txt" }, beforeSend },
      ),
  },
  {
    name: "Google Drive content",
    send: (beforeSend: () => void | Promise<void>) =>
      googleDriveUpload(
        { enabled: true, accessToken: "google-token" },
        "file-1",
        Buffer.from("reviewed bytes"),
        "text/plain",
        undefined,
        beforeSend,
      ),
  },
  {
    name: "Box folder mutation",
    send: (beforeSend: () => void | Promise<void>) =>
      boxRequest(
        { enabled: true, accessToken: "box-token" },
        { method: "POST", path: "/folders", body: { name: "reviewed" }, beforeSend },
      ),
  },
  {
    name: "Dropbox item mutation",
    send: (beforeSend: () => void | Promise<void>) =>
      dropboxRequest(
        { enabled: true, accessToken: "dropbox-token" },
        { method: "POST", path: "/files/delete_v2", body: { path: "/reviewed.txt" }, beforeSend },
      ),
  },
  {
    name: "Dropbox content",
    send: (beforeSend: () => void | Promise<void>) =>
      dropboxContentUpload(
        { enabled: true, accessToken: "dropbox-token" },
        { path: "/reviewed.txt", data: Buffer.from("reviewed bytes"), beforeSend },
      ),
  },
  {
    name: "SharePoint content",
    send: (beforeSend: () => void | Promise<void>) =>
      sharepointRequest(
        { enabled: true, accessToken: "sharepoint-token" },
        {
          method: "PUT",
          path: "/drives/drive-1/root:/reviewed.txt:/content",
          body: Buffer.from("reviewed bytes"),
          beforeSend,
        },
      ),
  },
  {
    name: "OneDrive content",
    send: (beforeSend: () => void | Promise<void>) =>
      onedriveRequest(
        { enabled: true, accessToken: "onedrive-token" },
        {
          method: "PUT",
          path: "/drives/drive-1/root:/reviewed.txt:/content",
          body: Buffer.from("reviewed bytes"),
          beforeSend,
        },
      ),
  },
];

describe("integration upload send boundary", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let order: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.getGoogleWorkspaceAccessToken.mockResolvedValue("google-token");
    order = [];
    fetchMock = vi.fn(async () => {
      order.push("fetch");
      return { ok: true, status: 200, statusText: "OK", text: async () => "{}" };
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(operations)(
    "awaits the review guard immediately before $name fetch",
    async ({ send }) => {
      await send(async () => {
        await Promise.resolve();
        order.push("guard");
      });

      expect(order).toEqual(["guard", "fetch"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(operations)("does not call $name fetch if the guard refuses", async ({ send }) => {
    await expect(send(async () => Promise.reject(new Error("send revoked")))).rejects.toThrow(
      "send revoked",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
