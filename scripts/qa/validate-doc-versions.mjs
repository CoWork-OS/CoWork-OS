import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Historical records and generated, dated snapshots intentionally retain versions.
export function isHistorical(path) {
  return /(^|\/)changelog\.md$/i.test(path) ||
    /^docs\/release-notes-[^/]+\.md$/.test(path) ||
    path === 'docs/public-adoption-stats.md';
}

export function validateDocument(path, source, version) {
  if (isHistorical(path)) return [];
  const errors = [];
  let supportLevel = null;
  let fenced = false;
  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (supportLevel !== null && heading[1].length <= supportLevel) supportLevel = null;
      if (/supported (versions|releases)|support(ed)? (version|release) (policy|matrix)/i.test(heading[2])) {
        supportLevel = heading[1].length;
      }
    }
    if (supportLevel !== null && /\bv?\d+\.(?:\d+|x)(?:\.(?:\d+|x|\*))?\b/i.test(line)) {
      errors.push(`${path}:${index + 1}: Use the rolling latest-stable policy/link instead of pinned support versions.`);
    }
    const claims = line.matchAll(/\b(?:current|latest)\s+(?:stable\s+)?(?:release|version)\s*(?:is\s+)?[:*`|\s]*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gi);
    for (const claim of claims) {
      if (claim[1] !== version) errors.push(`${path}:${index + 1}: Version ${claim[1]} differs from package.json (${version}); use a latest-release link or update the claim.`);
    }
  }
  if (path === 'SECURITY.md' && !source.includes('https://github.com/CoWork-OS/CoWork-OS/releases/latest')) {
    errors.push('SECURITY.md: The security policy must link to the latest stable release.');
  }
  return errors;
}

export function main() {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  // Git inventory includes new docs locally, excludes ignored dependency/build trees,
  // and also works when the source tarball has no .git directory (walk fallback).
  let paths;
  try {
    paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
  } catch {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'release', 'vendor'].includes(entry.name)) return [];
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    });
    paths = walk('.');
  }
  const errors = [...new Set(paths)].filter(path => /\.md$/i.test(path) && existsSync(path)).flatMap(path =>
    validateDocument(path, readFileSync(path, 'utf8'), version));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Documentation version policy passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
