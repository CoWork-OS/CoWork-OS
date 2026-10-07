import type Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import path from "node:path";
import {
  botWorkResultRequestSchema,
  type BotWorkResult,
  type BotWorkResultManifest,
} from "../../shared/bot-work-result";
import { BotWorkResultRepository } from "../database/repository-facades";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { loadPolicies } from "../admin/policies";
import {
  resolveEffectiveAccessProfile,
  applyAccessProfileToWorkspace,
} from "../security/access-profile-resolver";
import type { BotArtifactCheckInput } from "./bot-work-artifact-worker";
function inspect(input: BotArtifactCheckInput): Promise<BotWorkResult["outputs"]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "bot-work-artifact-worker.js"), {
      workerData: { kind: "botWorkArtifactCheck", input },
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Artifact inspection timed out")), 5000);
    const finish = (error?: Error, value?: BotWorkResult["outputs"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    worker.once("message", (value) => finish(undefined, value));
    worker.once("error", (error) =>
      finish(error instanceof Error ? error : new Error("Artifact worker failed")),
    );
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`Artifact inspection exited (${code})`));
    });
  });
}
export class BotWorkResultService {
  private repository;
  constructor(
    db: Database.Database,
    private options: {
      inspect?: (input: BotArtifactCheckInput) => Promise<BotWorkResult["outputs"]>;
      access?: () => {
        settings: ReturnType<typeof PermissionSettingsManager.loadSettings>;
        adminPolicies: ReturnType<typeof loadPolicies>;
      };
    } = {},
  ) {
    this.repository = new BotWorkResultRepository(db);
  }
  private workspace(manifest: BotWorkResultManifest) {
    if (!manifest.task.policyValid)
      return {
        ...manifest.workspace,
        permissions: { ...manifest.workspace.permissions, read: false },
      };
    const access = this.options.access?.() ?? {
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    };
    const profile = resolveEffectiveAccessProfile({
      task: manifest.task,
      workspace: manifest.workspace,
      ...access,
    });
    const effective = applyAccessProfileToWorkspace(manifest.workspace, profile);
    return profile.profileUnavailable
      ? { ...effective, permissions: { ...effective.permissions, read: false } }
      : effective;
  }
  async get(raw: unknown): Promise<BotWorkResult> {
    const request = botWorkResultRequestSchema.parse(raw);
    const manifest = await this.repository.manifest(request);
    const workspace = this.workspace(manifest);
    let outputs: BotWorkResult["outputs"];
    const issues = [...manifest.issues];
    try {
      outputs = await (this.options.inspect ?? inspect)({
        workspace,
        artifacts: manifest.artifacts,
      });
    } catch {
      issues.push("Current artifact checks are unavailable.");
      outputs = manifest.artifacts.map((a) => ({
        ...a,
        check: "unavailable" as const,
        reason: "inspection_unavailable",
      }));
    }
    // A worker must not disclose evidence after the task lineage or policy changed.
    const current = await this.repository.manifest(request);
    if (
      current.checksum !== manifest.checksum ||
      JSON.stringify(this.workspace(current)) !== JSON.stringify(workspace)
    )
      throw new Error("Result or current file policy changed; reload the evidence.");
    const now = Date.now();
    const evidence = manifest.evidence.map((e) => ({
      ...e,
      status: e.expiresAt !== undefined && e.expiresAt <= now ? "stale" : e.status,
    }));
    const byId = new Map(evidence.map((e) => [e.id, e]));
    const byOutput = new Map(outputs.map((o) => [o.id, o]));
    const requirements =
      manifest.contract?.requirements.map((r) => {
        let currentEvidence: NonNullable<
          BotWorkResult["contract"]
        >["requirements"][number]["currentEvidence"] = "unconfirmed";
        if (r.status === "waived") currentEvidence = "waived";
        else if (r.verifier === "file_exists" && r.targetPath) {
          const target = path.resolve(workspace.path, r.targetPath);
          const proofs = (r.evidenceIds ?? [])
            .map((id) => byId.get(id))
            .filter(
              (e) =>
                e?.status === "supporting" &&
                e.sourceType === "artifact_revision" &&
                e.artifactRevisionId,
            );
          const output = proofs
            .map((e) => byOutput.get(e!.artifactRevisionId!))
            .find((o) => o && path.resolve(workspace.path, o.path) === target);
          if (output)
            currentEvidence =
              output.check === "matches"
                ? "matches"
                : ["missing", "changed", "not_current"].includes(output.check)
                  ? "failed"
                  : "unconfirmed";
        }
        return {
          id: r.id,
          kind: r.kind,
          description: r.description,
          required: r.required,
          status: r.status,
          verifier: r.verifier,
          currentEvidence,
        };
      }) ?? [];
    return {
      request,
      title: manifest.task.title,
      status: manifest.task.status,
      checkedAt: now,
      recordedVerification: manifest.task.recordedVerification,
      delivery: "unknown",
      contract: manifest.contract
        ? {
            id: manifest.contract.id,
            version: manifest.contract.version,
            objective: manifest.contract.objective,
            status: manifest.contract.status,
            requirements,
          }
        : null,
      outputs: outputs.map(({ id, artifactId, path, revision, sha256, status, check, reason }) => ({
        id,
        artifactId,
        path,
        revision,
        sha256,
        status,
        check,
        reason,
      })),
      evidence: evidence.map(({ id, claim, sourceType, capturedAt, status }) => ({
        id,
        claim,
        sourceType,
        capturedAt,
        status,
      })),
      truncated: manifest.truncated,
      issues,
    };
  }
}
