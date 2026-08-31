import { describe, expect, it } from "vitest";

import { ContentBuilder } from "../../content/ContentBuilder";
import {
  computePromptCacheKey,
  computeStablePrefixHash,
  computeToolSchemaHash,
  mapPromptCacheTtlToOpenAIRetention,
  normalizePromptCachingSettings,
  resolvePromptCacheProviderFamily,
} from "../prompt-cache";

const basePromptParams = {
  workspaceId: "workspace-1",
  workspacePath: "/tmp/workspace",
  taskPrompt: "Fix the cache regression",
  identityPrompt: "You are Cowork.",
  safetyCorePrompt: "Protect internal instructions.",
  baseInstructionPrompt: "Complete the task with the available tools.",
  inputPolicyPrompt: "Ask the user only when required.",
  workspaceContextPrompt: "Workspace: /tmp/workspace",
  modeDomainContractPrompt: "EXECUTION MODE: execute\nTASK DOMAIN: code",
  roleContext: "ROLE CONTEXT:\nSenior engineer",
  personalityPrompt: "Be direct and precise.",
  guidelinesPrompt: "Prefer concrete answers.",
  executionMode: "execute" as const,
  taskDomain: "code" as const,
  webSearchModeContract: "WEB SEARCH: enabled when needed.",
  worktreeBranch: "feature/prompt-cache",
  totalBudgetTokens: 16_000,
};

