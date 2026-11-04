'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compare } = require('./plugin-parity.js');

const harness = import('../collet/tests/temp-project.js');
const SCRIPT = path.join(__dirname, 'plugin-parity.js');

const guard = (command, timeout) => JSON.stringify({
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout }] }],
});
const plugin = {
  '.claude-plugin/plugin.json': '{ "name": "fixture" }\n',
  'hooks/hooks.json': `{ "hooks": ${guard('node guard.js', 5)} }\n`,
  'hooks/codex-hooks.json': `{ "hooks": ${guard('node "${PLUGIN_ROOT}/hooks/guard.js"', 5)} }\n`,
  'hooks.json': `{ "fixture": ${guard('node ./hooks/guard.js', 5)} }\n`,
  'hooks/guard.js': 'process.exit(0);\n',
  'README.md': '# Fixture\n',
};

// A tracked plugin and an installed copy of it, with the host's .in_use marker and no .git.
async function fixture() {
  const { project, repo } = await harness;
  const source = project(plugin);
  repo(source);
  const installed = project();
  cpSync(source, installed, { recursive: true });
  rmSync(path.join(installed, '.git'), { recursive: true, force: true });
  mkdirSync(path.join(installed, '.in_use'));
  writeFileSync(path.join(installed, '.in_use', '123'), '');
  return { source, installed };
}

test('a matching install reports nothing, and the .in_use marker is not a difference', async () => {
  const { source, installed } = await fixture();
  assert.deepEqual(compare(source, installed), { changed: [], added: [], missing: [], hooks: [] });
});

test('reports a file whose bytes differ', async () => {
  const { source, installed } = await fixture();
  writeFileSync(path.join(installed, 'README.md'), '# Fixture, edited\n');
  assert.deepEqual(compare(source, installed), { changed: ['README.md'], added: [], missing: [], hooks: [] });
});

test('reports an installed file the source does not track and a tracked file the install lacks', async () => {
  const { source, installed } = await fixture();
  writeFileSync(path.join(installed, 'extra.md'), 'extra\n');
  rmSync(path.join(installed, 'hooks', 'guard.js'));
  assert.deepEqual(compare(source, installed), {
    changed: [], added: ['extra.md'], missing: ['hooks/guard.js'], hooks: [],
  });
});

test('reports the hook event whose definition changed, and only in the file that changed', async () => {
  const { source, installed } = await fixture();
  writeFileSync(path.join(installed, 'hooks', 'hooks.json'), `{ "hooks": ${guard('node guard.js', 6)} }\n`);
  assert.deepEqual(compare(source, installed), {
    changed: ['hooks/hooks.json'],
    added: [],
    missing: [],
    hooks: [{ file: 'hooks/hooks.json', event: 'PreToolUse', difference: 'changed' }],
  });
});

test('the command exits 0 on a match and 1 with one line per difference', async () => {
  const { source, installed } = await fixture();
  const run = () => spawnSync(process.execPath, [SCRIPT, source, installed], { encoding: 'utf8' });
  const match = run();
  assert.equal(match.status, 0, match.stderr);
  assert.equal(match.stdout.trim(), 'parity: no differences');
  writeFileSync(path.join(installed, 'hooks', 'hooks.json'), `{ "hooks": ${guard('node guard.js', 6)} }\n`);
  const differs = run();
  assert.equal(differs.status, 1, differs.stderr);
  assert.deepEqual(differs.stdout.trim().split(/\r?\n/), [
    'changed hooks/hooks.json',
    'hook hooks/hooks.json PreToolUse changed',
  ]);
});
