// Format rules for security-audit run files. Shared by check-ledger.mjs and
// check-findings.mjs. No dependencies, so the checkers run with plain `node`.
import { readFileSync, statSync } from "node:fs";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_UNITS = 10_000;
export const MAX_FINDINGS = 1_000;

export const ATTACK_CLASSES = new Set([
  "injection",
  "access-control",
  "file-and-path",
  "request-forgery",
  "web-client",
  "parsing-and-deserialization",
  "crypto-and-secrets",
  "business-logic",
  "resource-exhaustion",
  "data-exposure",
  "supply-chain-and-build",
  "config-and-deploy",
  "memory-safety",
  "ai-and-agents",
  "local-ipc-and-desktop",
  "chained-and-wildcard",
]);

const UNIT_STATUSES = new Set([
  "planned",
  "assigned",
  "covered",
  "candidate",
  "blocked",
  "deferred",
  "out_of_scope",
  "not_applicable",
]);

const UNIT_FIELDS = new Set([
  "id",
  "surface",
  "boundary",
  "component",
  "attack_class",
  "lifecycle",
  "start_paths",
  "status",
  "agent",
  "wave",
  "read_paths",
  "checks",
  "fingerprints",
  "reason",
  "attempts",
]);

// For each status: which of agent / work (read_paths + checks) / fingerprints / reason must be
// "set" (non-empty), "empty", or "any".
const STATUS_RULES = {
  planned: { agent: "empty", work: "empty", fingerprints: "empty", reason: "empty" },
  assigned: { agent: "set", work: "empty", fingerprints: "empty", reason: "empty" },
  covered: { agent: "set", work: "set", fingerprints: "empty", reason: "empty" },
  candidate: { agent: "set", work: "set", fingerprints: "set", reason: "empty" },
  blocked: { agent: "any", work: "any", fingerprints: "empty", reason: "set" },
  deferred: { agent: "any", work: "any", fingerprints: "empty", reason: "set" },
  out_of_scope: { agent: "empty", work: "empty", fingerprints: "empty", reason: "set" },
  not_applicable: { agent: "empty", work: "empty", fingerprints: "empty", reason: "set" },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINGERPRINT = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const VERDICTS = new Set(["confirmed", "needs_validation", "rejected"]);
const LIKELIHOODS = new Set(["high", "medium", "low"]);
const IMPACTS = new Set(["critical", "high", "medium", "low", "informational"]);
const DEPTHS = new Set(["quick", "standard", "deep"]);

const COMMON_FINDING_FIELDS = [
  "fingerprint",
  "verdict",
  "title",
  "attack_class",
  "coverage_ids",
  "origin",
  "found_by",
  "verification",
  "location",
  "trace",
  "evidence",
];

// Per verdict: fields that must be present, and fields that may be present.
const VERDICT_FIELDS = {
  confirmed: {
    required: [
      ...COMMON_FINDING_FIELDS,
      "attacker",
      "impact",
      "preconditions",
      "reproduction",
      "fix",
      "severity",
      "confidence",
    ],
    optional: [],
  },
  needs_validation: {
    required: [...COMMON_FINDING_FIELDS, "attacker", "impact", "blockers", "validation_plan"],
    optional: ["preconditions", "fix"],
  },
  rejected: {
    required: [...COMMON_FINDING_FIELDS, "reason"],
    optional: ["attacker", "impact"],
  },
};

export function isEmpty(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isTextList(value, { nonEmpty = false } = {}) {
  return Array.isArray(value) && value.every(isText) && (!nonEmpty || value.length > 0);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads and parses a JSON file, enforcing the size limit. Returns { data } or { error }. */
export function readJsonFile(filePath) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch (error) {
    return { error: `cannot read ${filePath}: ${error.message}` };
  }
  if (size > MAX_FILE_BYTES) {
    return { error: `${filePath} is ${size} bytes; the limit is ${MAX_FILE_BYTES}` };
  }
  try {
    return { data: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { error: `${filePath} is not valid JSON: ${error.message}` };
  }
}

function checkStatusField(errors, where, name, rule, isSet) {
  if (rule === "set" && !isSet) errors.push(`${where}: status requires ${name}`);
  if (rule === "empty" && isSet) errors.push(`${where}: status does not allow ${name}`);
}

function validateCheck(errors, where, check) {
  if (!isPlainObject(check)) {
    errors.push(`${where}: each check must be an object`);
    return;
  }
  for (const key of Object.keys(check)) {
    if (!["invariant", "method", "result"].includes(key)) {
      errors.push(`${where}: unknown check field "${key}"`);
    }
  }
  if (!isText(check.invariant)) errors.push(`${where}: check needs an invariant`);
  if (!isText(check.result)) errors.push(`${where}: check needs a result`);
  if (check.method !== "source" && check.method !== "local") {
    errors.push(`${where}: check method must be "source" or "local"`);
  }
}

function validateUnit(errors, unit, index) {
  if (!isPlainObject(unit)) {
    errors.push(`units[${index}]: must be an object`);
    return;
  }
  const where = `units[${index}] ${isText(unit.id) ? unit.id : "(no id)"}`;

  for (const key of Object.keys(unit)) {
    if (!UNIT_FIELDS.has(key)) errors.push(`${where}: unknown field "${key}"`);
  }

  const parts = ["surface", "boundary", "component", "attack_class"];
  for (const part of parts) {
    if (!isText(unit[part]) || !SLUG.test(unit[part])) {
      errors.push(`${where}: ${part} must be a lowercase slug`);
    }
  }
  if (unit.lifecycle !== undefined && unit.lifecycle !== null) {
    if (!isText(unit.lifecycle) || !SLUG.test(unit.lifecycle)) {
      errors.push(`${where}: lifecycle must be a lowercase slug`);
    } else {
      parts.push("lifecycle");
    }
  }
  if (isText(unit.attack_class) && !ATTACK_CLASSES.has(unit.attack_class)) {
    errors.push(`${where}: unknown attack_class "${unit.attack_class}"`);
  }
  const expectedId = parts.map((part) => unit[part]).join("::");
  if (unit.id !== expectedId) {
    errors.push(`${where}: id must be "${expectedId}"`);
  }

  if (!UNIT_STATUSES.has(unit.status)) {
    errors.push(`${where}: unknown status "${unit.status}"`);
    return;
  }
  const rules = STATUS_RULES[unit.status];

  if (unit.status !== "out_of_scope" && unit.status !== "not_applicable") {
    if (!isTextList(unit.start_paths, { nonEmpty: true })) {
      errors.push(`${where}: start_paths must list at least one path`);
    }
  } else if (unit.start_paths !== undefined && !isTextList(unit.start_paths)) {
    errors.push(`${where}: start_paths must be a list of paths`);
  }

  if (!isEmpty(unit.agent) && !isText(unit.agent)) errors.push(`${where}: agent must be text`);
  checkStatusField(errors, where, "agent", rules.agent, isText(unit.agent));

  if (!isEmpty(unit.read_paths) && !isTextList(unit.read_paths)) {
    errors.push(`${where}: read_paths must be a list of paths`);
  }
  if (!isEmpty(unit.checks)) {
    if (!Array.isArray(unit.checks)) errors.push(`${where}: checks must be a list`);
    else unit.checks.forEach((check, i) => validateCheck(errors, `${where} checks[${i}]`, check));
  }
  const hasReadPaths = !isEmpty(unit.read_paths);
  const hasChecks = !isEmpty(unit.checks);
  if (rules.work === "set") {
    if (!hasReadPaths) errors.push(`${where}: status requires read_paths`);
    if (!hasChecks) errors.push(`${where}: status requires checks`);
  }
  if (rules.work === "empty" && (hasReadPaths || hasChecks)) {
    errors.push(`${where}: status does not allow read_paths or checks`);
  }

  if (!isEmpty(unit.fingerprints)) {
    if (!isTextList(unit.fingerprints)) {
      errors.push(`${where}: fingerprints must be a list`);
    } else {
      for (const fingerprint of unit.fingerprints) {
        if (!FINGERPRINT.test(fingerprint)) {
          errors.push(`${where}: bad fingerprint "${fingerprint}"`);
        }
      }
    }
  }
  checkStatusField(errors, where, "fingerprints", rules.fingerprints, !isEmpty(unit.fingerprints));

  if (!isEmpty(unit.reason) && !isText(unit.reason)) errors.push(`${where}: reason must be text`);
  checkStatusField(errors, where, "reason", rules.reason, isText(unit.reason));

  if (unit.wave !== undefined && unit.wave !== null) {
    if (!Number.isInteger(unit.wave) || unit.wave < 0) {
      errors.push(`${where}: wave must be a whole number`);
    }
  }
  if (unit.attempts !== undefined && unit.attempts !== null) {
    if (!Array.isArray(unit.attempts) || !unit.attempts.every(isPlainObject)) {
      errors.push(`${where}: attempts must be a list of objects`);
    }
  }
}

/**
 * Validates a parsed coverage ledger. With `final`, no unit may still be planned or assigned.
 * Returns { errors, units, counts }.
 */
export function validateLedger(ledger, { final = false } = {}) {
  const errors = [];
  if (!isPlainObject(ledger)) return { errors: ["ledger must be a JSON object"], units: [] };
  for (const key of Object.keys(ledger)) {
    if (key !== "version" && key !== "units") errors.push(`unknown top-level field "${key}"`);
  }
  if (ledger.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(ledger.units)) {
    errors.push("units must be a list");
    return { errors, units: [] };
  }
  if (ledger.units.length > MAX_UNITS) {
    errors.push(`${ledger.units.length} units; the limit is ${MAX_UNITS}`);
  }

  const seen = new Set();
  const counts = {};
  ledger.units.forEach((unit, index) => {
    validateUnit(errors, unit, index);
    if (!isPlainObject(unit)) return;
    if (isText(unit.id)) {
      if (seen.has(unit.id)) errors.push(`units[${index}]: duplicate id "${unit.id}"`);
      seen.add(unit.id);
    }
    if (UNIT_STATUSES.has(unit.status)) counts[unit.status] = (counts[unit.status] || 0) + 1;
    if (final && (unit.status === "planned" || unit.status === "assigned")) {
      errors.push(`units[${index}] ${unit.id}: still ${unit.status} after hunting ended`);
    }
  });

  return { errors, units: ledger.units.filter(isPlainObject), counts };
}

function validateFindingShape(errors, finding, index) {
  if (!isPlainObject(finding)) {
    errors.push(`findings[${index}]: must be an object`);
    return false;
  }
  const where = `findings[${index}] ${isText(finding.fingerprint) ? finding.fingerprint : "(no fingerprint)"}`;
  if (!VERDICTS.has(finding.verdict)) {
    errors.push(`${where}: verdict must be confirmed, needs_validation or rejected`);
    return false;
  }

  const { required, optional } = VERDICT_FIELDS[finding.verdict];
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(finding)) {
    if (!allowed.has(key)) {
      errors.push(`${where}: field "${key}" is not allowed for ${finding.verdict}`);
    }
  }
  for (const key of required) {
    if (!(key in finding)) errors.push(`${where}: missing field "${key}"`);
  }

  if (!isText(finding.fingerprint) || !FINGERPRINT.test(finding.fingerprint)) {
    errors.push(`${where}: bad fingerprint`);
  }
  if (!isText(finding.title)) errors.push(`${where}: title must be text`);
  if (!ATTACK_CLASSES.has(finding.attack_class)) {
    errors.push(`${where}: unknown attack_class "${finding.attack_class}"`);
  }
  if (!isTextList(finding.coverage_ids, { nonEmpty: true })) {
    errors.push(`${where}: coverage_ids must list at least one unit id`);
  }
  if (finding.origin !== "hunted" && finding.origin !== "carried") {
    errors.push(`${where}: origin must be "hunted" or "carried"`);
  }
  if (!isText(finding.found_by)) errors.push(`${where}: found_by must be text`);
  if (finding.origin === "carried" && finding.found_by !== "earlier-run") {
    errors.push(`${where}: a carried record has found_by "earlier-run"`);
  }

  const location = finding.location;
  if (!isPlainObject(location) || !isText(location.path)) {
    errors.push(`${where}: location needs a path`);
  } else {
    for (const key of Object.keys(location)) {
      if (key !== "path" && key !== "line")
        errors.push(`${where}: unknown location field "${key}"`);
    }
    if (location.line !== undefined && location.line !== null) {
      if (!Number.isInteger(location.line) || location.line < 1) {
        errors.push(`${where}: location.line must be a positive whole number`);
      }
    }
  }

  const trace = finding.trace;
  if (
    !isPlainObject(trace) ||
    !isText(trace.entry) ||
    !isText(trace.sink) ||
    !isTextList(trace.steps)
  ) {
    errors.push(`${where}: trace needs entry, steps and sink`);
  } else {
    for (const key of Object.keys(trace)) {
      if (!["entry", "steps", "sink"].includes(key)) {
        errors.push(`${where}: unknown trace field "${key}"`);
      }
    }
  }

  if (
    !Array.isArray(finding.evidence) ||
    finding.evidence.length === 0 ||
    !finding.evidence.every(
      (item) =>
        isPlainObject(item) &&
        isText(item.ref) &&
        isText(item.note) &&
        Object.keys(item).every((key) => key === "ref" || key === "note"),
    )
  ) {
    errors.push(`${where}: evidence must list { ref, note } items`);
  }

  for (const key of ["attacker", "impact"]) {
    if (key in finding && !isText(finding[key])) errors.push(`${where}: ${key} must be text`);
  }
  if ("preconditions" in finding && !isTextList(finding.preconditions)) {
    errors.push(`${where}: preconditions must be a list of text`);
  }
  if ("fix" in finding) {
    const fix = finding.fix;
    if (!isPlainObject(fix) || !isText(fix.summary)) {
      errors.push(`${where}: fix needs a summary`);
    } else {
      for (const key of Object.keys(fix)) {
        if (key !== "summary" && key !== "patch")
          errors.push(`${where}: unknown fix field "${key}"`);
      }
      if (!isEmpty(fix.patch) && !isText(fix.patch))
        errors.push(`${where}: fix.patch must be text`);
    }
  }

  if (finding.verdict === "confirmed") {
    const reproduction = finding.reproduction;
    if (!isPlainObject(reproduction)) {
      errors.push(`${where}: reproduction must be an object`);
    } else {
      for (const key of Object.keys(reproduction)) {
        if (!["method", "steps", "observed"].includes(key)) {
          errors.push(`${where}: unknown reproduction field "${key}"`);
        }
      }
      if (reproduction.method !== "source" && reproduction.method !== "local") {
        errors.push(`${where}: reproduction.method must be "source" or "local"`);
      }
      if (!isTextList(reproduction.steps, { nonEmpty: true })) {
        errors.push(`${where}: reproduction.steps must list at least one step`);
      }
      if (reproduction.method === "local" && !isText(reproduction.observed)) {
        errors.push(`${where}: a local reproduction needs observed output`);
      }
    }

    const severity = finding.severity;
    if (!isPlainObject(severity)) {
      errors.push(`${where}: severity must be an object`);
    } else {
      for (const key of Object.keys(severity)) {
        if (!["likelihood", "impact", "overall"].includes(key)) {
          errors.push(`${where}: unknown severity field "${key}"`);
        }
      }
      if (!LIKELIHOODS.has(severity.likelihood)) {
        errors.push(`${where}: severity.likelihood must be high, medium or low`);
      }
      if (!IMPACTS.has(severity.impact)) errors.push(`${where}: bad severity.impact`);
      if (!IMPACTS.has(severity.overall)) errors.push(`${where}: bad severity.overall`);
    }
    if (finding.confidence !== "high" && finding.confidence !== "medium") {
      errors.push(`${where}: confidence must be high or medium`);
    }
  }

  if (finding.verdict === "needs_validation") {
    if (!isTextList(finding.blockers, { nonEmpty: true })) {
      errors.push(`${where}: blockers must list at least one item`);
    }
    if (!isTextList(finding.validation_plan, { nonEmpty: true })) {
      errors.push(`${where}: validation_plan must list at least one step`);
    }
  }

  if (finding.verdict === "rejected" && !isText(finding.reason)) {
    errors.push(`${where}: reason must be text`);
  }

  return true;
}

function validateVerification(errors, finding, index, depth) {
  const where = `findings[${index}] ${finding.fingerprint}`;
  const verification = finding.verification;
  if (!isPlainObject(verification)) {
    errors.push(`${where}: verification must be an object`);
    return;
  }
  for (const key of Object.keys(verification)) {
    if (key !== "challenge" && key !== "recheck") {
      errors.push(`${where}: unknown verification field "${key}"`);
    }
  }
  const { challenge, recheck } = verification;
  if (!isText(challenge)) {
    errors.push(`${where}: verification.challenge must name the challenger`);
  } else if (challenge === finding.found_by) {
    errors.push(`${where}: the challenger must not be the agent that found it`);
  }

  const recheckOptional = finding.verdict === "rejected" || depth === "quick";
  if (isEmpty(recheck)) {
    if (!recheckOptional) errors.push(`${where}: verification.recheck must name the re-checker`);
  } else if (!isText(recheck)) {
    errors.push(`${where}: verification.recheck must be text`);
  } else if (recheck === finding.found_by || recheck === challenge) {
    errors.push(`${where}: the re-checker must differ from the finder and the challenger`);
  }
}

/**
 * Validates parsed findings. With `ledgerUnits`, also cross-checks coverage ids and candidate
 * fingerprints against the ledger. Returns { errors, summary }.
 */
export function validateFindings(document, { ledgerUnits = null } = {}) {
  const errors = [];
  if (!isPlainObject(document)) return { errors: ["findings must be a JSON object"] };
  for (const key of Object.keys(document)) {
    if (!["version", "depth", "findings"].includes(key)) {
      errors.push(`unknown top-level field "${key}"`);
    }
  }
  if (document.version !== 1) errors.push("version must be 1");
  if (!DEPTHS.has(document.depth)) errors.push("depth must be quick, standard or deep");
  if (!Array.isArray(document.findings)) {
    errors.push("findings must be a list");
    return { errors };
  }
  if (document.findings.length > MAX_FINDINGS) {
    errors.push(`${document.findings.length} findings; the limit is ${MAX_FINDINGS}`);
  }

  const valid = [];
  document.findings.forEach((finding, index) => {
    if (validateFindingShape(errors, finding, index)) {
      validateVerification(errors, finding, index, document.depth);
      valid.push(finding);
    }
  });

  const fingerprints = document.findings.map((finding) =>
    isPlainObject(finding) ? finding.fingerprint : undefined,
  );
  const seen = new Set();
  fingerprints.forEach((fingerprint, index) => {
    if (!isText(fingerprint)) return;
    if (seen.has(fingerprint))
      errors.push(`findings[${index}]: duplicate fingerprint "${fingerprint}"`);
    seen.add(fingerprint);
    if (index > 0 && isText(fingerprints[index - 1]) && fingerprints[index - 1] > fingerprint) {
      errors.push(`findings[${index}]: findings must be sorted by fingerprint`);
    }
  });

  if (ledgerUnits) {
    const unitsById = new Map(ledgerUnits.filter((unit) => isText(unit.id)).map((u) => [u.id, u]));
    for (const finding of valid) {
      if (!isTextList(finding.coverage_ids)) continue;
      for (const id of finding.coverage_ids) {
        if (!unitsById.has(id)) {
          errors.push(`${finding.fingerprint}: coverage id "${id}" is not in the ledger`);
        }
      }
      if (finding.origin === "hunted") {
        const listed = finding.coverage_ids.some((id) =>
          (unitsById.get(id)?.fingerprints || []).includes(finding.fingerprint),
        );
        if (!listed) {
          errors.push(
            `${finding.fingerprint}: no ledger unit in coverage_ids lists this fingerprint`,
          );
        }
      }
    }
    for (const unit of ledgerUnits) {
      if (unit.status !== "candidate" || !Array.isArray(unit.fingerprints)) continue;
      for (const fingerprint of unit.fingerprints) {
        if (!seen.has(fingerprint)) {
          errors.push(`${unit.id}: candidate "${fingerprint}" has no record in findings`);
        }
      }
    }
  }

  return { errors, summary: summarize(valid) };
}

function summarize(findings) {
  const byVerdict = { confirmed: 0, needs_validation: 0, rejected: 0 };
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  for (const finding of findings) {
    byVerdict[finding.verdict] += 1;
    const overall = finding.verdict === "confirmed" ? finding.severity?.overall : undefined;
    if (overall in bySeverity) bySeverity[overall] += 1;
  }
  return { total: findings.length, byVerdict, bySeverity };
}

/** Prints errors and returns the process exit code. */
export function report(label, errors, okLine) {
  if (errors.length === 0) {
    process.stdout.write(`${label}: OK. ${okLine}\n`);
    return 0;
  }
  process.stdout.write(`${label}: ${errors.length} error(s)\n`);
  for (const error of errors) process.stdout.write(`- ${error}\n`);
  return 1;
}
