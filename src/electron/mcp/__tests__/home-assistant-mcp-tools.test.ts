import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(data: Any, status = 200): Any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(data === undefined ? "" : JSON.stringify(data)),
  };
}

const ENV_KEYS = [
  "HOME_ASSISTANT_URL",
  "HOME_ASSISTANT_TOKEN",
  "HOME_ASSISTANT_ALLOWED_DOMAINS",
  "HOME_ASSISTANT_ALLOWED_ENTITIES",
];

async function loadConnector(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.HOME_ASSISTANT_URL = "http://ha.local:8123/";
  process.env.HOME_ASSISTANT_TOKEN = "secret-token";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return import("../../../../connectors/home-assistant-mcp/src/index");
}

describe("home-assistant MCP connector", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("filters and compacts entity listings", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([
        { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
        { entity_id: "light.hall", state: "off", attributes: { friendly_name: "Hallway" } },
        { entity_id: "sensor.temp", state: "21", attributes: { unit_of_measurement: "°C" } },
      ]) as Response,
    );
    const { executeHomeAssistantToolForTest } = await loadConnector();

    const result = await executeHomeAssistantToolForTest("home-assistant.list_entities", {
      domain: "light",
      query: "kit",
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://ha.local:8123/api/states");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer secret-token" });
    expect(result.data).toEqual({
      total: 1,
      truncated: false,
      entities: [expect.objectContaining({ entityId: "light.kitchen", state: "on" })],
    });
  });

  it("disables service calls until something is allowlisted", async () => {
    const { executeHomeAssistantToolForTest } = await loadConnector();

    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "light",
        service: "turn_on",
        entityIds: ["light.kitchen"],
      }),
    ).rejects.toThrow(/disabled until you allowlist/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls allowlisted services with explicit targets", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([{ entity_id: "light.kitchen", state: "on" }]) as Response,
    );
    const { executeHomeAssistantToolForTest } = await loadConnector({
      HOME_ASSISTANT_ALLOWED_DOMAINS: "light",
    });

    const result = await executeHomeAssistantToolForTest("home-assistant.call_service", {
      domain: "light",
      service: "turn_on",
      entityIds: ["light.kitchen"],
      data: { brightness_pct: 40 },
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://ha.local:8123/api/services/light/turn_on");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      brightness_pct: 40,
      entity_id: ["light.kitchen"],
    });
    expect(result.data.changedStates[0]).toMatchObject({ entityId: "light.kitchen", state: "on" });
  });

  it("rejects targets outside the allowlist and fan-out targets", async () => {
    const { executeHomeAssistantToolForTest } = await loadConnector({
      HOME_ASSISTANT_ALLOWED_DOMAINS: "light",
    });

    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "lock",
        service: "unlock",
        entityIds: ["lock.front_door"],
      }),
    ).rejects.toThrow(/not in HOME_ASSISTANT_ALLOWED_DOMAINS/);
    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "light",
        service: "turn_off",
        entityIds: ["light.kitchen"],
        data: { area_id: "downstairs" },
      }),
    ).rejects.toThrow(/entityIds, not data.area_id/);
    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "light",
        service: "turn_off",
        entityIds: ["all"],
      }),
    ).rejects.toThrow(/must look like/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies entity patterns, blocked domains and cross-domain checks", async () => {
    const { assertServiceCallAllowed } = await loadConnector();
    const config = { domains: [], entities: ["switch.fan_*", "lock.front_door"] };

    expect(() =>
      assertServiceCallAllowed("switch", "turn_on", ["switch.fan_bedroom"], config),
    ).not.toThrow();
    expect(() => assertServiceCallAllowed("switch", "turn_on", ["switch.heater"], config)).toThrow(
      /not allowlisted/,
    );
    expect(() =>
      assertServiceCallAllowed("script", "turn_on", ["lock.front_door"], config),
    ).toThrow(/cannot target lock.front_door/);
    expect(() =>
      assertServiceCallAllowed("homeassistant", "toggle", ["lock.front_door"], config),
    ).not.toThrow();
    expect(() =>
      assertServiceCallAllowed("homeassistant", "restart", ["lock.front_door"], config),
    ).toThrow(/blocked/);
    expect(() =>
      assertServiceCallAllowed("shell_command", "run", ["lock.front_door"], {
        domains: ["shell_command"],
        entities: [],
      }),
    ).toThrow(/blocked/);
  });

  it("requires explicit confirmation for physical-security devices", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse([]) as Response);
    const { executeHomeAssistantToolForTest } = await loadConnector({
      HOME_ASSISTANT_ALLOWED_ENTITIES: "lock.front_door",
    });
    const call = {
      domain: "lock",
      service: "unlock",
      entityIds: ["lock.front_door"],
    };

    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", call),
    ).rejects.toThrow(/confirm: true/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "homeassistant",
        service: "toggle",
        entityIds: ["lock.front_door"],
      }),
    ).rejects.toThrow(/confirm: true/);

    await executeHomeAssistantToolForTest("home-assistant.call_service", {
      ...call,
      confirm: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects data.target fan-out and warns about plain-HTTP tokens", async () => {
    const { executeHomeAssistantToolForTest, transportWarning } = await loadConnector({
      HOME_ASSISTANT_ALLOWED_DOMAINS: "light",
    });
    await expect(
      executeHomeAssistantToolForTest("home-assistant.call_service", {
        domain: "light",
        service: "turn_off",
        entityIds: ["light.kitchen"],
        data: { target: { area_id: "house" } },
      }),
    ).rejects.toThrow(/data.target/);

    expect(transportWarning("http://homeassistant.local:8123")).toMatch(/unencrypted/);
    expect(transportWarning("http://127.0.0.1:8123")).toBeUndefined();
    expect(transportWarning("https://ha.example.com")).toBeUndefined();
  });

  it("explains expired or invalid tokens", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "401" }, 401) as Response);
    const { executeHomeAssistantToolForTest } = await loadConnector();

    await expect(executeHomeAssistantToolForTest("home-assistant.health", {})).rejects.toThrow(
      /rejected the access token/,
    );
  });

  it("reports a missing URL before making requests", async () => {
    const { executeHomeAssistantToolForTest } = await loadConnector({ HOME_ASSISTANT_URL: "" });

    await expect(
      executeHomeAssistantToolForTest("home-assistant.get_state", { entityId: "light.kitchen" }),
    ).rejects.toThrow(/HOME_ASSISTANT_URL is not configured/);
  });
});
