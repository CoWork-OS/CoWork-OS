#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const skillsDir = path.join(process.cwd(), 'resources', 'skills');
const files = fs
  .readdirSync(skillsDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

const warnings = [];
const errors = [];

const has = (value) => typeof value === 'string' && value.trim().length > 0;

for (const file of files) {
  const filePath = path.join(skillsDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  let skill;

  try {
    skill = JSON.parse(raw);
  } catch (error) {
    errors.push({ file, issue: `Invalid JSON: ${error.message}` });
    continue;
  }

  const routing = skill?.metadata?.routing;
  if (!routing) {
    errors.push({
      file,
      issue:
        'metadata.routing is missing. All skills should define routing metadata to support deterministic use_skill selection.',
    });
    continue;
  }

  const prompt = String(skill.prompt || '');
  const expectedArtifacts = Array.isArray(routing.expectedArtifacts)
    ? routing.expectedArtifacts
    : [];

  const artifactFromPrompt = new Set();
  const artifactMatches = [
    ...prompt.matchAll(/\{artifactDir\}\/([A-Za-z0-9._{}-]+(?:\/[A-Za-z0-9._{}-]+)*)/g),
  ];
  for (const match of artifactMatches) {
    if (match[1]) {
      artifactFromPrompt.add(match[1]);
    }
  }

  if (!has(routing.useWhen)) {
    errors.push({ file, issue: 'metadata.routing.useWhen must be a non-empty string.' });
  }

  if (!has(routing.dontUseWhen)) {
    warnings.push({ file, issue: 'metadata.routing.dontUseWhen is missing or empty.' });
  }

  if (!has(routing.outputs)) {
    warnings.push({ file, issue: 'metadata.routing.outputs is missing or empty.' });
  }

  if (!has(routing.successCriteria)) {
    warnings.push({ file, issue: 'metadata.routing.successCriteria is missing or empty.' });
  }

  if (expectedArtifacts.length === 0) {
    if (prompt.includes('{artifactDir}')) {
      warnings.push({
        file,
        issue:
          'Prompt references {artifactDir} but expectedArtifacts is not declared. Consider adding artifact names.',
      });
    }
  } else {
    if (prompt.includes('{artifactDir}') === false) {
      warnings.push({
        file,
        issue:
          'expectedArtifacts is set but prompt has no {artifactDir} reference. Ensure this is intentional.',
      });
    }

    for (const artifact of expectedArtifacts) {
      if (!artifactFromPrompt.has(artifact)) {
        warnings.push({
          file,
          issue: `expectedArtifacts contains "${artifact}" but prompt does not reference {artifactDir}/${artifact}.`,
        });
      }
    }
  }

  if (routing.useWhen && /Use when the user asks for/i.test(routing.useWhen)) {
    warnings.push({
      file,
      issue:
        'routing.useWhen still uses old generic form "Use when the user asks for ..."; consider "asks to ..." for consistency.',
    });
  }

  if (routing.dontUseWhen && /non-tool-related conversation/i.test(routing.dontUseWhen)) {
    warnings.push({
      file,
      issue:
        'routing.dontUseWhen contains broad phrase "non-tool-related conversation"; use explicit non-target contexts instead.',
    });
  }
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('[skills-routing] OK: 0 errors, 0 warnings');
  process.exit(0);
}

console.log(`[skills-routing] Checked ${files.length} skills`);
console.log(`[skills-routing] Errors: ${errors.length}`);
for (const item of errors) {
  console.log(`- ERROR: ${item.file}: ${item.issue}`);
}
console.log(`[skills-routing] Warnings: ${warnings.length}`);
for (const item of warnings) {
  console.log(`- WARN: ${item.file}: ${item.issue}`);
}

process.exit(errors.length === 0 ? 0 : 1);
