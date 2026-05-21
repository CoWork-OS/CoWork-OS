import * as readline from "readline";

type JSONRPCId = string | number;

type JSONRPCRequest = {
  jsonrpc: "2.0";
  id: JSONRPCId;
  method: string;
  params?: Record<string, any>;
};

type JSONRPCNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
};

type JSONRPCResponse = {
  jsonrpc: "2.0";
  id: JSONRPCId;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

type MCPToolProperty = {
  type: string;
  description?: string;
  enum?: string[];
  default?: any;
  items?: MCPToolProperty;
  properties?: Record<string, MCPToolProperty>;
  required?: string[];
};

type MCPTool = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, MCPToolProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

type MCPServerInfo = {
  name: string;
  version: string;
  protocolVersion?: string;
  capabilities?: {
    tools?: { listChanged?: boolean };
  };
};

type Coordinates = {
  latitude: number;
  longitude: number;
};

type NormalizedPlace = {
  id: string;
  provider: "osm" | "google";
  name: string;
  categories: string[];
  address?: string;
  location: Coordinates;
  rating?: number;
  userRatingCount?: number;
  openNow?: boolean | null;
  openingHoursText?: string;
  mapsUrl?: string;
  sourceUrl?: string;
  attribution: string;
};

type NormalizedRoute = {
  mode: "walking";
  distanceMeters: number;
  durationSeconds: number;
  provider: "osm" | "google" | "estimate";
  warnings: string[];
  attribution: string;
};

type ProviderName = "osm" | "google";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const DEFAULT_OSRM_BASE_URL = "https://router.project-osrm.org";
const OSM_ATTRIBUTION = "Place data © OpenStreetMap contributors, ODbL.";
const OSRM_ATTRIBUTION = "Route data © OpenStreetMap contributors, routed by OSRM.";
const GOOGLE_ATTRIBUTION = "Place and route data from Google Maps Platform.";
const USER_AGENT = "CoWorkOS/0.1 maps-mcp (https://cowork-os.local)";

const MCP_METHODS = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  SHUTDOWN: "shutdown",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
} as const;

