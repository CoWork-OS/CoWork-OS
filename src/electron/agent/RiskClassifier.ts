/**
 * Risk Classifier
 *
 * Classifies an imminent tool call as low/medium/high risk before execution.
 * Extends the existing ToolRiskLevel system with a pre-flight confirmation tier.
 *
 * Risk mapping:
 *   low    → auto-allow (no prompt)
 *   medium → UI confirmation via requestApproval()
 *   high   → hard block unless user explicitly overrides
 */

import type { ConfirmationRisk, GuardrailSettings } from "../../shared/types";

export interface RiskContext {
  /** Task domain helps determine if a tool is expected in this context */
  taskDomain?: string;
  /** Whether the task is running in autonomous mode */
  autonomousMode?: boolean;
}

export interface RiskClassification {
  risk: ConfirmationRisk;
  reason: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Tools that are always high-risk regardless of context.
 * These can cause irreversible damage or expose sensitive data.
 */
const HIGH_RISK_TOOLS = new Set([
  "delete_file",
  "delete_multiple",
  "git_reset",
  "git_push",
  "git_force_push",
  "mint_",
  "airdrop_",
]);

/**
 * Tools that are medium-risk: significant side effects but typically reversible.
 */
const MEDIUM_RISK_TOOLS = new Set([
  "run_command",
  "run_applescript",
  "execute_code",
  "schedule_task",
  "spawn_agent",
  "orchestrate_agents",
]);

/**
 * High-risk input patterns that escalate medium tools to high risk.
 * For example, `rm -rf` in a shell command should be high risk.
 */
const HIGH_RISK_INPUT_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/,
  /\bdrop\s+table\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/,
  /\bsudo\s+rm\b/,
  /\/dev\//,
  /\b(truncate|shred|wipe)\b/i,
];

export class RiskClassifier {
  /**
   * Classify the risk of a tool call before it executes.
   */
  static classify(
    toolName: string,
    toolInput: Record<string, unknown>,
    _ctx: RiskContext = {},
  ): RiskClassification {
    // Check explicit high-risk tool list
    if (HIGH_RISK_TOOLS.has(toolName)) {
      return {
        risk: "high",
        reason: `"${toolName}" is classified as a high-risk destructive operation`,
        toolName,
        toolInput,
      };
    }

    // Check prefix-based high-risk tools
    if (toolName.startsWith("mint_") || toolName.startsWith("airdrop_")) {
      return {
        risk: "high",
        reason: `"${toolName}" is a blockchain mutation tool (irreversible)`,
        toolName,
        toolInput,
      };
    }

    // Check medium-risk tools
    if (MEDIUM_RISK_TOOLS.has(toolName)) {
      // Escalate to high if the input contains dangerous patterns
      const inputStr = JSON.stringify(toolInput);
      for (const pattern of HIGH_RISK_INPUT_PATTERNS) {
        if (pattern.test(inputStr)) {
          return {
            risk: "high",
            reason: `"${toolName}" contains a high-risk input pattern (${pattern.source})`,
            toolName,
            toolInput,
          };
        }
      }
      return {
        risk: "medium",
        reason: `"${toolName}" may have significant side effects`,
        toolName,
        toolInput,
      };
    }

    // Write-like tools are low risk by default
    return {
      risk: "low",
      reason: `"${toolName}" is considered low risk`,
      toolName,
      toolInput,
    };
  }

  /**
   * Determine whether the classification requires user confirmation given the settings.
   *
   * Threshold semantics:
   *   "low"  → confirm everything (even low-risk tools)
   *   "medium" → confirm medium + high
   *   "high"   → confirm only high (default)
   */
  static shouldRequireConfirmation(
    classification: RiskClassification,
    settings: Pick<GuardrailSettings, "hitlEnabled" | "hitlRiskThreshold">,
  ): boolean {
    if (!settings.hitlEnabled) return false;

    const threshold = settings.hitlRiskThreshold ?? "high";
    const riskOrder: ConfirmationRisk[] = ["low", "medium", "high"];
    const classificationIdx = riskOrder.indexOf(classification.risk);
    const thresholdIdx = riskOrder.indexOf(threshold);

    // Require confirmation if classification risk >= threshold
    return classificationIdx >= thresholdIdx;
  }
}
