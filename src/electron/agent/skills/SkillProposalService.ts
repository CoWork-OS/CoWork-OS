import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomBytes } from "crypto";

export type SkillProposalStatus = "pending" | "approved" | "rejected";

export interface SkillProposalDraftSkill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon?: string;
  category?: string;
  parameters?: Any[];
  enabled?: boolean;
}

export interface SkillProposalRecord {
  id: string;
  version: 1;
  status: SkillProposalStatus;
  problemStatement: string;
  evidence: string[];
  requiredTools: string[];
  riskNote: string;
  draftSkill: SkillProposalDraftSkill;
  signature: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  rejectionReason?: string;
  approvedSkillId?: string;
}

export interface SkillProposalCreateInput {
  problemStatement: string;
  evidence?: string[];
  requiredTools?: string[];
  riskNote?: string;
  draftSkill: SkillProposalDraftSkill;
}

const PROPOSALS_ROOT = path.join(".cowork", "skills", "proposals");
const PROPOSAL_VERSION = 1;
const REJECTED_DUPLICATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function nowMs(): number {
  return Date.now();
}

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function normalizeDraftSkill(input: SkillProposalDraftSkill): SkillProposalDraftSkill {
  return {
    id: String(input.id || "").trim(),
    name: String(input.name || "").trim(),
    description: String(input.description || "").trim(),
    prompt: String(input.prompt || "").trim(),
    icon: toNonEmptyString(input.icon),
    category: toNonEmptyString(input.category),
    parameters: Array.isArray(input.parameters) ? input.parameters : undefined,
    enabled: input.enabled !== false,
  };
}

