import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

async function loadConnector() {
  vi.resetModules();
  return import("../../../../connectors/maps-mcp/src/index");
}

describe("maps.timezone", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.MAPS_PROVIDER;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  it("computes offsets on both sides of a daylight-saving transition", async () => {
    const { executeMapsToolForTest } = await loadConnector();

    const winter = await executeMapsToolForTest("maps.timezone", {
      timeZone: "America/New_York",
      timestamp: "2026-03-08T06:59:00Z",
    });
    const summer = await executeMapsToolForTest("maps.timezone", {
      timeZone: "America/New_York",
      timestamp: "2026-03-08T07:01:00Z",
    });

    expect(winter).toMatchObject({
      utcOffset: "-05:00",
      isDst: false,
      localTime: "2026-03-08T01:59:00",
    });
    expect(summer).toMatchObject({
      utcOffset: "-04:00",
      isDst: true,
      localTime: "2026-03-08T03:01:00",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles southern-hemisphere and fractional offsets", async () => {
    const { executeMapsToolForTest } = await loadConnector();

    expect(
      await executeMapsToolForTest("maps.timezone", {
        timeZone: "Australia/Sydney",
        timestamp: "2026-01-15T00:00:00Z",
      }),
    ).toMatchObject({ utcOffset: "+11:00", isDst: true });
    expect(
      await executeMapsToolForTest("maps.timezone", {
        timeZone: "Asia/Kolkata",
        timestamp: "2026-01-15T00:00:00Z",
      }),
    ).toMatchObject({ utcOffset: "+05:30", utcOffsetMinutes: 330, isDst: false });
  });

  it("resolves coordinates through Open-Meteo without a Google key", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ timezone: "Europe/London" }) as Response);
    const { executeMapsToolForTest } = await loadConnector();

    const result = await executeMapsToolForTest("maps.timezone", {
      location: { latitude: 51.5, longitude: -0.12 },
      timestamp: "2026-07-01T12:00:00Z",
    });

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("api.open-meteo.com");
    expect(result).toMatchObject({
      timeZone: "Europe/London",
      source: "open-meteo",
      utcOffset: "+01:00",
      isDst: true,
    });
  });

  it("uses the Google Time Zone API when a key is configured", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "key";
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        status: "OK",
        timeZoneId: "Asia/Tokyo",
        timeZoneName: "Japan Standard Time",
      }) as Response,
    );
    const { executeMapsToolForTest } = await loadConnector();

    const result = await executeMapsToolForTest("maps.timezone", {
      location: { latitude: 35.68, longitude: 139.69 },
      timestamp: "1767225600000",
    });

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toContain("maps.googleapis.com/maps/api/timezone/json");
    expect(url).toContain("timestamp=1767225600");
    expect(result).toMatchObject({ timeZone: "Asia/Tokyo", source: "google", utcOffset: "+09:00" });
  });

  it("treats 10-digit timestamps as epoch seconds", async () => {
    const { executeMapsToolForTest } = await loadConnector();
    const seconds = await executeMapsToolForTest("maps.timezone", {
      timeZone: "UTC",
      timestamp: "1767225600",
    });
    const millis = await executeMapsToolForTest("maps.timezone", {
      timeZone: "UTC",
      timestamp: "1767225600000",
    });
    expect(seconds.instant).toBe("2026-01-01T00:00:00.000Z");
    expect(millis.instant).toBe("2026-01-01T00:00:00.000Z");
  });

  it("never sends coordinates anywhere when lookup is off", async () => {
    process.env.MAPS_TIMEZONE_LOOKUP = "off";
    try {
      const { executeMapsToolForTest } = await loadConnector();
      await expect(
        executeMapsToolForTest("maps.timezone", { location: { latitude: 1, longitude: 2 } }),
      ).rejects.toThrow(/disabled/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      delete process.env.MAPS_TIMEZONE_LOOKUP;
    }
  });

  it("rejects unknown zones and missing input", async () => {
    const { executeMapsToolForTest } = await loadConnector();
    await expect(
      executeMapsToolForTest("maps.timezone", { timeZone: "Mars/Olympus" }),
    ).rejects.toThrow(/Unknown IANA timezone/);
    await expect(executeMapsToolForTest("maps.timezone", {})).rejects.toThrow(
      /Provide location or timeZone/,
    );
  });
});
