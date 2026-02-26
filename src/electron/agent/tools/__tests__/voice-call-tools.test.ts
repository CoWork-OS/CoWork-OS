/**
 * Tests for VoiceCallTools - outbound phone calls via ElevenLabs Agents
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { VoiceCallTools } from "../voice-call-tools";
import { VoiceSettingsManager } from "../../../voice/voice-settings-manager";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Test Workspace",
  path: "/tmp",
  createdAt: Date.now(),
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
  },
};

const taskId = "task-123";

const buildDaemon = (approved = true) => ({
  requestApproval: vi.fn().mockResolvedValue(approved),
  logEvent: vi.fn(),
});

let voiceSettingsSpy: ReturnType<typeof vi.spyOn>;
let domainAllowedSpy: ReturnType<typeof vi.spyOn>;
let guardrailSettingsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  voiceSettingsSpy = vi.spyOn(VoiceSettingsManager, "loadSettings");
  domainAllowedSpy = vi.spyOn(GuardrailManager, "isDomainAllowed");
  guardrailSettingsSpy = vi.spyOn(GuardrailManager, "loadSettings");
});

beforeEach(() => {
  vi.clearAllMocks();
  domainAllowedSpy.mockReturnValue(true);
  guardrailSettingsSpy.mockReturnValue({
    allowedDomains: ["api.elevenlabs.io"],
  } as Any);
  voiceSettingsSpy.mockReturnValue({
    // Only fields used by VoiceCallTools
    elevenLabsAgentsApiKey: "xi-test-key",
    elevenLabsAgentId: "agent-123",
    elevenLabsAgentPhoneNumberId: "phone-456",
  } as Any);
});

describe("VoiceCallTools", () => {
  it("initiate_call requests approval and calls ElevenLabs outbound-call endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ conversation_id: "conv-1", callSid: "sid-1" }),
    });

    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    const out = await tools.executeAction({
      action: "initiate_call",
      to_number: "+15555550123",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      expect.stringContaining("+15555550123"),
      expect.objectContaining({ action: "initiate_call" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect(options.method).toBe("POST");
    expect(options.headers["xi-api-key"]).toBe("xi-test-key");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(options.body);
    expect(body).toEqual(
      expect.objectContaining({
        agent_id: "agent-123",
        agent_phone_number_id: "phone-456",
        to_number: "+15555550123",
      }),
    );

    expect(out.success).toBe(true);
    expect(out.action).toBe("initiate_call");
    expect(out.result).toEqual(expect.objectContaining({ conversation_id: "conv-1" }));
  });

  it("initiate_call passes dynamic_variables via conversation_initiation_client_data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ conversation_id: "conv-2" }),
    });

    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    await tools.executeAction({
      action: "initiate_call",
      to_number: "+15555550123",
      dynamic_variables: { briefing: "Hello" },
    });

    const [_url, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.conversation_initiation_client_data).toEqual(
      expect.objectContaining({
        type: "conversation_initiation_client_data",
        dynamic_variables: { briefing: "Hello" },
      }),
    );
  });

  it("list_agents does not request approval", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ agents: [] }),
    });

    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    const out = await tools.executeAction({ action: "list_agents" });

    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.elevenlabs.io/v1/convai/agents");
    expect(out.success).toBe(true);
    expect(out.action).toBe("list_agents");
  });

  it("rejects invalid E.164 to_number", async () => {
    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({
        action: "initiate_call",
        to_number: "15555550123",
      }),
    ).rejects.toThrow(/E\.164/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when approval is denied", async () => {
    const daemon = buildDaemon(false);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    await expect(
      tools.executeAction({
        action: "initiate_call",
        to_number: "+15555550123",
      }),
    ).rejects.toThrow(/denied/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks requests when the domain is not allowed", async () => {
    domainAllowedSpy.mockReturnValue(false);
    guardrailSettingsSpy.mockReturnValue({
      allowedDomains: ["example.com"],
    } as Any);

    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    await expect(tools.executeAction({ action: "list_agents" })).rejects.toThrow(
      /Domain not allowed/i,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("redacts secret-looking fields from upstream results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          conversation_id: "conv-3",
          api_key: "xi-should-not-leak",
          nested: { access_token: "secret-token", token_count: 3 },
        }),
    });

    const daemon = buildDaemon(true);
    const tools = new VoiceCallTools(workspace, daemon as Any, taskId);

    const out = await tools.executeAction({
      action: "initiate_call",
      to_number: "+15555550123",
    });

    expect(out.result.conversation_id).toBe("conv-3");
    expect(out.result.api_key).toBe("[REDACTED]");
    expect(out.result.nested.access_token).toBe("[REDACTED]");
    expect(out.result.nested.token_count).toBe(3);
  });
});
