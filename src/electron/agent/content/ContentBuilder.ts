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
import {
  DESIGN_SYSTEM_MIN_TOKENS,
  DESIGN_SYSTEM_SECTION_TOKENS,
  EXTERNAL_MEMORY_SECTION_TOKENS,
  MEMORY_CONTEXT_MIN_TOKENS,
  MEMORY_CONTEXT_SECTION_TOKENS,
  PROJECT_GUIDANCE_MIN_TOKENS,
  PROJECT_GUIDANCE_SECTION_TOKENS,
  TRANSCRIPT_CONTEXT_SECTION_TOKENS,
} from "./prompt-budgets";

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
  /** Engineering workflow guidance for tasks that edit code (session-scoped). */
  codingWorkflowPrompt?: string;
  /** Strategy contracts that apply to this task (deep work, debug, image, workflow). */
  taskStrategyPrompt?: string;
  roleContext?: string;
  /** Synthesized memory (kit + hot memory + structured memory); capped at the synthesizer budget. */
  memoryContext?: string;
  /** Workspace DESIGN.md guidance for UI tasks. */
  designSystemContext?: string;
  /** Repo-root project instructions (AGENTS.md / CLAUDE.md) and docs map files. */
  projectGuidanceContext?: string;
  /** External memory provider context (Supermemory). */
  externalMemoryContext?: string;
  /** Transcript span hits from the query orchestrator. */
  transcriptContext?: string;
  awarenessSnapshot?: string;
  infraContext?: string;
  /** Volatile infra status (wallet balance); turn-scoped so it cannot bust the cache. */
  infraStatusPrompt?: string;
  visualQAContext?: string;
  personalityPrompt?: string;
  guidelinesPrompt?: string;
  completionGuidancePrompt?: string;
  turnGuidancePrompt?: string;
  turnGuidanceMaxTokens?: number;
  /** Keep turn-specific protocol text (for example the planner JSON contract) non-droppable. */
  turnGuidanceRequired?: boolean;
  coreInstructions?: string;
  executionMode: ExecutionMode;
  taskDomain: TaskDomain;
  webSearchModeContract: string;
  worktreeBranch?: string;
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
    truncation?: PromptSection["truncation"];
    minTokens?: number;
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
    truncation: options?.truncation,
    minTokens: options?.minTokens,
    stableInputHash:
      options?.stableInputHash ||
      (options?.cacheScope === "session" ? hashPromptSectionInput(normalized) : undefined),
  };
}

/**
 * Memory-related sections. Each source has its own budget so one source cannot
 * crowd out another, and all of them truncate on fragment boundaries.
 * Drop order when the total budget overflows (first dropped first): transcript
 * hits, external profile, then the synthesized memory (shrunk before dropped),
 * then design-system context and project guidance (both shrunk before dropped).
 */
function buildMemoryContextSections(params: BuildExecutionPromptParams): PromptSection[] {
  return [
    makeSection(
      "project_guidance",
      params.projectGuidanceContext,
      PROJECT_GUIDANCE_SECTION_TOKENS,
      {
        required: false,
        dropPriority: 3.5,
        layerKind: "optional",
        cacheScope: "session",
        truncation: "fragment",
        minTokens: PROJECT_GUIDANCE_MIN_TOKENS,
      },
    ),
    makeSection("design_system", params.designSystemContext, DESIGN_SYSTEM_SECTION_TOKENS, {
      required: false,
      dropPriority: 4.5,
      layerKind: "optional",
      cacheScope: "session",
      truncation: "fragment",
      minTokens: DESIGN_SYSTEM_MIN_TOKENS,
    }),
    makeSection("memory_context", params.memoryContext, MEMORY_CONTEXT_SECTION_TOKENS, {
      required: false,
      dropPriority: 5,
      layerKind: "optional",
      cacheScope: "turn",
      truncation: "fragment",
      minTokens: MEMORY_CONTEXT_MIN_TOKENS,
    }),
    makeSection("external_memory", params.externalMemoryContext, EXTERNAL_MEMORY_SECTION_TOKENS, {
      required: false,
      dropPriority: 6.5,
      layerKind: "optional",
      cacheScope: "turn",
      truncation: "fragment",
    }),
    makeSection("transcript_context", params.transcriptContext, TRANSCRIPT_CONTEXT_SECTION_TOKENS, {
      required: false,
      dropPriority: 7.5,
      layerKind: "optional",
      cacheScope: "turn",
      truncation: "fragment",
    }),
  ];
}

export class ContentBuilder {
  static async buildExecutionPrompt(
    params: BuildExecutionPromptParams,
  ): Promise<BuildExecutionPromptResult> {
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
          ...buildMemoryContextSections(params),
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
          makeSection("safety_core", params.safetyCorePrompt || SHARED_PROMPT_POLICY_CORE, 920, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
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
          makeSection("coding_workflow", params.codingWorkflowPrompt, 300, {
            required: true,
            layerKind: "always",
            cacheScope: "session",
          }),
          makeSection("task_strategy", params.taskStrategyPrompt, 400, {
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
          ...buildMemoryContextSections(params),
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
          makeSection("infra_status", params.infraStatusPrompt, 60, {
            required: false,
            dropPriority: 3,
            layerKind: "optional",
            cacheScope: "turn",
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
          makeSection(
            "turn_guidance",
            params.turnGuidancePrompt,
            params.turnGuidanceMaxTokens ?? 1100,
            {
              required: params.turnGuidanceRequired === true,
              // Turn guidance carries step protocols (verification replies, recovery,
              // local-model limits), so it outlives memory, awareness, persona,
              // guidelines, and infra context when the budget overflows.
              dropPriority: 2.5,
              layerKind: params.turnGuidanceRequired === true ? "always" : "optional",
              cacheScope: "turn",
            },
          ),
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
    };
  }
}