class StdioMCPServer {
  private initialized = false;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly toolProvider: { getTools(): MCPTool[]; executeTool(name: string, args: Record<string, any>): Promise<any> },
    private readonly serverInfo: MCPServerInfo,
  ) {}

  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => this.stop());
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    process.exit(0);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.handleMessage(JSON.parse(trimmed));
    } catch {
      this.sendError(0, MCP_ERROR_CODES.PARSE_ERROR, "Parse error");
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if ("id" in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
      return;
    }
    if ("method" in message) await this.handleNotification(message as JSONRPCNotification);
  }

  private async handleRequest(request: JSONRPCRequest): Promise<void> {
    try {
      let result: any;
      switch (request.method) {
        case MCP_METHODS.INITIALIZE:
          result = this.handleInitialize();
          break;
        case MCP_METHODS.TOOLS_LIST:
          this.requireInitialized();
          result = { tools: this.toolProvider.getTools() };
          break;
        case MCP_METHODS.TOOLS_CALL:
          this.requireInitialized();
          result = await this.handleToolsCall(request.params);
          break;
        case MCP_METHODS.SHUTDOWN:
          result = {};
          setImmediate(() => this.stop());
          break;
        default:
          throw { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Method not found: ${request.method}` };
      }
      this.sendResult(request.id, result);
    } catch (error: any) {
      this.sendError(request.id, error?.code || MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || "Internal error", error?.data);
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    if (notification.method === MCP_METHODS.INITIALIZED) this.initialized = true;
  }

  private handleInitialize(): {
    protocolVersion: string;
    capabilities: MCPServerInfo["capabilities"];
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw { code: MCP_ERROR_CODES.INVALID_REQUEST, message: "Already initialized" };
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.serverInfo.capabilities,
      serverInfo: this.serverInfo,
    };
  }

  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params || {};
    if (!name) throw { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "Tool name is required" };
    try {
      const result = await this.toolProvider.executeTool(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error?.message || "Tool failed"}` }],
        isError: true,
      };
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw { code: MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, message: "Server not initialized" };
    }
  }

  private sendResult(id: JSONRPCId, result: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: JSONRPCId, code: number, message: string, data?: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private sendMessage(message: JSONRPCResponse): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const locationSchema: MCPToolProperty = {
  type: "object",
  properties: {
    latitude: { type: "number", description: "Latitude" },
    longitude: { type: "number", description: "Longitude" },
  },
  required: ["latitude", "longitude"],
};

const tools: MCPTool[] = [
  {
    name: "maps.health",
    description: "Check maps connector provider configuration",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "maps.search_places",
    description: "Search nearby places for a query around a latitude/longitude",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language place query" },
        location: locationSchema,
        radiusMeters: { type: "number", description: "Search radius in meters, default 1500" },
        maxResults: { type: "number", description: "Maximum results, default 5" },
        openNow: { type: "boolean", description: "Prefer places currently open when provider supports it" },
      },
      required: ["query", "location"],
      additionalProperties: false,
    },
  },
  {
    name: "maps.place_details",
    description: "Fetch normalized details for a place returned by maps.search_places",
    inputSchema: {
      type: "object",
      properties: {
        placeId: { type: "string", description: "Provider-qualified place ID" },
      },
      required: ["placeId"],
      additionalProperties: false,
    },
  },
  {
    name: "maps.route",
    description: "Estimate a walking route between two coordinates",
    inputSchema: {
      type: "object",
      properties: {
        origin: locationSchema,
        destination: locationSchema,
        mode: { type: "string", enum: ["walking"], default: "walking" },
      },
      required: ["origin", "destination"],
      additionalProperties: false,
    },
  },
  {
    name: "maps.rank_nearby_options",
    description: "Search nearby places and rank options by walking time and relevance for urgent errands",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Need or item to find nearby" },
        location: locationSchema,
        radiusMeters: { type: "number", description: "Search radius in meters, default 1500" },
        maxResults: { type: "number", description: "Maximum ranked options, default 5" },
        deadlineMinutes: { type: "number", description: "Optional deadline in minutes" },
        openNow: { type: "boolean", description: "Prefer places currently open" },
      },
      required: ["query", "location"],
      additionalProperties: false,
    },
  },
];

let lastNominatimRequestAt = 0;
const placeCache = new Map<string, NormalizedPlace>();

function envValue(name: string, fallback = ""): string {
  return (process.env[name] || fallback).trim();
}

function resolveProvider(): ProviderName {
  const configured = envValue("MAPS_PROVIDER", "auto").toLowerCase();
  if (configured === "google") return hasGoogleKey() ? "google" : "osm";
  if (configured === "osm") return "osm";
  return hasGoogleKey() ? "google" : "osm";
}

function hasGoogleKey(): boolean {
  return envValue("GOOGLE_MAPS_API_KEY").length > 0;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  return value.trim();
}

function requireLocation(value: unknown, label: string): Coordinates {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const latitude = obj?.latitude;
  const longitude = obj?.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) {
    throw new Error(`Invalid ${label}.latitude`);
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) {
    throw new Error(`Invalid ${label}.longitude`);
  }
  return { latitude, longitude };
}

async function rateLimitNominatim(): Promise<void> {
  const elapsed = Date.now() - lastNominatimRequestAt;
  const waitMs = Math.max(0, 1100 - elapsed);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastNominatimRequestAt = Date.now();
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return response.json();
}

function radiusViewbox(location: Coordinates, radiusMeters: number): string {
  const latDelta = radiusMeters / 111_320;
  const lonDelta = radiusMeters / (111_320 * Math.max(0.2, Math.cos((location.latitude * Math.PI) / 180)));
  const left = location.longitude - lonDelta;
  const right = location.longitude + lonDelta;
  const top = location.latitude + latDelta;
  const bottom = location.latitude - latDelta;
  return `${left},${top},${right},${bottom}`;
}

