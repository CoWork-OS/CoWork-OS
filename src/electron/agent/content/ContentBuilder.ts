import {
  SHARED_PROMPT_POLICY_CORE,
  buildModeDomainContract,
  composePromptSections,
  hashPromptSectionInput,
  resolvePromptSections,
  type PromptSection,
} from "../executor-prompt-sections";
import type { LLMSystemBlock } from "../llm";
import type { ExecutionMode, TaskDomain } from "../../../shared/types";
import { LayeredMemoryIndexService } from "../../memory/LayeredMemoryIndexService";

export interface BuildExecutionPromptParams {
  workspaceId: string;
  workspacePath: string;
  taskPrompt: string;
  identityPrompt?: string;
  safetyCorePrompt?: string;
  baseInstructionPrompt?: string;
  inputPolicyPrompt?: string;
  workspaceContextPrompt?: string;
  currentTimePrompt?: string;
  modeDomainContractPrompt?: string;
  roleContext?: string;
  memoryContext?: string;
  awarenessSnapshot?: string;
  infraContext?: string;
  visualQAContext?: string;
  personalityPrompt?: string;
  guidelinesPrompt?: string;
  completionGuidancePrompt?: string;
  turnGuidancePrompt?: string;
  turnGuidanceMaxTokens?: number;
  coreInstructions?: string;
  executionMode: ExecutionMode;
  taskDomain: TaskDomain;
  webSearchModeContract: string;
  worktreeBranch?: string;
  allowLayeredMemory?: boolean;
  totalBudgetTokens: number;
  sectionCache?: Map<string, string | null>;
}

export interface BuildExecutionPromptResult {
  prompt: string;
  systemBlocks: LLMSystemBlock[];
  stableSystemBlocks: LLMSystemBlock[];
  volatileTurnBlocks: LLMSystemBlock[];
  totalTokens: number;
  droppedSections: string[];
  truncatedSections: string[];
  topicCount: number;
  memoryIndexInjected: boolean;
}

function toSystemBlock(section: PromptSection): LLMSystemBlock | null {
  const text = String(section.text || "").trim();
  if (!text) return null;
  const scope = section.cacheScope || "none";
  return {
    text,
    scope,
    cacheable: scope === "session",
    stableKey: `${section.key}:${section.stableInputHash || hashPromptSectionInput(text)}`,
  };
}

function makeSection(
  key: string,
  text: string | undefined,
  maxTokens: number | undefined,
  options?: {
    required?: boolean;
    dropPriority?: number;
    layerKind?: PromptSection["layerKind"];
    cacheScope?: PromptSection["cacheScope"];
    stableInputHash?: string;
  },
): PromptSection {
  const normalized = String(text || "").trim();
  return {
    key,
    text: normalized,
    maxTokens,
    required: options?.required,
    dropPriority: options?.dropPriority,
    layerKind: options?.layerKind,
    cacheScope: options?.cacheScope,
    stableInputHash:
      options?.stableInputHash || (options?.cacheScope === "session" ? hashPromptSectionInput(normalized) : undefined),
  };
}

