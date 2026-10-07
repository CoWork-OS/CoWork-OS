import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../settings/box-manager", () => ({
  BoxSettingsManager: { loadSettings: vi.fn(), saveSettings: vi.fn() },
}));
import { BoxSettingsManager } from "../../settings/box-manager";
import { boxUploadFile } from "../box-api";
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("Box upload wire boundary", () => {
  it("refuses submission after delayed setup when the current authority fails", async () => {
    await expect(
      boxUploadFile({ accessToken: "fixture" } as Any, {
        fileName: "draft.txt",
        parentId: "0",
        data: Buffer.from("draft"),
        beforeSend: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("checks revocation after the actual OAuth refresh, with zero upload POSTs", async () => {
    const settings = {
      enabled: true,
      accessToken: "before-wire",
      refreshToken: "before-refresh",
      clientId: "wire-client",
      clientSecret: "fixture",
      tokenExpiresAt: 1,
    } as Any;
    vi.mocked(BoxSettingsManager.loadSettings).mockImplementation(() => structuredClone(settings));
    vi.mocked(BoxSettingsManager.saveSettings).mockImplementation((value) =>
      Object.assign(settings, value),
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "after-wire",
            refresh_token: "after-refresh",
            expires_in: 3600,
          }),
        ),
    );
    await expect(
      boxUploadFile(settings, {
        fileName: "draft.txt",
        parentId: "0",
        data: Buffer.from("draft"),
        beforeSend: async () => {
          throw new Error("revoked after refresh");
        },
      }),
    ).rejects.toThrow("revoked after refresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.box.com/oauth2/token");
  });
  it("seals bytes and destination before awaits and refuses automatic redirects", async () => {
    const bytes = Buffer.from("draft");
    const opts = {
      fileName: "draft.txt",
      parentId: "0",
      data: bytes,
      beforeSend: async () => {},
    };
    fetchMock.mockResolvedValue(new Response("{}", { status: 201 }));
    const pending = boxUploadFile({ accessToken: "fixture" } as Any, opts);
    bytes.fill(120);
    opts.fileName = "changed.txt";
    opts.parentId = "foreign";
    await pending;
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body.get("attributes"))).toEqual({
      name: "draft.txt",
      parent: { id: "0" },
    });
    expect(await request.body.get("file").text()).toBe("draft");
    expect(request.body.get("file").name).toBe("draft.txt");
    expect(request.redirect).toBe("manual");
  });
});