function osmTypePath(osmType: string): string {
  if (osmType === "node" || osmType === "N") return "node";
  if (osmType === "way" || osmType === "W") return "way";
  if (osmType === "relation" || osmType === "R") return "relation";
  return "node";
}

function normalizeOsmPlace(item: any): NormalizedPlace {
  const osmType = String(item.osm_type || "").toLowerCase();
  const osmId = String(item.osm_id || "");
  const path = osmTypePath(osmType);
  const id = `osm:${path}:${osmId}`;
  const tags = item.extratags && typeof item.extratags === "object" ? item.extratags : {};
  const categories = [item.class, item.type, tags.shop, tags.amenity, tags.tourism]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => String(value));
  const place: NormalizedPlace = {
    id,
    provider: "osm",
    name: String(item.name || item.display_name || "Unnamed place").split(",")[0],
    categories: [...new Set(categories)],
    address: item.display_name ? String(item.display_name) : undefined,
    location: {
      latitude: Number(item.lat),
      longitude: Number(item.lon),
    },
    openNow: null,
    openingHoursText: typeof tags.opening_hours === "string" ? tags.opening_hours : undefined,
    mapsUrl: `https://www.openstreetmap.org/${path}/${osmId}`,
    sourceUrl: `https://www.openstreetmap.org/${path}/${osmId}`,
    attribution: OSM_ATTRIBUTION,
  };
  placeCache.set(place.id, place);
  return place;
}

async function osmSearchPlaces(args: Record<string, any>): Promise<NormalizedPlace[]> {
  const query = requireString(args.query, "query");
  const location = requireLocation(args.location, "location");
  const radiusMeters = numberOrDefault(args.radiusMeters, 1500, 100, 10000);
  const maxResults = Math.round(numberOrDefault(args.maxResults, 5, 1, 20));
  const baseUrl = envValue("NOMINATIM_BASE_URL", DEFAULT_NOMINATIM_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(maxResults));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", radiusViewbox(location, radiusMeters));

  await rateLimitNominatim();
  const data = await fetchJson(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  return Array.isArray(data) ? data.map(normalizeOsmPlace) : [];
}

async function osmPlaceDetails(placeId: string): Promise<NormalizedPlace> {
  const cached = placeCache.get(placeId);
  if (cached) return cached;
  const match = /^osm:(node|way|relation):(\d+)$/.exec(placeId);
  if (!match) throw new Error(`Unsupported OSM place ID: ${placeId}`);
  const prefix = match[1] === "node" ? "N" : match[1] === "way" ? "W" : "R";
  const baseUrl = envValue("NOMINATIM_BASE_URL", DEFAULT_NOMINATIM_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/lookup`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("osm_ids", `${prefix}${match[2]}`);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  await rateLimitNominatim();
  const data = await fetchJson(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Place not found: ${placeId}`);
  return normalizeOsmPlace(data[0]);
}

async function googleSearchPlaces(args: Record<string, any>): Promise<NormalizedPlace[]> {
  const query = requireString(args.query, "query");
  const location = requireLocation(args.location, "location");
  const radiusMeters = numberOrDefault(args.radiusMeters, 1500, 100, 10000);
  const maxResults = Math.round(numberOrDefault(args.maxResults, 5, 1, 20));
  const key = envValue("GOOGLE_MAPS_API_KEY");
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is required for Google provider");
  const body: Record<string, any> = {
    textQuery: query,
    maxResultCount: maxResults,
    locationBias: {
      circle: {
        center: { latitude: location.latitude, longitude: location.longitude },
        radius: radiusMeters,
      },
    },
  };
  if (args.openNow === true) body.openNow = true;

  const data = await fetchJson("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.userRatingCount,places.currentOpeningHours,places.googleMapsUri",
    },
    body: JSON.stringify(body),
  });
  return Array.isArray(data.places) ? data.places.map(normalizeGooglePlace) : [];
}

