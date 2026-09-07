import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from './validate-doc-versions.mjs';

const check = (text, path = 'docs/example.md', version = '0.5.52') => validateDocument(path, text, version);
test('rejects the original obsolete support table in any guide', () => {
  for (const path of ['SECURITY.md', 'docs/security.md', 'README.md', 'new-guide.md']) {
    assert.ok(check('## Supported Versions\n| 0.2.x | Yes |\n| 0.1.x | Yes |', path).length >= 2);
  }
});
test('rolling policy survives minor and major release bumps', () => {
  const policy = '## Supported Versions\n[Latest stable release](https://github.com/CoWork-OS/CoWork-OS/releases/latest) | Yes';
  for (const version of ['0.5.53', '0.6.0', '1.0.0']) assert.deepEqual(check(policy, 'SECURITY.md', version), []);
});
test('catches stale current release claims and accepts matching versions', () => {
  for (const text of ['Current version: 0.2.0', '**Latest stable release**: `v0.2.0`', '| Latest release | v0.2.0 |']) assert.equal(check(text).length, 1);
  assert.deepEqual(check('Current version: 0.5.52'), []);
  assert.equal(check('Current version: 0.5.52', 'README.md', '0.6.0').length, 1);
});
test('preserves history, snapshots, examples and compatibility references', () => {
  for (const path of ['CHANGELOG.md', 'docs/changelog.md', 'docs/release-notes-0.2.0.md', 'docs/public-adoption-stats.md']) assert.deepEqual(check('Latest release: 0.2.0', path), []);
  assert.deepEqual(check('Requires 0.3.0 or later\n```\nCurrent version: 0.2.0\n```'), []);
  assert.deepEqual(check('## Supported Versions\nLatest stable release\n## Compatibility\nmacOS 12 supports 0.5.51.'), []);
});
test('requires canonical latest release link in security policy', () => {
  assert.ok(check('## Supported Versions\nLatest stable release', 'SECURITY.md').length);
});
