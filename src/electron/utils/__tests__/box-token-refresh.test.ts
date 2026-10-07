import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ current: {} as Any }));
vi.mock("../../settings/box-manager", () => ({
  BoxSettingsManager: {
    loadSettings: vi.fn(() => structuredClone(state.current)),
    saveSettings: vi.fn((value: Any) => {
      state.current = structuredClone(value);
    }),
  },
}));
import { BoxSettingsManager } from "../../settings/box-manager";
import { getBoxAccessToken } from "../box-api";
const fetchMock = vi.fn();
const expired = () => ({
  enabled: true,
  accessToken: randomUUID(),
  refreshToken: randomUUID(),
  clientId: randomUUID(),
  clientSecret: "fixture-secret",
  tokenExpiresAt: 1,
});
const response = (token = "next") =>
  new Response(
    JSON.stringify({ access_token: token, refresh_token: token + "-refresh", expires_in: 3600 }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  state.current = expired();
});
afterEach(() => vi.unstubAllGlobals());
describe("Box source-bound credential refresh", () => {
  it("shares one refresh only for identical credential sources and updates both callers", async () => {
    const first = structuredClone(state.current),
      second = structuredClone(first);
    fetchMock.mockResolvedValue(response());
    expect(await Promise.all([getBoxAccessToken(first), getBoxAccessToken(second)])).toEqual([
      "next",
      "next",
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(first.refreshToken).toBe("next-refresh");
    expect(second.refreshToken).toBe("next-refresh");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });
  it("does not attach a changed client to an earlier client's pending refresh", async () => {
    let resolveA!: (value: Response) => void, resolveB!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolveA = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolveB = r;
          }),
      );
    const a = getBoxAccessToken(structuredClone(state.current));
    const refused = expect(a).rejects.toThrow("credentials changed");
    state.current = expired();
    const b = getBoxAccessToken(structuredClone(state.current));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveA(response("a"));
    resolveB(response("b"));
    await refused;
    expect(await b).toBe("b");
    expect(state.current.accessToken).toBe("b");
  });
  it("preserves a manual token edit made during a refresh", async () => {
    fetchMock.mockImplementationOnce(async () => {
      state.current.accessToken = "manual";
      return response();
    });
    await expect(getBoxAccessToken(structuredClone(state.current))).rejects.toThrow(
      "credentials changed",
    );
    expect(BoxSettingsManager.saveSettings).not.toHaveBeenCalled();
    expect(state.current.accessToken).toBe("manual");
  });
  it("preserves unrelated settings changed while refresh was pending", async () => {
    fetchMock.mockImplementationOnce(async () => {
      state.current.enabled = false;
      state.current.mcpEnabled = false;
      return response();
    });
    await expect(getBoxAccessToken(structuredClone(state.current))).resolves.toBe("next");
    expect(state.current.enabled).toBe(false);
    expect(state.current.mcpEnabled).toBe(false);
  });
});
