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

for (const [name, body] of [
  ['a missing return', ''],
  ['null', 'return null;'],
  ['an empty object', 'return {};'],
  ['a non-boolean verdict', 'return { fires: "false" };'],
  ['a Promise resolving to a violation', 'return Promise.resolve({ fires: true, reason: "violation" });'],
]) {
  test(`live refuses ${name} instead of accepting an unevaluated result`, (t) => {
    const root = ready({
      'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
    });
    t.after(() => clean(root));
    writeFileSync(join(root, '.collet', 'checks', 'invalid-result.mjs'), [
      "export const id = 'invalid-result';",
      'export function check() { return { fires: false }; }',
      `export function live() { ${body} }`,
    ].join('\n'), 'utf8');
    repo(root);
    const opened = task(root, [
      'add', '--title', 'Check the verdict', '--why', 'No missing result may pass',
      '--scope', 'src/cli.mjs', '--accept', 'node accept.mjs',
    ]);
    assert.equal(opened.status, 0, opened.stderr);
    for (const args of [['--live'], ['--live', '--strict']]) {
      const out = checks(root, args);
      assert.equal(out.status, 1, out.stdout + out.stderr);
      assert.match(out.stdout, /fail invalid-result — live\(\) must return a synchronous result/);
      assert.doesNotMatch(out.stdout, /ok\s+invalid-result|skip invalid-result/);
      assert.match(out.stdout, /ok\s+scope — everything changed is inside the task/);
    }
    const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
    const close = task(root, ['close', '--left-out', 'none', '--unverified', 'none']);
    assert.equal(close.status, 1, close.stdout + close.stderr);
    assert.equal(existsSync(join(root, 'accept-ran')), false);
    assert.equal(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), ledger);
  });
}

test('an explicit skipped result without a verdict keeps standalone and strict policy distinct', (t) => {
  const root = ready();
  t.after(() => clean(root));
  writeFileSync(join(root, '.collet', 'checks', 'unavailable.mjs'), [
    "export const id = 'unavailable';",
    'export function check() { return { fires: false }; }',
    'export function live() { return { skipped: true, reason: "input unavailable" }; }',
  ].join('\n'), 'utf8');
  repo(root);
  assert.equal(task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']).status, 0);
  const ordinary = checks(root, ['--live']);
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
  assert.match(ordinary.stdout, /skip unavailable — input unavailable/);
  assert.doesNotMatch(ordinary.stdout, /ok\s+unavailable|fail unavailable/);
  const strict = checks(root, ['--live', '--strict']);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /skip unavailable — input unavailable/);
  assert.match(strict.stdout, /1 check\(s\) could not run, and --strict counts that as a failure/);
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
