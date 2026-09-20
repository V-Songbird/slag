// The check runner. Admission is the only thing that turns a file into coverage here, so the
// cases that matter are the ones where it could quietly say yes: a fixture it cannot read, a check
// that catches its own near miss, and a tree it could not look at reported as clean.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { checks, clean, CONFIG, mount, project, repo, task, TREE } from './temp-project.js';

function ready(extra = {}) {
  const root = project({ ...TREE, ...extra });
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  return root;
}

const ALWAYS = "export const id = 'always';\nexport const what = 'everything';\nexport function check() { return { fires: true, reason: 'always' }; }\n";

test('the shipped check is admitted by catching every violation and no near miss', () => {
  const root = ready();
  const out = checks(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /ok {3}scope — 5 violation\(s\) caught, 6 near miss\(es\) left alone/);
  clean(root);
});

test('a fixture that does not parse discards its check instead of crashing the run', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'checks', 'scope.nearmiss-broken.json'), '{ not json }', 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.doesNotMatch(out.stderr, /SyntaxError/);
  assert.match(out.stdout, /FAIL scope — .*does not parse/);
  assert.match(out.stdout, /discarded/);
  assert.equal(existsSync(join(root, '.collet', 'checks', 'discarded.json')), true);
  clean(root);
});

test('a check that fires on its own near miss is discarded and named', () => {
  const root = ready();
  const dir = join(root, '.collet', 'checks');
  writeFileSync(join(dir, 'always.mjs'), ALWAYS, 'utf8');
  writeFileSync(join(dir, 'always.violation.json'), JSON.stringify({ setup: [], task: null, call: {} }), 'utf8');
  writeFileSync(join(dir, 'always.nearmiss.json'), JSON.stringify({ setup: [], task: null, call: {} }), 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAIL always/);
  const discarded = JSON.parse(readFileSync(join(dir, 'discarded.json'), 'utf8'));
  assert.equal(discarded.discarded[0].id, 'always');
  clean(root);
});

test('a check with no fixture pair is not coverage', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'checks', 'lonely.mjs'), ALWAYS.replace('always', 'lonely'), 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /needs at least one \.violation and one \.nearmiss fixture/);
  clean(root);
});

test('a check that will not even load is reported, not skipped', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'checks', 'broken.mjs'), 'this is not a module {{{', 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAIL broken — could not load/);
  clean(root);
});

test('live says nothing is enforced when nothing is open', () => {
  const root = ready();
  const out = checks(root, ['--live']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /no task is open/);
  clean(root);
});

test('a tree it could not read is skipped, never printed as ok', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = checks(root, ['--live']); // no git repository here
  assert.match(out.stdout, /skip scope — not a git repository/);
  assert.doesNotMatch(out.stdout, /ok {3}scope/);
  assert.equal(out.status, 0);
  clean(root);
});

test('--strict makes a check that could not run a failure', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = checks(root, ['--live', '--strict']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /--strict counts that as a failure/);
  clean(root);
});

test('live reports the files that landed outside the task', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'report.mjs'), 'export const r = 99;\n', 'utf8');
  const out = checks(root, ['--live']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /fail scope — changed outside the open task t1: src\/report\.mjs/);
  clean(root);
});

test('live is quiet once everything is back inside the task', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'cli.mjs'), "import { build } from './digest.mjs';\nexport const run = () => build() + 1;\n", 'utf8');
  const out = checks(root, ['--live']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /ok {3}scope — everything changed is inside the task/);
  clean(root);
});
