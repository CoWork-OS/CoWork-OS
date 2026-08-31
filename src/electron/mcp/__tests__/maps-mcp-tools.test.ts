import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

async function loadConnector() {
  vi.resetModules();
  return import("../../../../connectors/maps-mcp/src/index");
}

describe("maps MCP connector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.MAPS_PROVIDER;
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.NOMINATIM_BASE_URL;
    delete process.env.OSRM_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MAPS_PROVIDER;
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.NOMINATIM_BASE_URL;
    delete process.env.OSRM_BASE_URL;
  });

  it("chooses OSM by default and Google only when a key is configured", async () => {
    let connector = await loadConnector();
    expect(await connector.executeMapsToolForTest("maps.health", {})).toMatchObject({
      data: { provider: "osm", googleConfigured: false },
    });

    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    connector = await loadConnector();
    expect(await connector.executeMapsToolForTest("maps.health", {})).toMatchObject({
      data: { provider: "google", googleConfigured: true },
    });
  });

  it("uses Nominatim with identifying headers and normalizes OSM places", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          osm_type: "node",
          osm_id: 123,
          name: "The Purple Butterfly",
          display_name: "The Purple Butterfly, Main Street",
          lat: "40.1",
          lon: "-73.2",
          class: "shop",
          type: "clothes",
          extratags: { opening_hours: "Mo-Fr 09:00-17:00", shop: "clothes" },
        },
      ]) as Response,
    );
    const connector = await loadConnector();

    const result = await connector.executeMapsToolForTest("maps.search_places", {
      query: "children dress",
      location: { latitude: 40, longitude: -73 },
      radiusMeters: 1000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("nominatim.openstreetmap.org/search"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("CoWorkOS"),
        }),
      }),
    );
    expect(result.places[0]).toMatchObject({
      id: "osm:node:123",
      provider: "osm",
      name: "The Purple Butterfly",
      openingHoursText: "Mo-Fr 09:00-17:00",
      attribution: expect.stringContaining("OpenStreetMap"),
    });
  });

  it("uses Google field masks and keeps the API key out of request bodies", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        places: [
          {
            id: "places/google-place-1",
            displayName: { text: "The Purple Butterfly" },
            formattedAddress: "1 Main Street",
            location: { latitude: 40.1, longitude: -73.2 },
            types: ["childrens_clothing_store"],
            rating: 4.8,
            userRatingCount: 55,
            currentOpeningHours: { openNow: true, weekdayDescriptions: ["Monday: 9 AM-5 PM"] },
            googleMapsUri: "https://maps.google.com/?cid=1",
          },
        ],
      }) as Response,
    );
    const connector = await loadConnector();

    const result = await connector.executeMapsToolForTest("maps.search_places", {
      query: "children dress",
      location: { latitude: 40, longitude: -73 },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "X-Goog-Api-Key": "test-google-key",
      "X-Goog-FieldMask": expect.stringContaining("places.displayName"),
    });
    expect(String(init?.body)).not.toContain("test-google-key");
    expect(result.places[0]).toMatchObject({
      id: "google:google-place-1",
      provider: "google",
      rating: 4.8,
      openNow: true,
    });
  });

  it("ranks nearby options by walking duration for the urgent dress scenario", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          {
            osm_type: "node",
            osm_id: 1,
            name: "Far Kids Clothes",
            display_name: "Far Kids Clothes",
            lat: "40.02",
            lon: "-73.02",
            class: "shop",
            type: "clothes",
            extratags: {},
          },
          {
            osm_type: "node",
            osm_id: 2,
            name: "The Purple Butterfly",
            display_name: "The Purple Butterfly",
            lat: "40.001",
            lon: "-73.001",
            class: "shop",
            type: "clothes",
            extratags: { opening_hours: "Mo-Fr 09:00-17:00" },
          },
        ]) as Response,
      )
      .mockResolvedValueOnce(
        jsonResponse({ routes: [{ distance: 2000, duration: 1500 }] }) as Response,
      )
      .mockResolvedValueOnce(
        jsonResponse({ routes: [{ distance: 250, duration: 180 }] }) as Response,
      );
    const connector = await loadConnector();

    const result = await connector.executeMapsToolForTest("maps.rank_nearby_options", {
      query: "children dress",
      location: { latitude: 40, longitude: -73 },
      deadlineMinutes: 30,
    });

    expect(result.options[0].place.name).toBe("The Purple Butterfly");
    expect(result.options[0].route.durationSeconds).toBe(180);
    expect(result.options[0].withinDeadline).toBe(true);
  });
});
