import { AgentCardSchema, type AgentCard } from "../pact/upstream/protocol";
import { TOOL_RISK_LEVELS, type ToolRiskLevel } from "../../shared/types";
import { getModelPricing } from "../agent/llm/pricing";

/**
 * CoWork's own agent card (WP16): an A2A 1.0 card that says what this CoWork can do (its
 * skills) and how its tools behave, so another agent or an admin can see it before handing it
 * work. It lists no A2A interface: CoWork does not take tasks over A2A. Tool behaviour goes in
 * an optional extension, which strict card readers (PACT) accept.
 */

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const TOOL_HINTS_EXTENSION_URI = "urn:cowork-os:agent-card:tool-hints:v1";

/** How much a tool call costs on its own, apart from the model's tokens. */
export type ToolCostClass = "local" | "network" | "external";

export interface AgentCardToolHint {
  name: string;
  readOnly: boolean;
  /** True or false when known; null when the tool does not say. */
  destructive: boolean | null;
  /** True for tools that change nothing; false for destructive ones; null when unknown. */
  reversible: boolean | null;
  costClass: ToolCostClass;
}

export interface AgentCardConnector {
  id: string;
  name: string;
  tools: AgentCardToolHint[];
}

export interface AgentCardSkillInput {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

export interface AgentCardMcpServerInput {
  id: string;
  name: string;
  enabled: boolean;
  tools?: Array<{
    name: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
}

export interface AgentCardInput {
  name?: string;
  version: string;
  skills: AgentCardSkillInput[];
  mcpServers: AgentCardMcpServerInput[];
  /** The model tasks run on by default. */
  model?: { provider?: string | null; modelId?: string | null };
}

const MAX_SKILLS = 200;
const MAX_TEXT = 500;

function clip(text: string | undefined, max = MAX_TEXT): string {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function hintFromRisk(name: string, risk: ToolRiskLevel): AgentCardToolHint {
  const readOnly = risk === "read";
  const destructive = risk === "destructive" ? true : readOnly ? false : null;
  return {
    name,
    readOnly,
    destructive,
    reversible: readOnly ? true : destructive ? false : null,
    costClass: risk === "network" ? "network" : "local",
  };
}

/** Built-in tools with their risk level as CoWork's policy engine sees it. */
export function builtInToolHints(): AgentCardToolHint[] {
  return Object.entries(TOOL_RISK_LEVELS)
    .map(([name, risk]) => hintFromRisk(name, risk as ToolRiskLevel))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * MCP connector tools, from the hints their servers publish. Per the MCP spec a tool that is
 * not read-only may be destructive unless it says otherwise; CoWork reports what is stated.
 */
export function connectorToolHints(servers: AgentCardMcpServerInput[]): AgentCardConnector[] {
  return servers
    .filter((server) => server.enabled)
    .map((server) => ({
      id: server.id,
      name: clip(server.name, 120),
      tools: (server.tools ?? []).map((tool) => {
        const readOnly = tool.annotations?.readOnlyHint === true;
        const destructive =
          typeof tool.annotations?.destructiveHint === "boolean"
            ? tool.annotations.destructiveHint && !readOnly
            : readOnly
              ? false
              : null;
        return {
          name: tool.name,
          readOnly,
          destructive,
          reversible: readOnly ? true : destructive ? false : null,
          costClass: "external" as const,
        };
      }),
    }));
}

/** The default model's price class: local (no per-token price), metered, or unknown. */
export function modelCostClass(model: AgentCardInput["model"]): Record<string, unknown> {
  const modelId = String(model?.modelId || "").trim();
  if (!modelId) return { class: "unknown" };
  const pricing = getModelPricing(modelId, model?.provider ?? null);
  if (!pricing) return { class: "unknown", model: modelId };
  if (pricing.inputPer1M === 0 && pricing.outputPer1M === 0) {
    return { class: "local", model: modelId };
  }
  return {
    class: "metered",
    model: modelId,
    currency: "USD",
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
  };
}

export function buildCoworkAgentCard(input: AgentCardInput): AgentCard {
  const card: AgentCard = {
    name: clip(input.name || "CoWork OS", 120),
    description:
      "A local-first AI coworker running on its user's machine. This card lists its skills and how its tools behave; it does not take tasks over A2A.",
    supportedInterfaces: [],
    version: clip(input.version, 60) || "0.0.0",
    documentationUrl: "https://github.com/CoWork-OS/CoWork-OS",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: TOOL_HINTS_EXTENSION_URI,
          description:
            "How CoWork's tools behave: readOnly, destructive (null when not stated) and reversible (null when unknown) per tool, the cost class of each tool call, and the default model's price.",
          required: false,
          params: {
            builtInTools: builtInToolHints(),
            connectors: connectorToolHints(input.mcpServers),
            model: modelCostClass(input.model),
          },
        },
      ],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: input.skills.slice(0, MAX_SKILLS).map((skill) => ({
      id: clip(skill.id, 120),
      name: clip(skill.name, 120),
      description: clip(skill.description) || clip(skill.name, 120),
      tags: [clip(skill.category, 60) || "skill"],
    })),
  };
  return AgentCardSchema.parse(card);
}
