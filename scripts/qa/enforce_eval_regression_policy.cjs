/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EVAL_CASE_PREFIX = 'scripts/qa/eval-cases/';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function getChangedFiles(base, head) {
  const range = base && head ? `${base}...${head}` : 'HEAD~1..HEAD';
  const out = runGit(['diff', '--name-only', range]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function parsePullRequestContext() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const eventPath = process.env.GITHUB_EVENT_PATH || '';

  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    return null;
  }

  const event = eventPath && fs.existsSync(eventPath) ? readJson(eventPath) : null;
  const pr = event && event.pull_request ? event.pull_request : null;
  if (!pr) return null;

  return {
    title: String(pr.title || ''),
    body: String(pr.body || ''),
    baseSha: String(pr.base && pr.base.sha ? pr.base.sha : ''),
    headSha: String(pr.head && pr.head.sha ? pr.head.sha : ''),
  };
}

function isProductionFailureFix(title, body) {
  const text = `${title}\n${body}`;

  // Explicit PR template checkbox (preferred)
  const explicitChecked =
    /-\s*\[[xX]\]\s*This PR fixes a production failure\/incident\.?/i.test(text) ||
    /-\s*\[[xX]\]\s*Production failure fix\.?/i.test(text);
  if (explicitChecked) return true;

  // Fallback keyword detection
  const lowered = text.toLowerCase();
  const keywords = [
    'production incident',
    'production failure',
    'prod incident',
    'prod failure',
    'outage',
    'sev-1',
    'sev1',
    'hotfix',
    'postmortem',
  ];
  return keywords.some((kw) => lowered.includes(kw));
}

function hasEvalCaseChange(files) {
  return files.some((file) => file.startsWith(EVAL_CASE_PREFIX) && file.endsWith('.json'));
}

function main() {
  const prContext = parsePullRequestContext();
  if (!prContext) {
    console.log('[regression-policy] Not a pull_request event. Skipping enforcement.');
    return;
  }

  const changedFiles = getChangedFiles(prContext.baseSha, prContext.headSha);
  const productionFix = isProductionFailureFix(prContext.title, prContext.body);
  const evalCaseUpdated = hasEvalCaseChange(changedFiles);

  console.log(`[regression-policy] changed files: ${changedFiles.length}`);
  console.log(`[regression-policy] production fix detected: ${productionFix ? 'yes' : 'no'}`);
  console.log(`[regression-policy] eval case updated: ${evalCaseUpdated ? 'yes' : 'no'}`);

  if (productionFix && !evalCaseUpdated) {
    console.error(
      '[regression-policy] Production failure fix detected, but no eval regression case was added/updated under scripts/qa/eval-cases/*.json',
    );
    console.error(
      '[regression-policy] Add or update at least one eval case file before merge.',
    );
    process.exit(1);
  }

  if (!productionFix && evalCaseUpdated) {
    console.log(
      '[regression-policy] Eval case updated without production-fix marker. This is allowed and encouraged.',
    );
  }

  console.log('[regression-policy] OK');
}

main();
