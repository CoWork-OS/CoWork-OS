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
  it("names the PR or issue thread of a GitHub event for thread subscriptions", () => {
    const [, prComment] = connectorTriggerEvents({
      serverId: "s",
      serverName: "GitHub",
      connectorId: "github",
      type: "resource_updated",
      timestamp: 5,
      payload: {
        event: "issue_comment",
        repository: "me/repo",
        issue: { number: 9, pull_request: { url: "u" } },
      },
    });
    expect(prComment.fields.threadKey).toBe("github:me/repo:pr:9");
    const [, push] = connectorTriggerEvents({
      serverId: "s",
      serverName: "GitHub",
      connectorId: "github",
      type: "resource_updated",
      timestamp: 6,
      payload: { event: "push", repo: "me/repo" },
    });
    expect(push.fields).not.toHaveProperty("threadKey");
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
