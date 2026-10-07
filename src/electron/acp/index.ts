/**
 * Agent Client Protocol (ACP)
 *
 * Enables agent-to-agent communication over the Control Plane WebSocket.
 * Complements MCP (Model Context Protocol) which handles agent-to-tool
 * communication.
 *
 * ACP provides:
 * - Agent discovery (acp.discover)
 * - Agent registration for remote agents (acp.agent.register)
 * - Inter-agent messaging (acp.message.send / acp.message.list)
 * - Task delegation between agents (acp.task.create / acp.task.get)
 */

export { registerACPMethods, getACPRegistry, shutdownACP, type ACPHandlerDeps } from "./handler";
export { ACPAgentRegistry } from "./agent-registry";
export { redactAcpControlPlanePayload, toPublicAgentCard } from "./remote-agent-secrets";
export {
  type ACPAgentCard,
  type ACPCapability,
  type ACPMessage,
  type ACPTask,
  type ACPDiscoverParams,
  type ACPAgentRegisterParams,
  type ACPMessageSendParams,
  type ACPTaskCreateParams,
  ACPEvents,
  ACPMethods,
} from "./types";
