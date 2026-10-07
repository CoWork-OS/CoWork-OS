import { describe, expect, it } from "vitest";
import { connectorTriggerEvents, connectorTriggerSubscription } from "../connector-trigger-events";
describe("shared connector trigger ingress", () => {
  it("uses identical event fields and event time for connector and GitHub routines", () => {
    const events = connectorTriggerEvents({
      serverId: "s",
      serverName: "GitHub",
      connectorId: "github",
      type: "resource_updated",
      timestamp: 123,
      resourceUri: "r",
      payload: { event: "push", repo: "me/repo", action: "created" },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "connector_event",
      timestamp: 123,
      fields: { connectorId: "github", serverId: "s", resourceUri: "r" },
    });
    expect(events[1]).toMatchObject({
      source: "github_event",
      timestamp: 123,
      fields: { eventName: "push", repository: "me/repo", action: "created" },
    });
  });
  it("does not treat another connector as GitHub and keeps subscription scope", () => {
    expect(
      connectorTriggerEvents({
        serverId: "s",
        serverName: "Drive",
        connectorId: "google",
        type: "resource_updated",
        timestamp: 1,
      }),
    ).toHaveLength(1);
    expect(connectorTriggerSubscription({ source: "channel_message", conditions: [] })).toBeNull();
    expect(
      connectorTriggerSubscription({
        source: "connector_event",
        conditions: [
          { field: "serverId", operator: "equals", value: "s" },
          { field: "resourceUri", operator: "equals", value: "private-resource" },
        ],
      }),
    ).toMatchObject({ serverId: "s", resourceUri: "private-resource" });
  });
});
