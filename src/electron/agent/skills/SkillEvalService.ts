import fs from "fs/promises";
import path from "path";
import type { SkillProposalRecord } from "./SkillProposalService";

const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface SkillEvalCase {
  id: string;
  prompt: string;
  expectedSignals?: string[];
  forbiddenSignals?: string[];
  requiredTools?: string[];
}

export interface SkillEvalCaseResult {
  caseId: string;
  score: number;
  passed: boolean;
  matchedSignals: string[];
  missingSignals: string[];
  forbiddenMatches: string[];
}

export interface SkillEvalReport {
  proposalId: string;
  skillId: string;
  score: number;
  passed: boolean;
  caseResults: SkillEvalCaseResult[];
  createdAt: number;
}

const EVAL_REPORT_DIR = path.join(".cowork", "skills", "evals");

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesSignal(text: string, signal: string): boolean {
  return normalize(text).includes(normalize(signal));
}

function scoreCase(proposal: SkillProposalRecord, testCase: SkillEvalCase): SkillEvalCaseResult {
  const corpus = [
    proposal.problemStatement,
    proposal.draftSkill.name,
    proposal.draftSkill.description,
    proposal.draftSkill.prompt,
    proposal.evidence.join("\n"),
    proposal.requiredTools.join("\n"),
  ].join("\n");
  const expected = testCase.expectedSignals || [];
  const forbidden = testCase.forbiddenSignals || [];
  const requiredTools = testCase.requiredTools || [];
  const matchedSignals = expected.filter((signal) => includesSignal(corpus, signal));
  const missingSignals = expected.filter((signal) => !includesSignal(corpus, signal));
  const forbiddenMatches = forbidden.filter((signal) => includesSignal(corpus, signal));
  const missingTools = requiredTools.filter(
    (tool) => !proposal.requiredTools.some((candidate) => normalize(candidate) === normalize(tool)),
  );
  const denominator = Math.max(1, expected.length + requiredTools.length);
  const positiveScore =
    (matchedSignals.length + requiredTools.length - missingTools.length) / denominator;
  const penalty = forbiddenMatches.length > 0 ? 0.35 : 0;
  const score = Math.max(0, Math.min(1, positiveScore - penalty));
  return {
    caseId: testCase.id,
    score,
    passed:
      score >= 0.75 &&
      missingSignals.length === 0 &&
      missingTools.length === 0 &&
      forbiddenMatches.length === 0,
    matchedSignals,
    missingSignals: [...missingSignals, ...missingTools.map((tool) => `tool:${tool}`)],
    forbiddenMatches,
  };
}

export class SkillEvalService {
  constructor(private readonly workspacePath: string) {}

  async runProposalEval(
    proposal: SkillProposalRecord,
    cases: SkillEvalCase[],
  ): Promise<SkillEvalReport> {
    const caseResults = cases.map((testCase) => scoreCase(proposal, testCase));
    const score =
      caseResults.length > 0
        ? caseResults.reduce((sum, result) => sum + result.score, 0) / caseResults.length
        : 0;
    const report: SkillEvalReport = {
      proposalId: proposal.id,
      skillId: proposal.draftSkill.id,
      score,
      passed: caseResults.length > 0 && caseResults.every((result) => result.passed),
      caseResults,
      createdAt: Date.now(),
    };
    await this.writeReport(report);
    return report;
  }

  private async writeReport(report: SkillEvalReport): Promise<void> {
    if (!SAFE_RECORD_ID.test(report.proposalId)) {
      throw new Error("Invalid skill proposal id for eval report");
    }
    const dir = path.join(this.workspacePath, EVAL_REPORT_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${report.proposalId}.json`),
      JSON.stringify(report, null, 2),
      "utf8",
    );
  }
}
