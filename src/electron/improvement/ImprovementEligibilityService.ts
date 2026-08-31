import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ImprovementEligibility } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";

const OWNER_SIGNATURE_ENV = "COWORK_SELF_IMPROVEMENT_OWNER_SIGNATURE";
const OWNER_REPO_REMOTE = "github.com/CoWork-OS/CoWork-OS";
const OWNER_SETTINGS_CATEGORY = "improvement-owner";
const OWNER_MACHINE_ID_FILE = ".cowork-machine-id";
const OWNER_ENROLLMENT_SCOPE = "cowork-self-improvement-owner";
const OWNER_ENROLLMENT_VERSION = 1;
const OWNER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAU31JMjkwh/AwbrG24EKz1XLJqT0IYlyfkP9jFUIhGFk=
-----END PUBLIC KEY-----`;

interface ImprovementOwnerEnrollment {
  enrolled: boolean;
  enrolledAt: number;
  machineFingerprint: string;
  signature: string;
  repoPath?: string;
}

export function getImprovementEligibility(): ImprovementEligibility {
  const repoPath = resolveRepoPath();
  const unpackagedApp = !isPackagedElectronApp();
  const canonicalRepo = isCanonicalCoworkRepo(repoPath);
  const machineFingerprint = getMachineFingerprint();
  const ownerEnrollmentChallenge = buildOwnerEnrollmentChallenge(machineFingerprint);
  const envSignature = getOwnerSignatureFromEnv();

  let enrollment = loadEnrollment();
  if (
    !enrollment &&
    unpackagedApp &&
    canonicalRepo &&
    machineFingerprint &&
    ownerEnrollmentChallenge &&
    envSignature
  ) {
    enrollment = autoEnrollOwner(
      repoPath,
      machineFingerprint,
      ownerEnrollmentChallenge,
      envSignature,
    );
  }

  const ownerProofPresent = Boolean(enrollment?.signature);
  const ownerEnrollment = verifyEnrollment(
    enrollment,
    machineFingerprint,
    ownerEnrollmentChallenge,
  );
  const eligible = unpackagedApp && canonicalRepo && ownerEnrollment && ownerProofPresent;

  return {
    eligible,
    reason: buildReason({
      unpackagedApp,
      canonicalRepo,
      ownerEnrollment,
      ownerProofPresent,
    }),
    enrolled: ownerEnrollment,
    repoPath,
    machineFingerprint,
    ownerEnrollmentChallenge,
    checks: {
      unpackagedApp,
      canonicalRepo,
      ownerEnrollment,
      ownerProofPresent,
    },
  };
}

export function saveOwnerEnrollmentSignature(signature: string): ImprovementEligibility {
  const normalizedSignature = normalizeOwnerSignature(signature);
  if (!normalizedSignature) {
    throw new Error("Maintainer-signed owner enrollment signature is required.");
  }

  const repoPath = resolveRepoPath();
  const machineFingerprint = getMachineFingerprint();
  const ownerEnrollmentChallenge = buildOwnerEnrollmentChallenge(machineFingerprint);
  if (!machineFingerprint || !ownerEnrollmentChallenge) {
    throw new Error("Unable to derive a stable machine challenge for owner enrollment.");
  }
  if (!verifyOwnerSignature(ownerEnrollmentChallenge, normalizedSignature)) {
    throw new Error("Owner enrollment signature is invalid for this machine or signer.");
  }

  saveEnrollment({
    enrolled: true,
    enrolledAt: Date.now(),
    machineFingerprint,
    signature: normalizedSignature,
    repoPath,
  });

  return getImprovementEligibility();
}

export function clearOwnerEnrollment(): ImprovementEligibility {
  if (SecureSettingsRepository.isInitialized()) {
    try {
      SecureSettingsRepository.getInstance().delete(OWNER_SETTINGS_CATEGORY);
    } catch {
      // Best effort; eligibility below will reflect the remaining persisted state.
    }
  }
  return getImprovementEligibility();
}

function resolveRepoPath(): string {
  const preferred = getPreferredRepoPath();
  return resolveGitRepoRoot(preferred) || preferred;
}

function buildReason(checks: ImprovementEligibility["checks"]): string {
  if (!checks.unpackagedApp) {
    return "Self-improvement is disabled in packaged end-user builds.";
  }
  if (!checks.canonicalRepo) {
    return "Self-improvement is only enabled inside the canonical CoWork OS repository.";
  }
  if (!checks.ownerProofPresent) {
    return `Maintainer-signed owner enrollment is missing. Paste a valid signature into Settings → Self-Improvement, or set ${OWNER_SIGNATURE_ENV}.`;
  }
  if (!checks.ownerEnrollment) {
    return "Stored owner enrollment proof is invalid for this machine or was not signed by the maintainer key.";
  }
  return "Owner-only self-improvement is enabled.";
}

function getPreferredRepoPath(): string {
  const explicit = process.env.COWORK_SELF_IMPROVEMENT_REPO;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  return path.resolve(process.cwd());
}

function getOwnerSignatureFromEnv(): string | undefined {
  const signature = process.env[OWNER_SIGNATURE_ENV];
  return normalizeOwnerSignature(signature);
}

function normalizeOwnerSignature(signature: unknown): string | undefined {
  if (typeof signature !== "string") return undefined;
  const normalized = signature.replace(/\s+/g, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function loadEnrollment(): ImprovementOwnerEnrollment | undefined {
  if (!SecureSettingsRepository.isInitialized()) return undefined;
  try {
    return SecureSettingsRepository.getInstance().load<ImprovementOwnerEnrollment>(
      OWNER_SETTINGS_CATEGORY,
    );
  } catch {
    return undefined;
  }
}

function autoEnrollOwner(
  repoPath: string,
  machineFingerprint: string,
  ownerEnrollmentChallenge: string,
  signature: string,
): ImprovementOwnerEnrollment | undefined {
  const normalizedSignature = normalizeOwnerSignature(signature);
  if (
    !normalizedSignature ||
    !verifyOwnerSignature(ownerEnrollmentChallenge, normalizedSignature)
  ) {
    return undefined;
  }

  const enrollment: ImprovementOwnerEnrollment = {
    enrolled: true,
    enrolledAt: Date.now(),
    machineFingerprint,
    signature: normalizedSignature,
    repoPath,
  };
  return saveEnrollment(enrollment);
}

function verifyEnrollment(
  enrollment: ImprovementOwnerEnrollment | undefined,
  machineFingerprint: string | undefined,
  ownerEnrollmentChallenge: string | undefined,
): boolean {
  if (!enrollment?.enrolled || !enrollment.signature) return false;
  if (!machineFingerprint || !ownerEnrollmentChallenge) return false;
  if (enrollment.machineFingerprint !== machineFingerprint) return false;
  return verifyOwnerSignature(ownerEnrollmentChallenge, enrollment.signature);
}

function verifyOwnerSignature(challenge: string, signature: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(challenge, "utf8"),
      OWNER_PUBLIC_KEY_PEM,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function buildOwnerEnrollmentChallenge(machineFingerprint: string | undefined): string | undefined {
  if (!machineFingerprint) return undefined;
  return [
    OWNER_ENROLLMENT_SCOPE,
    `v${OWNER_ENROLLMENT_VERSION}`,
    machineFingerprint,
    OWNER_REPO_REMOTE.toLowerCase(),
  ].join(":");
}

function getMachineFingerprint(): string | undefined {
  const machineId = getOrCreateMachineId();
  if (!machineId) return undefined;
  return crypto.createHash("sha256").update(machineId).digest("hex");
}

function getOrCreateMachineId(): string | undefined {
  try {
    const userDataPath = getUserDataDir();
    fs.mkdirSync(userDataPath, { recursive: true });
    const machineIdPath = path.join(userDataPath, OWNER_MACHINE_ID_FILE);
    if (fs.existsSync(machineIdPath)) {
      const existing = fs.readFileSync(machineIdPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }

    const created = crypto.randomUUID();
    fs.writeFileSync(machineIdPath, created, { mode: 0o600 });
    return created;
  } catch {
    return undefined;
  }
}

function saveEnrollment(enrollment: ImprovementOwnerEnrollment): ImprovementOwnerEnrollment {
  if (!SecureSettingsRepository.isInitialized()) {
    return enrollment;
  }
  try {
    SecureSettingsRepository.getInstance().save(OWNER_SETTINGS_CATEGORY, enrollment);
    return enrollment;
  } catch {
    return enrollment;
  }
}

function isCanonicalCoworkRepo(repoPath: string): boolean {
  const normalizedExpected = normalizeGitRemote(OWNER_REPO_REMOTE);
  const originRemote = getGitRemoteOrigin(repoPath);
  const normalizedOrigin = normalizeGitRemote(originRemote);
  return Boolean(normalizedExpected && normalizedOrigin && normalizedOrigin === normalizedExpected);
}

function resolveGitRepoRoot(repoPath: string): string | undefined {
  const gitResult = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  if (gitResult) {
    return path.resolve(gitResult);
  }

  let current = path.resolve(repoPath);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

function getGitRemoteOrigin(repoPath: string): string | undefined {
  return runGit(repoPath, ["remote", "get-url", "origin"]);
}

function runGit(repoPath: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitRemote(remote: string | undefined): string | undefined {
  if (typeof remote !== "string" || remote.trim().length === 0) return undefined;

  const trimmed = remote.trim().replace(/^git\+/, "");
  const scpLike = trimmed.match(/^(?<user>[^@]+@)?(?<host>[^:]+):(?<path>.+)$/);
  const asUrl =
    trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("ssh://")
      ? trimmed
      : scpLike?.groups?.host && scpLike.groups.path
        ? `ssh://${scpLike.groups.user || ""}${scpLike.groups.host}/${scpLike.groups.path}`
        : `https://${trimmed}`;

  try {
    const parsed = new URL(asUrl);
    const host = parsed.hostname.toLowerCase();
    const repoPath = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    if (!host || !repoPath) return undefined;
    return `${host}/${repoPath}`;
  } catch {
    return undefined;
  }
}

function isPackagedElectronApp(): boolean {
  try {
    const electron = require("electron") as { app?: { isPackaged?: boolean } };
    return Boolean(electron.app?.isPackaged);
  } catch {
    return false;
  }
}
