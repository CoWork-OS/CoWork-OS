import type { MCPConnectorEvent } from "../mcp/client/MCPServerConnection";
import type { EventTrigger, TriggerEvent } from "../triggers/types";
export function connectorTriggerSubscription(trigger: Pick<EventTrigger, "source" | "conditions">) {
  if (trigger.source !== "connector_event") return null;
  const value = (...fields: string[]) =>
    fields
      .map((field) => trigger.conditions.find((condition) => condition.field === field)?.value)
      .find(Boolean);
  return {
    serverId: value("serverId"),
    connectorId: value("connectorId", "source"),
    resourceUri: value("resourceUri"),
  };
}
export function connectorTriggerEvents(event: MCPConnectorEvent): TriggerEvent[] {
  const payload = JSON.stringify(event.payload || {});
  const events: TriggerEvent[] = [
    {
      source: "connector_event",
      timestamp: event.timestamp,
      fields: {
        type: event.type,
        changeType: event.type,
        serverId: event.serverId,
        connectorId: event.connectorId || "",
        serverName: event.serverName,
        source: event.connectorId || event.serverName,
        resourceUri: event.resourceUri || "",
        data: payload,
        payload,
      },
    },
  ];
  if ((event.connectorId || "").trim().toLowerCase() === "github") {
    const fields = event.payload || {};
    const text = (...keys: string[]) =>
      keys.map((key) => fields[key]).find((value) => typeof value === "string") as
        | string
        | undefined;
    events.push({
      source: "github_event",
      timestamp: event.timestamp,
      fields: {
        connectorId: "github",
        eventName: text("eventName", "event") || "",
        action: text("action") || "",
        repository: text("repository", "repo") || "",
        ref: text("ref") || "",
        resourceUri: event.resourceUri || "",
        payload,
      },
    });
  }
  return events;
}