export class ContentBuilder {
  static async buildExecutionPrompt(
    params: BuildExecutionPromptParams,
  ): Promise<BuildExecutionPromptResult> {
    let memoryIndex = "";
    let topicText = "";
    let topicCount = 0;

    if (params.allowLayeredMemory) {
      const snapshot = await LayeredMemoryIndexService.refreshIndex({
        workspaceId: params.workspaceId,
        workspacePath: params.workspacePath,
        taskPrompt: params.taskPrompt,
      });
      memoryIndex = snapshot.indexContent;
      topicCount = snapshot.topics.length;
      if (snapshot.topics.length > 0) {
        topicText = snapshot.topics
          .slice(0, 3)
          .map((topic) => `### ${topic.title}\n${topic.content}`)
          .join("\n\n");
      }
    }

    const modeDomainContract =
      params.modeDomainContractPrompt ||
      buildModeDomainContract(params.executionMode, params.taskDomain);
    const worktreeContext = params.worktreeBranch
      ? `GIT WORKTREE CONTEXT:\n- Active branch: "${params.worktreeBranch}".\n- Changes stay isolated until explicitly merged.`
      : "";

    const useLegacyContract =
      typeof params.coreInstructions === "string" &&
      !params.baseInstructionPrompt &&
      !params.inputPolicyPrompt &&
      !params.workspaceContextPrompt &&
      !params.currentTimePrompt &&
      !params.turnGuidancePrompt &&
      !params.modeDomainContractPrompt &&
      !params.safetyCorePrompt;

    const sections: PromptSection[] = useLegacyContract
      ? [
          makeSection("identity", params.identityPrompt, undefined, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("role_context", params.roleContext, 900, {
            required: false,
            dropPriority: 2,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("memory_index", memoryIndex, 1300, {
            required: params.allowLayeredMemory,
            layerKind: params.allowLayeredMemory ? "always" : "optional",
            cacheScope: "turn",
          }),
          makeSection("memory_topics", topicText, 1000, {
            required: false,
            dropPriority: 4,
            layerKind: "on_demand",
            cacheScope: "turn",
          }),
          makeSection("memory_context", params.memoryContext, 1200, {
            required: false,
            dropPriority: 5,
            layerKind: "optional",
            cacheScope: "turn",
          }),
          makeSection("awareness_snapshot", params.awarenessSnapshot, 800, {
            required: false,
            dropPriority: 6,
            layerKind: "optional",
            cacheScope: "turn",
          }),
          makeSection("infra_context", params.infraContext, 800, {
            required: false,
            dropPriority: 3,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("visual_qa", params.visualQAContext, 500, {
            required: false,
            dropPriority: 7,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("personality", params.personalityPrompt, 700, {
            required: false,
            dropPriority: 8,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("guidelines", params.guidelinesPrompt, 700, {
            required: false,
            dropPriority: 9,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("execution_contract", params.coreInstructions, undefined, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
        ]
      : [
          makeSection("identity", params.identityPrompt, undefined, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection(
            "safety_core",
            params.safetyCorePrompt || SHARED_PROMPT_POLICY_CORE,
            920,
            {
              required: true,
              layerKind: "always",
              cacheScope: "session",
            },
          ),
          makeSection("base_instruction", params.baseInstructionPrompt, 1800, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("input_policy", params.inputPolicyPrompt, 600, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("current_time", params.currentTimePrompt, 120, {
            required: true,
            layerKind: "always",
            cacheScope: "turn",
          }),
          makeSection(
            "workspace_context",
            [params.workspaceContextPrompt, worktreeContext].filter(Boolean).join("\n\n"),
            420,
            {
              required: true,
              layerKind: "always",
              cacheScope: "session",
            },
          ),
          makeSection("mode_domain", modeDomainContract, 300, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("web_search_contract", params.webSearchModeContract, 260, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("completion_guidance", params.completionGuidancePrompt, 500, {
            required: false,
            dropPriority: 1,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("role_context", params.roleContext, 900, {
            required: false,
            dropPriority: 2,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("memory_index", memoryIndex, 1300, {
            required: params.allowLayeredMemory,
            layerKind: params.allowLayeredMemory ? "always" : "optional",
            cacheScope: "turn",
          }),
          makeSection("memory_topics", topicText, 1000, {
            required: false,
            dropPriority: 4,
            layerKind: "on_demand",
            cacheScope: "turn",
          }),
          makeSection("memory_context", params.memoryContext, 1200, {
            required: false,
            dropPriority: 5,
            layerKind: "optional",
            cacheScope: "turn",
          }),
          makeSection("awareness_snapshot", params.awarenessSnapshot, 800, {
            required: false,
            dropPriority: 6,
            layerKind: "optional",
            cacheScope: "turn",
          }),
          makeSection("infra_context", params.infraContext, 800, {
            required: false,
            dropPriority: 3,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("visual_qa", params.visualQAContext, 500, {
            required: false,
            dropPriority: 7,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("personality", params.personalityPrompt, 700, {
            required: false,
            dropPriority: 8,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("guidelines", params.guidelinesPrompt, 700, {
            required: false,
            dropPriority: 9,
            layerKind: "optional",
            cacheScope: "session",
          }),
          makeSection("turn_guidance", params.turnGuidancePrompt, params.turnGuidanceMaxTokens ?? 1100, {
            required: false,
            dropPriority: 10,
            layerKind: "optional",
            cacheScope: "turn",
          }),
        ];

    const resolvedSections = await resolvePromptSections(sections, params.sectionCache);
    const composed = composePromptSections(resolvedSections, params.totalBudgetTokens);
    const systemBlocks = composed.sections
      .map((section) => toSystemBlock(section))
      .filter((block): block is LLMSystemBlock => Boolean(block));
    const stableSystemBlocks = systemBlocks.filter(
      (block) => block.scope === "session" && block.cacheable,
    );
    const volatileTurnBlocks = systemBlocks.filter((block) => block.scope !== "session");
    return {
      prompt: composed.prompt,
      systemBlocks,
      stableSystemBlocks,
      volatileTurnBlocks,
      totalTokens: composed.totalTokens,
      droppedSections: composed.droppedSections,
      truncatedSections: composed.truncatedSections,
      topicCount,
      memoryIndexInjected: Boolean(memoryIndex),
    };
  }
}