function normalizeGooglePlace(item: any): NormalizedPlace {
  const id = `google:${String(item.id || "").replace(/^places\//, "")}`;
  const weekdayText = Array.isArray(item.currentOpeningHours?.weekdayDescriptions)
    ? item.currentOpeningHours.weekdayDescriptions.join("; ")
    : undefined;
  const place: NormalizedPlace = {
    id,
    provider: "google",
    name: String(item.displayName?.text || "Unnamed place"),
    categories: Array.isArray(item.types) ? item.types.map(String) : [],
    address: typeof item.formattedAddress === "string" ? item.formattedAddress : undefined,
    location: {
      latitude: Number(item.location?.latitude),
      longitude: Number(item.location?.longitude),
    },
    rating: typeof item.rating === "number" ? item.rating : undefined,
    userRatingCount: typeof item.userRatingCount === "number" ? item.userRatingCount : undefined,
    openNow:
      typeof item.currentOpeningHours?.openNow === "boolean"
        ? item.currentOpeningHours.openNow
        : null,
    openingHoursText: weekdayText,
    mapsUrl: typeof item.googleMapsUri === "string" ? item.googleMapsUri : undefined,
    sourceUrl: typeof item.googleMapsUri === "string" ? item.googleMapsUri : undefined,
    attribution: GOOGLE_ATTRIBUTION,
  };
  placeCache.set(place.id, place);
  return place;
}

async function googlePlaceDetails(placeId: string): Promise<NormalizedPlace> {
  const cached = placeCache.get(placeId);
  if (cached) return cached;
  const key = envValue("GOOGLE_MAPS_API_KEY");
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is required for Google provider");
  const rawId = placeId.replace(/^google:/, "");
  const data = await fetchJson(`https://places.googleapis.com/v1/places/${encodeURIComponent(rawId)}`, {
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,location,types,rating,userRatingCount,currentOpeningHours,googleMapsUri",
    },
  });
  return normalizeGooglePlace(data);
}

function haversineMeters(a: Coordinates, b: Coordinates): number {
  const radius = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function fallbackWalkingRoute(origin: Coordinates, destination: Coordinates, warning: string): NormalizedRoute {
  const straightLine = haversineMeters(origin, destination);
  const distanceMeters = Math.round(straightLine * 1.25);
  return {
    mode: "walking",
    distanceMeters,
    durationSeconds: Math.round(distanceMeters / 1.4),
    provider: "estimate",
    warnings: [warning, "Estimated from straight-line distance; route may differ."],
    attribution: OSM_ATTRIBUTION,
  };
}

async function osmRoute(origin: Coordinates, destination: Coordinates): Promise<NormalizedRoute> {
  const baseUrl = envValue("OSRM_BASE_URL", DEFAULT_OSRM_BASE_URL).replace(/\/+$/, "");
  const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  const url = `${baseUrl}/route/v1/foot/${coords}?overview=false&alternatives=false&steps=false`;
  try {
    const data = await fetchJson(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const route = Array.isArray(data.routes) ? data.routes[0] : null;
    if (!route) throw new Error("No walking route returned");
    return {
      mode: "walking",
      distanceMeters: Math.round(Number(route.distance)),
      durationSeconds: Math.round(Number(route.duration)),
      provider: "osm",
      warnings: [
        "Walking route data may be incomplete and should be checked for sidewalks, crossings, and access restrictions.",
      ],
      attribution: OSRM_ATTRIBUTION,
    };
  } catch (error: any) {
    return fallbackWalkingRoute(origin, destination, `OSRM walking route unavailable: ${error?.message || "unknown error"}`);
  }
}

async function googleRoute(origin: Coordinates, destination: Coordinates): Promise<NormalizedRoute> {
  const key = envValue("GOOGLE_MAPS_API_KEY");
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is required for Google provider");
  const data = await fetchJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode: "WALK",
    }),
  });
  const route = Array.isArray(data.routes) ? data.routes[0] : null;
  if (!route) return fallbackWalkingRoute(origin, destination, "Google returned no walking route.");
  return {
    mode: "walking",
    distanceMeters: Math.round(Number(route.distanceMeters || 0)),
    durationSeconds: parseGoogleDuration(route.duration),
    provider: "google",
    warnings: [
      "Walking route data may be incomplete and should be checked for sidewalks, crossings, and access restrictions.",
    ],
    attribution: GOOGLE_ATTRIBUTION,
  };
}

