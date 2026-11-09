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

test('reports a changed event in the Codex hook file', async () => {
  const { source, installed } = await fixture();
  writeFileSync(path.join(installed, 'hooks', 'codex-hooks.json'),
    `{ "hooks": ${guard('node "${PLUGIN_ROOT}/hooks/guard.js"', 6)} }\n`);
  assert.deepEqual(compare(source, installed), {
    changed: ['hooks/codex-hooks.json'],
    added: [],
    missing: [],
    hooks: [{ file: 'hooks/codex-hooks.json', event: 'PreToolUse', difference: 'changed' }],
  });
});

test('reads the plugin-root hook file under the plugin name, not its first key', async () => {
  const { source, installed } = await fixture();
  const other = JSON.stringify({ SessionStart: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] });
  writeFileSync(path.join(installed, 'hooks.json'),
    `{ "other": ${other}, "fixture": ${guard('node ./hooks/guard.js', 6)} }\n`);
  assert.deepEqual(compare(source, installed), {
    changed: ['hooks.json'],
    added: [],
    missing: [],
    hooks: [{ file: 'hooks.json', event: 'PreToolUse', difference: 'changed' }],
  });
});

test('a hook file the install lacks reports its events missing', async () => {
  const { source, installed } = await fixture();
  rmSync(path.join(installed, 'hooks', 'codex-hooks.json'));
  assert.deepEqual(compare(source, installed), {
    changed: [],
    added: [],
    missing: ['hooks/codex-hooks.json'],
    hooks: [{ file: 'hooks/codex-hooks.json', event: 'PreToolUse', difference: 'missing' }],
  });
});

test('a tracked hook file deleted in the work tree is skipped, and its installed events read as added', async () => {
  const { source, installed } = await fixture();
  rmSync(path.join(source, 'hooks', 'codex-hooks.json'));
  assert.deepEqual(compare(source, installed), {
    changed: [],
    added: [],
    missing: [],
    hooks: [{ file: 'hooks/codex-hooks.json', event: 'PreToolUse', difference: 'added' }],
  });
});

test('a hook file that is not JSON is unreadable, unless both sides hold the same bytes', async () => {
  const { source, installed } = await fixture();
  writeFileSync(path.join(installed, 'hooks', 'hooks.json'), '{\n');
  assert.deepEqual(compare(source, installed), {
    changed: ['hooks/hooks.json'],
    added: [],
    missing: [],
    hooks: [{ file: 'hooks/hooks.json', event: '*', difference: 'unreadable' }],
  });
  writeFileSync(path.join(source, 'hooks', 'hooks.json'), '{\n');
  assert.deepEqual(compare(source, installed), { changed: [], added: [], missing: [], hooks: [] });
});

test('the command exits 2 when the source is not in a repository or has no plugin name', async () => {
  const { source, installed } = await fixture();
  const run = (args, env = process.env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  const untracked = run([installed, installed], { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(installed) });
  assert.equal(untracked.status, 2);
  assert.match(untracked.stderr, /^git ls-files failed in /);
  writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{}\n');
  const unnamed = run([source, installed]);
  assert.equal(unnamed.status, 2);
  assert.match(unnamed.stderr, /^cannot read the plugin name from /);
});

test('the command exits 2 on a usage error, an unreadable directory and a git that cannot start', async () => {
  const { source, installed } = await fixture();
  const run = (args, env = process.env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  const usage = run([source]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: /);
  const unreadable = run([source, path.join(installed, 'absent')]);
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /ENOENT/);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const noGit = run([source, installed], { ...env, PATH: '' });
  assert.equal(noGit.status, 2);
  assert.match(noGit.stderr, /^git ls-files could not start in /);
});