function proposalSignature(input: {
  problemStatement: string;
  requiredTools: string[];
  draftSkill: SkillProposalDraftSkill;
}): string {
  const canonical = JSON.stringify({
    problemStatement: input.problemStatement.trim().toLowerCase(),
    requiredTools: [
      ...new Set(input.requiredTools.map((tool) => tool.trim().toLowerCase())),
    ].sort(),
    draftSkill: {
      id: input.draftSkill.id.trim().toLowerCase(),
      promptHash: createHash("sha256")
        .update(input.draftSkill.prompt || "")
        .digest("hex"),
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class SkillProposalService {
  private proposalsDir: string;

  constructor(private workspacePath: string) {
    this.proposalsDir = path.join(this.workspacePath, PROPOSALS_ROOT);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.proposalsDir, { recursive: true });
  }

  private isSafeRecordId(id: string): boolean {
    return SAFE_RECORD_ID.test(id);
  }

  private proposalPath(id: string): string {
    if (!this.isSafeRecordId(id)) throw new Error("Invalid skill proposal id");
    return path.join(this.proposalsDir, `${id}.json`);
  }

  private async readProposalFile(filePath: string): Promise<SkillProposalRecord | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SkillProposalRecord>;
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.id !== "string" || !parsed.id.trim()) return null;
      if (
        parsed.status !== "pending" &&
        parsed.status !== "approved" &&
        parsed.status !== "rejected"
      ) {
        return null;
      }
      if (!parsed.draftSkill || typeof parsed.draftSkill !== "object") return null;

      return {
        id: parsed.id,
        version: PROPOSAL_VERSION,
        status: parsed.status,
        problemStatement: toNonEmptyString(parsed.problemStatement),
        evidence: normalizeStringArray(parsed.evidence),
        requiredTools: normalizeStringArray(parsed.requiredTools),
        riskNote: toNonEmptyString(parsed.riskNote),
        draftSkill: normalizeDraftSkill(parsed.draftSkill as SkillProposalDraftSkill),
        signature: toNonEmptyString(parsed.signature),
        createdAt: Number(parsed.createdAt || 0),
        updatedAt: Number(parsed.updatedAt || 0),
        approvedAt: parsed.approvedAt ? Number(parsed.approvedAt) : undefined,
        rejectedAt: parsed.rejectedAt ? Number(parsed.rejectedAt) : undefined,
        rejectionReason: toNonEmptyString(parsed.rejectionReason),
        approvedSkillId: toNonEmptyString(parsed.approvedSkillId),
      };
    } catch {
      return null;
    }
  }

  async list(status: SkillProposalStatus | "all" = "pending"): Promise<SkillProposalRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.proposalsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const proposals: SkillProposalRecord[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const parsed = await this.readProposalFile(path.join(this.proposalsDir, entry));
      if (!parsed) continue;
      if (status !== "all" && parsed.status !== status) continue;
      proposals.push(parsed);
    }

    proposals.sort((a, b) => b.createdAt - a.createdAt);
    return proposals;
  }

  async get(id: string): Promise<SkillProposalRecord | null> {
    const trimmedId = id.trim();
    if (!trimmedId || !this.isSafeRecordId(trimmedId)) return null;
    return await this.readProposalFile(this.proposalPath(trimmedId));
  }

  async create(input: SkillProposalCreateInput): Promise<{
    proposal?: SkillProposalRecord;
    blocked?: string;
    duplicateOf?: string;
    cooldownUntil?: number;
  }> {
    const problemStatement = toNonEmptyString(input.problemStatement);
    const riskNote = toNonEmptyString(input.riskNote);
    const evidence = normalizeStringArray(input.evidence);
    const requiredTools = normalizeStringArray(input.requiredTools);
    const draftSkill = normalizeDraftSkill(input.draftSkill);

    if (!problemStatement) {
      return { blocked: "problem_statement is required" };
    }
    if (!draftSkill.id || !this.isSafeRecordId(draftSkill.id)) {
      return { blocked: "draft_skill.id must contain only letters, numbers, '_' or '-'" };
    }
    if (!draftSkill.name || !draftSkill.description || !draftSkill.prompt) {
      return { blocked: "draft_skill must include id, name, description, and prompt" };
    }

    const signature = proposalSignature({
      problemStatement,
      requiredTools,
      draftSkill,
    });

    const existing = await this.list("all");
    const now = nowMs();
    for (const proposal of existing) {
      if (proposal.signature !== signature) continue;
      if (proposal.status === "pending" || proposal.status === "approved") {
        return { duplicateOf: proposal.id };
      }
      if (proposal.status === "rejected") {
        const rejectedAt = proposal.rejectedAt || proposal.updatedAt || proposal.createdAt;
        const cooldownUntil = rejectedAt + REJECTED_DUPLICATE_COOLDOWN_MS;
        if (cooldownUntil > now) {
          return { duplicateOf: proposal.id, cooldownUntil };
        }
      }
    }

    const proposalId = `sp_${now}_${randomBytes(4).toString("hex")}`;
    const proposal: SkillProposalRecord = {
      id: proposalId,
      version: PROPOSAL_VERSION,
      status: "pending",
      problemStatement,
      evidence,
      requiredTools,
      riskNote,
      draftSkill,
      signature,
      createdAt: now,
      updatedAt: now,
    };

    await this.ensureDir();
    await fs.writeFile(this.proposalPath(proposalId), JSON.stringify(proposal, null, 2), "utf8");
    return { proposal };
  }

  async approve(id: string, approvedSkillId: string): Promise<SkillProposalRecord | null> {
    const proposal = await this.get(id);
    if (!proposal || proposal.status !== "pending") return null;

    const now = nowMs();
    const updated: SkillProposalRecord = {
      ...proposal,
      status: "approved",
      approvedAt: now,
      approvedSkillId: approvedSkillId.trim(),
      updatedAt: now,
    };

    await fs.writeFile(this.proposalPath(updated.id), JSON.stringify(updated, null, 2), "utf8");
    return updated;
  }

  async reject(id: string, reason?: string): Promise<SkillProposalRecord | null> {
    const proposal = await this.get(id);
    if (!proposal || proposal.status !== "pending") return null;

    const now = nowMs();
    const updated: SkillProposalRecord = {
      ...proposal,
      status: "rejected",
      rejectionReason: toNonEmptyString(reason),
      rejectedAt: now,
      updatedAt: now,
    };

    await fs.writeFile(this.proposalPath(updated.id), JSON.stringify(updated, null, 2), "utf8");
    return updated;
  }
}
