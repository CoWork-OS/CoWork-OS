import { describe, expect, it } from "vitest";
import { AgentCardSchema } from "../../pact/upstream/protocol";
import {
  AGENT_CARD_PATH,
  TOOL_HINTS_EXTENSION_URI,
  buildCoworkAgentCard,
  builtInToolHints,
  connectorToolHints,
  modelCostClass,
} from "../agent-card";
import { buildTaskEstimate } from "../task-estimate";

const input = {
  version: "0.5.61",
  skills: [
    {
      id: "pdf-storybook",
      name: "PDF storybook",
      description: "Make a picture book",
      category: "Creative",
    },
    { id: "bare", name: "Bare skill" },
  ],
  mcpServers: [
    {
      id: "jira",
      name: "Jira",
      enabled: true,
      tools: [
        { name: "jira.search_issues", annotations: { readOnlyHint: true } },
        { name: "jira.delete_issue", annotations: { destructiveHint: true } },
        { name: "jira.create_issue", annotations: { destructiveHint: false } },
        { name: "jira.unknown_write" },
      ],
    },
    { id: "off", name: "Disabled", enabled: false, tools: [{ name: "off.tool" }] },
  ],
  model: { provider: "ollama", modelId: "llama3.1" },
};

function hints(card: ReturnType<typeof buildCoworkAgentCard>) {
  const extension = card.capabilities.extensions?.find(
    (entry) => entry.uri === TOOL_HINTS_EXTENSION_URI,
  );
  return extension?.params as Record<string, Any>;
}

describe("CoWork agent card", () => {
  it("is a valid A2A card that strict readers accept, with no A2A interface", () => {
    const card = buildCoworkAgentCard(input);
    expect(AgentCardSchema.strict().safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ name: "CoWork OS", version: "0.5.61", supportedInterfaces: [] });
    expect(card.capabilities.extensions?.[0]).toMatchObject({ required: false });
    expect(AGENT_CARD_PATH).toBe("/.well-known/agent-card.json");
  });

  it("lists skills, falling back to the name for a missing description", () => {
    const card = buildCoworkAgentCard(input);
    expect(card.skills).toEqual([
      {
        id: "pdf-storybook",
        name: "PDF storybook",
        description: "Make a picture book",
        tags: ["Creative"],
      },
      { id: "bare", name: "Bare skill", description: "Bare skill", tags: ["skill"] },
    ]);
  });

  it("describes built-in tools from their risk level", () => {
    const byName = new Map(builtInToolHints().map((hint) => [hint.name, hint]));
    expect(byName.get("read_file")).toEqual({
      name: "read_file",
      readOnly: true,
      destructive: false,
      reversible: true,
      costClass: "local",
    });
    expect(byName.get("delete_file")).toMatchObject({
      readOnly: false,
      destructive: true,
      reversible: false,
    });
    expect(byName.get("write_file")).toMatchObject({ destructive: null, reversible: null });
  });

  it("reports connector tool hints as stated, and only for enabled connectors", () => {
    const [jira, ...rest] = connectorToolHints(input.mcpServers);
    expect(rest).toEqual([]);
    expect(jira.tools).toEqual([
      {
        name: "jira.search_issues",
        readOnly: true,
        destructive: false,
        reversible: true,
        costClass: "external",
      },
      {
        name: "jira.delete_issue",
        readOnly: false,
        destructive: true,
        reversible: false,
        costClass: "external",
      },
      {
        name: "jira.create_issue",
        readOnly: false,
        destructive: false,
        reversible: null,
        costClass: "external",
      },
      {
        name: "jira.unknown_write",
        readOnly: false,
        destructive: null,
        reversible: null,
        costClass: "external",
      },
    ]);
    expect(hints(buildCoworkAgentCard(input)).connectors).toHaveLength(1);
  });

  it("gives the default model's price class", () => {
    expect(modelCostClass({ provider: "ollama", modelId: "llama3.1" })).toEqual({
      class: "local",
      model: "llama3.1",
    });
    expect(modelCostClass({ modelId: "" })).toEqual({ class: "unknown" });
    expect(modelCostClass({ provider: "anthropic", modelId: "no-such-model-xyz" })).toEqual({
      class: "unknown",
      model: "no-such-model-xyz",
    });
  });
});

describe("task estimate", () => {
  it("is a prepared-change summary from history, saying the prompt is not analysed", () => {
    const estimate = buildTaskEstimate({
      prompt: "Draft the Q3 report",
      modelId: "no-such-model-xyz",
      cost: { sampleSize: 12, medianCost: 0.42, p90Cost: 1.3 },
      duration: { sampleSize: 10, medianMs: 6 * 60_000, p90Ms: 75 * 60_000 },
    });
    expect(estimate).toMatchObject({
      kind: "summary",
      estimatedCost: 0.42,
      currency: "USD",
      estimatedDurationMs: 6 * 60_000,
      payload: { basis: "history", costSampleSize: 12, p90Cost: 1.3, promptChars: 19 },
    });
    expect(estimate.summary).toContain("$0.4200");
    expect(estimate.summary).toContain("90% finished within 1 h 15 min");
    expect(estimate.summary).toContain("the prompt itself is not analysed");
  });

  it("says when there is not enough history, and that a local model has no token cost", () => {
    const none = buildTaskEstimate({
      prompt: "x",
      modelId: "no-such-model-xyz",
      cost: null,
      duration: null,
    });
    expect(none.estimatedCost).toBeUndefined();
    expect(none.estimatedDurationMs).toBeUndefined();
    expect(none.summary).toContain("Not enough history");

    const local = buildTaskEstimate({
      prompt: "x",
      modelId: "llama3.1",
      provider: "ollama",
      cost: null,
      duration: null,
    });
    expect(local).toMatchObject({ estimatedCost: 0, currency: "USD" });
    expect(local.summary).toContain("runs locally");
  });
});

describe("Control Plane agent card route", () => {
  it("serves the card only while publishing, GET and HEAD only", async () => {
    let card: unknown = buildCoworkAgentCard(input);
    const { ControlPlaneServer } = await import("../../control-plane/server");
    const server = new ControlPlaneServer({
      token: "test-token",
      port: 0,
      host: "127.0.0.1",
      getAgentCard: () => card,
    });
    try {
      await server.start();
      const url = `http://127.0.0.1:${server.getAddress()?.port}${AGENT_CARD_PATH}`;

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("max-age=300");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({ name: "CoWork OS" });

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      expect((await fetch(url, { method: "POST" })).status).toBe(405);

      card = null;
      expect((await fetch(url)).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
