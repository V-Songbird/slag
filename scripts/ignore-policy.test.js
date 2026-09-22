'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const harness = import('../collet/tests/temp-project.js');

async function checkPaths(t, filename, cases) {
  const { project, clean } = await harness;
  const fixture = project({
    '.gitignore': readFileSync(path.join(root, filename), 'utf8'),
    'empty-global-ignore': '',
  });
  t.after(() => clean(fixture));
  const initialized = spawnSync('git', ['init', '-q', fixture], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const [name, expectedIgnored] of cases) {
    const result = spawnSync('git', [
      '-C', fixture, '-c', 'core.excludesFile=' + path.join(fixture, 'empty-global-ignore'),
      'check-ignore', '--no-index', '-q', '--', name,
    ], { encoding: 'utf8' });
    assert.ok([0, 1].includes(result.status), result.stderr);
    assert.equal(result.status === 0, expectedIgnored, filename + ': ' + name);
  }
}

const privateDocuments = [
  '.private/raw/session.jsonl',
  'docs/tasks/current.md',
  'docs/decisions/architecture.md',
  'docs/knowledge/private/research.md',
  'docs/knowledge/private/nested/trial.md',
  'docs/apis/private/service-notes.md',
];
const publicProduct = [
  'README.md', 'AGENTS.md', 'CLAUDE.md',
  'docs/README.md', 'docs/knowledge/algorithm.md', 'docs/apis/client.md',
  'docs/knowledge/privacy-model.md', 'docs/apis/private-service.md',
  '.codex/config.toml', '.codex/hooks.json', '.agents/plugins/marketplace.json',
  '.claude/settings.json', '.claude/skills/example/SKILL.md',
  'src/main.js', 'tests/fixtures/example.json',
];

test('Slag protects private subdirectories without hiding public product documentation', async (t) => {
  await checkPaths(t, '.gitignore', privateDocuments.map(name => [name, true])
    .concat(publicProduct.map(name => [name, false])));
});
