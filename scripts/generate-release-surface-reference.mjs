import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestsDir = resolve(repoRoot, "docs/release-surfaces");
const outputPath = resolve(repoRoot, "docs/release-surface-reference.md");

function versionTuple(version) {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number(part));
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

export function validateReleaseSurfaceManifests(manifests, packageVersion) {
  const errors = [];
  const stable = manifests.filter((manifest) => manifest.status === "stable");
  const development = manifests.filter((manifest) => manifest.status === "development");

  if (stable.length === 0) errors.push("At least one stable release manifest is required.");
  if (development.length !== 1)
    errors.push("Exactly one unreleased development manifest is required.");
  if (!stable.some((manifest) => manifest.version === `v${packageVersion}`)) {
    errors.push(`A stable manifest for package version v${packageVersion} is required.`);
  }

  for (const manifest of manifests) {
    if (manifest.status === "stable" && !/^v\d+\.\d+\.\d+$/.test(manifest.version)) {
      errors.push(`Stable manifest has an invalid version: ${manifest.version}`);
    }
    if (manifest.status === "development" && manifest.version !== "unreleased") {
      errors.push("The development manifest must use version 'unreleased'.");
    }
    if (!Array.isArray(manifest.interactionChoices) || manifest.interactionChoices.length !== 2) {
      errors.push(`${manifest.version} must define exactly two primary interaction choices.`);
    } else if (
      !manifest.interactionChoices.some((choice) => choice.runtimeValue === "chat") ||
      !manifest.interactionChoices.some((choice) => choice.runtimeValue === "smart")
    ) {
      errors.push(`${manifest.version} must map one choice to chat and one to smart.`);
    }
    if (!Array.isArray(manifest.missionControl) || manifest.missionControl.length === 0) {
      errors.push(`${manifest.version} must document at least one Mission Control path.`);
    }
    for (const entry of manifest.missionControl || []) {
      if (
        !entry.interface ||
        !["available", "not available"].includes(entry.availability) ||
        (entry.availability === "available" && !entry.path)
      ) {
        errors.push(`${manifest.version} has an incomplete Mission Control entry.`);
      }
    }
  }

  return errors;
}

export function renderReleaseSurfaceReference(manifests) {
  const development = manifests.find((manifest) => manifest.status === "development");
  const ordered = [
    ...manifests
      .filter((manifest) => manifest.status === "stable")
      .sort((a, b) => compareVersions(b.version, a.version)),
    ...manifests.filter((manifest) => manifest.status === "development"),
  ];
  const rows = ordered.map((manifest) => {
    const release =
      manifest.status === "stable" ? `${manifest.version} stable` : "Unreleased development";
    const choices = manifest.interactionChoices
      .map((choice) => {
        const developmentChoice = development?.interactionChoices.find(
          (candidate) => candidate.runtimeValue === choice.runtimeValue,
        );
        const currentLabel =
          developmentChoice && developmentChoice.label !== choice.label
            ? ` (${developmentChoice.label} in development)`
            : "";
        return `${choice.label}${currentLabel}`;
      })
      .join(" / ");
    const paths = manifest.missionControl
      .map((entry) =>
        entry.availability === "available"
          ? `${entry.interface}: ${entry.path}`
          : `${entry.interface}: not available`,
      )
      .join("; ");
    return `| ${release} | ${choices} | ${paths} |`;
  });

  return [
    "# Release Surface Reference",
    "",
    "Generated from `docs/release-surfaces/*.json`. Do not edit this table by hand.",
    "",
    "Parentheses show the corresponding current development label for the same work choice. Navigation is shown per release and interface so a guide does not send users to a destination their app does not expose.",
    "",
    "| Release | Primary work choices | Mission Control location |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "When cutting a release, copy the development manifest to a versioned stable manifest, verify its routes against that release tag, then update the development manifest for the next code state.",
    "",
  ].join("\n");
}

export function loadReleaseSurfaceManifests(directory = manifestsDir) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(directory, name), "utf8")));
}

export function main(args = process.argv.slice(2)) {
  const packageVersion = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ).version;
  const manifests = loadReleaseSurfaceManifests();
  const errors = validateReleaseSurfaceManifests(manifests, packageVersion);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const output = renderReleaseSurfaceReference(manifests);
  if (args.includes("--check")) {
    if (readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n") !== output) {
      console.error(
        "docs/release-surface-reference.md is stale; run npm run docs:surfaces:generate.",
      );
      process.exitCode = 1;
    } else console.log("Release surface reference is current.");
    return;
  }

  writeFileSync(outputPath, output);
  console.log("Generated docs/release-surface-reference.md.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
