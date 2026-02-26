import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { VoiceSettingsManager } from "../../voice/voice-settings-manager";
import { GuardrailManager } from "../../guardrails/guardrail-manager";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const REDACTED_VALUE = "[REDACTED]";

type VoiceCallAction = "list_agents" | "list_phone_numbers" | "initiate_call";

export interface VoiceCallActionInput {
  action: VoiceCallAction;

  // initiate_call
  to_number?: string;
  agent_id?: string;
  agent_phone_number_id?: string;

  // Optional initiation data
  dynamic_variables?: Record<string, unknown>;
  conversation_config_override?: Record<string, unknown>;
  prompt?: string;
  first_message?: string;
  conversation_initiation_client_data?: Record<string, unknown>;

  // list_* pagination (if supported by API)
  cursor?: string;
  page_size?: number;
  include_archived?: boolean;
}

export class VoiceCallTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Tool results are persisted in task logs for debugging and memory capture.
   * Redact secret-looking fields defensively in case upstream APIs echo tokens.
   */
  private static isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    if (k.includes("password") || k.includes("passwd")) return true;
    if (k.includes("secret")) return true;
    if (k.includes("authorization")) return true;
    if (k.includes("cookie")) return true;
    if (k.includes("api_key") || k.includes("api-key") || k.includes("apikey")) return true;
    if (k === "token" || k.endsWith("_token") || k.endsWith("-token") || k.endsWith("token"))
      return true;
    if (k.includes("private_key") || k.includes("private-key") || k.endsWith("privatekey"))
      return true;
    return false;
  }

  private redactSensitive(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (depth > 12) return "[TRUNCATED]";
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (seen.has(value as object)) return "[CIRCULAR]";
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactSensitive(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = VoiceCallTools.isSensitiveKey(key)
        ? REDACTED_VALUE
        : this.redactSensitive(child, depth + 1, seen);
    }
    return out;
  }

  private getApiKey(): string {
    const settings = VoiceSettingsManager.loadSettings();
    const key = (settings.elevenLabsAgentsApiKey || settings.elevenLabsApiKey || "").trim();
    if (!key) {
      throw new Error(
        "ElevenLabs API key not configured. " +
          "Set it in Settings > Voice > Phone Calls (Agents API Key) or in the ElevenLabs TTS configuration.",
      );
    }
    return key;
  }

  private ensureDomainAllowed(url: string): void {
    if (GuardrailManager.isDomainAllowed(url)) return;
    const settings = GuardrailManager.loadSettings();
    const allowedDomainsStr =
      settings.allowedDomains.length > 0 ? settings.allowedDomains.join(", ") : "(none configured)";
    throw new Error(
      `Domain not allowed: "${url}"\n` +
        `Allowed domains: ${allowedDomainsStr}\n` +
        `You can modify allowed domains in Settings > Guardrails.`,
    );
  }

  private async requestApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied phone call");
    }
  }

  private buildConversationInitiationClientData(
    input: VoiceCallActionInput,
  ): Record<string, unknown> | undefined {
    if (input.conversation_initiation_client_data) {
      return input.conversation_initiation_client_data;
    }

    const hasAny =
      input.dynamic_variables ||
      input.conversation_config_override ||
      input.prompt ||
      input.first_message;

    if (!hasAny) return undefined;

    const out: Record<string, unknown> = {
      type: "conversation_initiation_client_data",
    };

    if (input.dynamic_variables && Object.keys(input.dynamic_variables).length > 0) {
      out.dynamic_variables = input.dynamic_variables;
    }

    const override: Record<string, Any> = input.conversation_config_override
      ? { ...input.conversation_config_override }
      : {};

    if (input.prompt) {
      override.agent = typeof override.agent === "object" && override.agent ? override.agent : {};
      override.agent.prompt =
        typeof override.agent.prompt === "object" && override.agent.prompt
          ? override.agent.prompt
          : {};
      override.agent.prompt.prompt = input.prompt;
    }

    if (input.first_message) {
      override.agent = typeof override.agent === "object" && override.agent ? override.agent : {};
      override.agent.first_message = input.first_message;
    }

    if (Object.keys(override).length > 0) {
      out.conversation_config_override = override;
    }

    return out;
  }

  private async elevenLabsRequest(params: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
  }): Promise<Any> {
    const apiKey = this.getApiKey();
    const url = new URL(`${ELEVENLABS_API_BASE}${params.path}`);

    for (const [key, value] of Object.entries(params.query || {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    this.ensureDomainAllowed(url.toString());

    const response = await fetch(url.toString(), {
      method: params.method,
      headers: {
        "xi-api-key": apiKey,
        ...(params.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    const raw = await response.text();

    if (!response.ok) {
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as Any;
        message = parsed?.detail || parsed?.message || parsed?.error || raw;
      } catch {
        // Keep raw text
      }
      throw new Error(
        `ElevenLabs request failed (${response.status} ${response.statusText}): ${message}`,
      );
    }

    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  async executeAction(input: VoiceCallActionInput): Promise<Any> {
    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    const settings = VoiceSettingsManager.loadSettings();

    let result: Any;

    switch (action) {
      case "list_agents": {
        result = await this.elevenLabsRequest({
          method: "GET",
          path: "/convai/agents",
          query: {
            cursor: input.cursor,
            page_size: input.page_size,
            include_archived: input.include_archived,
          },
        });
        break;
      }
      case "list_phone_numbers": {
        result = await this.elevenLabsRequest({
          method: "GET",
          path: "/convai/phone-numbers",
          query: {
            cursor: input.cursor,
            page_size: input.page_size,
            include_archived: input.include_archived,
          },
        });
        break;
      }
      case "initiate_call": {
        const toNumber = (input.to_number || "").trim();
        if (!toNumber) {
          throw new Error("Missing to_number for initiate_call");
        }
        if (!E164_REGEX.test(toNumber)) {
          throw new Error(
            `Invalid to_number: "${toNumber}". Use E.164 format (example: "+15555550123").`,
          );
        }

        const agentId = (input.agent_id || settings.elevenLabsAgentId || "").trim();
        const agentPhoneNumberId = (
          input.agent_phone_number_id ||
          settings.elevenLabsAgentPhoneNumberId ||
          ""
        ).trim();

        if (!agentId) {
          throw new Error(
            "Missing agent_id. Set a default Agent ID in Settings > Voice > Phone Calls, or pass agent_id in the tool call.",
          );
        }
        if (!agentPhoneNumberId) {
          throw new Error(
            "Missing agent_phone_number_id. Set a default Outbound Phone Number ID in Settings > Voice > Phone Calls, or pass agent_phone_number_id in the tool call.",
          );
        }

        const initiationClientData = this.buildConversationInitiationClientData(input);

        await this.requestApproval(`Place an outbound phone call to ${toNumber}`, {
          action: "initiate_call",
          to_number: toNumber,
          agent_id: agentId,
          agent_phone_number_id: agentPhoneNumberId,
          has_client_data: !!initiationClientData,
        });

        result = await this.elevenLabsRequest({
          method: "POST",
          path: "/convai/twilio/outbound-call",
          body: {
            agent_id: agentId,
            agent_phone_number_id: agentPhoneNumberId,
            to_number: toNumber,
            ...(initiationClientData
              ? { conversation_initiation_client_data: initiationClientData }
              : {}),
          },
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "voice_call",
      action,
      hasData: !!result,
    });

    return {
      success: true,
      action,
      result: this.redactSensitive(result),
    };
  }
}
