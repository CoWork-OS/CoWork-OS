import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { ConnectorClient } from "botframework-connector";
import { createTeamsDecisionHttpClient } from "../channels/teams-decision-http";

describe("installed Teams connector retry boundary", () => {
  it.each(["server-error", "connection-reset"])(
    "sends only once after %s in the real SDK",
    async (failure) => {
      let requests = 0;
      const server = createServer((_req, res) => {
        requests++;
        if (failure === "connection-reset") {
          res.destroy();
          return;
        }
        res.writeHead(503, { "retry-after": "0", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture ambiguous publication" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      try {
        const client = new ConnectorClient(
          { signRequest: async (request: Any) => request },
          {
            baseUri: `http://127.0.0.1:${address.port}`,
            noRetryPolicy: true,
            httpClient: createTeamsDecisionHttpClient(),
          },
        );
        await expect(
          client.conversations.sendToConversation("fixture", { type: "message", text: "fixture" }),
        ).rejects.toThrow();
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it("returns the server's message ID through the real connector", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "published-card" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    try {
      const client = new ConnectorClient(
        { signRequest: async (request: Any) => request },
        {
          baseUri: `http://127.0.0.1:${address.port}`,
          httpClient: createTeamsDecisionHttpClient(),
        },
      );
      expect(
        await client.conversations.sendToConversation("fixture", {
          type: "message",
          text: "fixture",
        }),
      ).toEqual({ id: "published-card" });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