function parseGoogleDuration(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Math.round(Number(match[1])) : 0;
}

async function searchPlaces(args: Record<string, any>): Promise<{ provider: ProviderName; places: NormalizedPlace[] }> {
  const provider = resolveProvider();
  const places = provider === "google" ? await googleSearchPlaces(args) : await osmSearchPlaces(args);
  return { provider, places };
}

async function placeDetails(args: Record<string, any>): Promise<{ place: NormalizedPlace }> {
  const placeId = requireString(args.placeId, "placeId");
  const place = placeId.startsWith("google:")
    ? await googlePlaceDetails(placeId)
    : await osmPlaceDetails(placeId);
  return { place };
}

async function route(args: Record<string, any>): Promise<{ route: NormalizedRoute }> {
  const origin = requireLocation(args.origin, "origin");
  const destination = requireLocation(args.destination, "destination");
  const provider = resolveProvider();
  return { route: provider === "google" ? await googleRoute(origin, destination) : await osmRoute(origin, destination) };
}

async function rankNearbyOptions(args: Record<string, any>): Promise<{
  provider: ProviderName;
  query: string;
  deadlineMinutes?: number;
  options: Array<{ place: NormalizedPlace; route: NormalizedRoute; withinDeadline?: boolean }>;
  warnings: string[];
}> {
  const origin = requireLocation(args.location, "location");
  const deadlineMinutes =
    typeof args.deadlineMinutes === "number" && Number.isFinite(args.deadlineMinutes)
      ? args.deadlineMinutes
      : undefined;
  const search = await searchPlaces(args);
  const options = await Promise.all(
    search.places.map(async (place) => {
      const routeResult =
        search.provider === "google"
          ? await googleRoute(origin, place.location).catch((error: any) =>
              fallbackWalkingRoute(origin, place.location, `Google walking route unavailable: ${error?.message || "unknown error"}`),
            )
          : await osmRoute(origin, place.location);
      return {
        place,
        route: routeResult,
        ...(deadlineMinutes !== undefined
          ? { withinDeadline: routeResult.durationSeconds <= deadlineMinutes * 60 }
          : {}),
      };
    }),
  );
  options.sort((a, b) => {
    const openDelta = Number(b.place.openNow === true) - Number(a.place.openNow === true);
    if (openDelta !== 0) return openDelta;
    return a.route.durationSeconds - b.route.durationSeconds;
  });
  return {
    provider: search.provider,
    query: requireString(args.query, "query"),
    ...(deadlineMinutes !== undefined ? { deadlineMinutes } : {}),
    options,
    warnings: search.provider === "osm"
      ? ["OSM place metadata may not include ratings, phone numbers, or current opening status."]
      : [],
  };
}

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  "maps.health": async () => ({
    ok: true,
    data: {
      provider: resolveProvider(),
      googleConfigured: hasGoogleKey(),
      nominatimBaseUrl: envValue("NOMINATIM_BASE_URL", DEFAULT_NOMINATIM_BASE_URL),
      osrmBaseUrl: envValue("OSRM_BASE_URL", DEFAULT_OSRM_BASE_URL),
    },
  }),
  "maps.search_places": searchPlaces,
  "maps.place_details": placeDetails,
  "maps.route": route,
  "maps.rank_nearby_options": rankNearbyOptions,
};

const toolProvider = {
  getTools: () => tools,
  executeTool: async (name: string, args: Record<string, any>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args || {});
  },
};

export function listMapsToolsForTest(): MCPTool[] {
  return tools;
}

export async function executeMapsToolForTest(name: string, args: Record<string, any>): Promise<any> {
  return toolProvider.executeTool(name, args);
}

export function resetMapsConnectorStateForTest(): void {
  placeCache.clear();
  lastNominatimRequestAt = 0;
}

const serverInfo: MCPServerInfo = {
  name: "Maps",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startMapsMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startMapsMcpServer();
}