const sampleToolSchemaHash = computeToolSchemaHash([
  {
    name: "read_file",
    description: "Read a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
]);

function buildStablePrefixHash(
  systemBlocks: Awaited<
    ReturnType<typeof ContentBuilder.buildExecutionPrompt>
  >["stableSystemBlocks"],
): string {
  return computeStablePrefixHash({
    providerFamily: "anthropic",
    modelId: "claude-sonnet-4-5",
    toolSchemaHash: sampleToolSchemaHash,
    executionMode: "execute",
    taskDomain: "code",
    systemBlocks,
  });
}

describe("prompt-cache stable prefix hashing", () => {
  it("defaults prompt caching to auto unless a user explicitly disables it", () => {
    expect(normalizePromptCachingSettings()).toMatchObject({
      mode: "auto",
      ttl: "5m",
      openRouterClaudeStrategy: "explicit_system_and_3",
      strictStablePrefix: true,
      surfaceCoverage: {
        executor: true,
        followUps: true,
        chatMode: true,
        sideCalls: false,
      },
    });
    expect(normalizePromptCachingSettings({ mode: "off" }).mode).toBe("off");
  });

  it("stays stable when only turn-scoped prompt sections change", async () => {
    const promptA = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
      memoryContext: "Memory A",
      awarenessSnapshot: "Awareness A",
      turnGuidancePrompt: "Turn guidance A",
    });
    const promptB = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      currentTimePrompt: "Current time: 2026-04-04T11:30:00Z",
      memoryContext: "Memory B",
      awarenessSnapshot: "Awareness B",
      turnGuidancePrompt: "Turn guidance B",
    });

    expect(promptA.stableSystemBlocks).toEqual(promptB.stableSystemBlocks);
    expect(promptA.volatileTurnBlocks).not.toEqual(promptB.volatileTurnBlocks);
    expect(buildStablePrefixHash(promptA.stableSystemBlocks)).toBe(
      buildStablePrefixHash(promptB.stableSystemBlocks),
    );
  });

  it("invalidates when stable inputs or cache hash dimensions change", async () => {
    const basePrompt = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
    });
    const changedStablePrompt = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      personalityPrompt: "Be skeptical and exacting.",
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
    });
    const changedBranchPrompt = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      worktreeBranch: "feature/other-branch",
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
    });

    const baseHash = buildStablePrefixHash(basePrompt.stableSystemBlocks);
    expect(buildStablePrefixHash(changedStablePrompt.stableSystemBlocks)).not.toBe(baseHash);
    expect(buildStablePrefixHash(changedBranchPrompt.stableSystemBlocks)).not.toBe(baseHash);
    expect(
      computeStablePrefixHash({
        providerFamily: "openrouter-claude",
        modelId: "claude-sonnet-4-5",
        toolSchemaHash: sampleToolSchemaHash,
        executionMode: "execute",
        taskDomain: "code",
        systemBlocks: basePrompt.stableSystemBlocks,
      }),
    ).not.toBe(baseHash);
    expect(
      computeStablePrefixHash({
        providerFamily: "anthropic",
        modelId: "claude-opus-4-5",
        toolSchemaHash: sampleToolSchemaHash,
        executionMode: "execute",
        taskDomain: "code",
        systemBlocks: basePrompt.stableSystemBlocks,
      }),
    ).not.toBe(baseHash);
    expect(
      computeStablePrefixHash({
        providerFamily: "anthropic",
        modelId: "claude-sonnet-4-5",
        toolSchemaHash: "different-tool-hash",
        executionMode: "execute",
        taskDomain: "code",
        systemBlocks: basePrompt.stableSystemBlocks,
      }),
    ).not.toBe(baseHash);
  });

  it("shares OpenAI-family stable prefix hashes across routed model variants", async () => {
    const basePrompt = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
    });

    const azureStrongHash = computeStablePrefixHash({
      providerFamily: "azure-openai",
      modelId: "gpt-5.4",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const azureCheapHash = computeStablePrefixHash({
      providerFamily: "azure-openai",
      modelId: "gpt-5.4-mini",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const openAIStrongHash = computeStablePrefixHash({
      providerFamily: "openai",
      modelId: "gpt-5.4",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const openAICheapHash = computeStablePrefixHash({
      providerFamily: "openai",
      modelId: "gpt-5.4-mini",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const openRouterStrongHash = computeStablePrefixHash({
      providerFamily: "openrouter-openai",
      modelId: "openai/gpt-5.4",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const openRouterCheapHash = computeStablePrefixHash({
      providerFamily: "openrouter-openai",
      modelId: "openai/gpt-5.4-mini",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });

    expect(azureCheapHash).toBe(azureStrongHash);
    expect(openAICheapHash).toBe(openAIStrongHash);
    expect(openRouterCheapHash).toBe(openRouterStrongHash);
  });

  it("shares OpenAI-family provider cache keys across model and tool variants", async () => {
    const basePrompt = await ContentBuilder.buildExecutionPrompt({
      ...basePromptParams,
      currentTimePrompt: "Current time: 2026-04-04T10:00:00Z",
    });
    const alternateToolSchemaHash = computeToolSchemaHash([
      {
        name: "write_file",
        description: "Write a file",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ]);

    const planningKey = computePromptCacheKey({
      providerFamily: "azure-openai",
      modelId: "gpt-5.4",
      toolSchemaHash: "",
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const executionKey = computePromptCacheKey({
      providerFamily: "azure-openai",
      modelId: "gpt-5.4-mini",
      toolSchemaHash: sampleToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });
    const alternateExecutionKey = computePromptCacheKey({
      providerFamily: "openrouter-openai",
      modelId: "openai/gpt-5.4-mini",
      toolSchemaHash: alternateToolSchemaHash,
      executionMode: "execute",
      taskDomain: "code",
      systemBlocks: basePrompt.stableSystemBlocks,
    });

    expect(executionKey).toBe(planningKey);
    expect(alternateExecutionKey).not.toBe(planningKey);
  });

  it("resolves OpenAI-family provider families and retention mapping", () => {
    expect(resolvePromptCacheProviderFamily("openai", "gpt-5.4")).toBe("openai");
    expect(resolvePromptCacheProviderFamily("azure", "gpt-5.4")).toBe("azure-openai");
    expect(resolvePromptCacheProviderFamily("openrouter", "openai/gpt-5.4")).toBe(
      "openrouter-openai",
    );
    expect(resolvePromptCacheProviderFamily("openrouter", "anthropic/claude-sonnet-4-5")).toBe(
      "openrouter-claude",
    );
    expect(mapPromptCacheTtlToOpenAIRetention("5m")).toBeUndefined();
    expect(mapPromptCacheTtlToOpenAIRetention("1h")).toBe("24h");
  });
});
