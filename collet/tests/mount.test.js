// The installer. It is the half that must be identical every time, so every claim the skill makes
// about what mounting does is checked here rather than trusted.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { clean, mount, project, TREE } from './temp-project.js';

test('the rules block reaches every surface an agent reads', () => {
  const root = project({ ...TREE, '.cursor/rules/.keep': '' });
  mount(root);
  for (const surface of ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/collet.md']) {
    assert.match(readFileSync(join(root, surface), 'utf8'), /collet:begin/, surface);
  }
  clean(root);
});

test('mounting twice does not duplicate the block', () => {
  const root = project(TREE);
  mount(root);
  const once = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  mount(root);
  const twice = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(once, twice);
  assert.equal(twice.split('collet:begin').length - 1, 1);
  clean(root);
});

test("a project's own text survives a mount and a remount", () => {
  const root = project({ ...TREE, 'AGENTS.md': '# House rules\n\nCommit messages are in English.\n' });
  mount(root);
  mount(root);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /Commit messages are in English/);
  assert.match(text, /collet:begin/);
  clean(root);
});

test('an existing config is kept, and only a missing accept command is filled in', () => {
  const root = project(TREE);
  mount(root);
  writeFileSync(
    join(root, '.collet', 'config.json'),
    JSON.stringify({ project: 'mine', conventions: [], accept: 'REPLACE ME: x' }),
    'utf8'
  );
  mount(root, ['--accept', 'npm test']);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.equal(config.project, 'mine');
  assert.equal(config.accept, 'npm test');
  clean(root);
});

test('the placeholders leave no room to mistake them for a decision', () => {
  const root = project(TREE);
  mount(root);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.match(config.project, /^REPLACE ME/);
  assert.match(config.accept, /^REPLACE ME/);
  assert.equal(config.verifier, undefined);
  clean(root);
});

test('every check a project receives arrives with the fixtures that admit it', () => {
  const root = project(TREE);
  mount(root);
  const dir = join(root, '.collet', 'checks');
  const checks = readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'run.mjs');
  assert.ok(checks.length > 0);
  for (const file of checks) {
    const id = file.replace(/\.mjs$/, '');
    const fixtures = readdirSync(dir).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.json'));
    assert.ok(fixtures.some((name) => name.startsWith(`${id}.violation`)), `${id} has no violation`);
    assert.ok(fixtures.some((name) => name.startsWith(`${id}.nearmiss`)), `${id} has no near miss`);
  }
  assert.equal(existsSync(join(dir, 'run.mjs')), true);
  clean(root);
});

test('what a session regenerates is not committed', () => {
  const root = project(TREE);
  mount(root);
  const ignore = readFileSync(join(root, '.collet', '.gitignore'), 'utf8');
  for (const name of ['guard-log.jsonl', 'handoff.md', 'checks/discarded.json', 'off']) {
    assert.match(ignore, new RegExp(name.replace('/', '\\/')), name);
  }
  clean(root);
});

test('the rules a project receives name commands that work in that project', () => {
  const own = project(TREE);
  mount(own);
  const mine = readFileSync(join(own, 'AGENTS.md'), 'utf8');
  assert.match(mine, /node \.collet\/task\.mjs widen/);
  assert.match(mine, /node \.collet\/task\.mjs close/);
  assert.doesNotMatch(mine, /\{\{/);

  const planned = project({ ...TREE, 'ROADMAP.jsonl': '{"foreman_roadmap_format":2}\n' });
  mount(planned);
  const theirs = readFileSync(join(planned, 'AGENTS.md'), 'utf8');
  assert.match(theirs, /ROADMAP\.jsonl/);
  assert.doesNotMatch(theirs, /node \.collet\/task\.mjs widen/);
  assert.doesNotMatch(theirs, /\{\{/);
  clean(own);
  clean(planned);
});

test('mounting refuses a directory that is not there rather than creating one', () => {
  const out = mount(join(project({}), 'nope'));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage:/);
});
