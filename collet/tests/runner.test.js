// The check runner. Admission is the only thing that turns a file into coverage here, so the
// cases that matter are the ones where it could quietly say yes: a fixture it cannot read, a check
// that catches its own near miss, and a tree it could not look at reported as clean.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { checks, CONFIG, mount, project, repo, task, TREE } from './temp-project.js';

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
});

test('a check with no fixture pair is not coverage', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'checks', 'lonely.mjs'), ALWAYS.replace('always', 'lonely'), 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /needs at least one \.violation and one \.nearmiss fixture/);
});

test('a check that will not even load is reported, not skipped', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'checks', 'broken.mjs'), 'this is not a module {{{', 'utf8');
  const out = checks(root);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /FAIL broken — could not load/);
});

test('live says nothing is enforced when nothing is open', () => {
  const root = ready();
  const out = checks(root, ['--live']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /no task is open/);
});

test('a tree it could not read is skipped, never printed as ok', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = checks(root, ['--live']); // no git repository here
  assert.match(out.stdout, /skip scope — not a git repository/);
  assert.doesNotMatch(out.stdout, /ok {3}scope/);
  assert.equal(out.status, 0);
});

test('--strict makes a check that could not run a failure', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = checks(root, ['--live', '--strict']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /--strict counts that as a failure/);
});

for (const [name, body] of [
  ['a missing return', ''],
  ['null', 'return null;'],
  ['an empty object', 'return {};'],
  ['a non-boolean verdict', 'return { fires: "false" };'],
  ['a Promise resolving to a violation', 'return Promise.resolve({ fires: true, reason: "violation" });'],
]) {
  test(`live refuses ${name} instead of accepting an unevaluated result`, () => {
    const root = ready({
      'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
    });
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

test('an explicit skipped result without a verdict keeps standalone and strict policy distinct', () => {
  const root = ready();
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

test('every live check in a pass shares one cache, and the next pass starts a new one', () => {
  const root = ready();
  for (const name of ['first', 'second']) {
    writeFileSync(join(root, '.collet', 'checks', `${name}.mjs`), [
      `export const id = '${name}';`,
      'export function check() { return { fires: false }; }',
      "export function live({ cache }) { const seen = (cache.get('seen') ?? 0) + 1; cache.set('seen', seen); return { fires: false, reason: `check ${seen} of this pass` }; }",
    ].join('\n'), 'utf8');
  }
  repo(root);
  assert.equal(task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']).status, 0);
  for (let pass = 0; pass < 2; pass++) {
    const out = checks(root, ['--live']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /ok {3}first — check 1 of this pass/);
    assert.match(out.stdout, /ok {3}second — check 2 of this pass/);
  }
});

// A --live pass lists the changes twice on purpose: once for every bundle check together, through
// the pass cache, and once for the scope check on its own (see live() in checks/scope.mjs). Git is
// counted by wrapping execFileSync before the runner loads, so no check changes to be counted.
test('a live pass lists the changes once for every bundle check and once for scope', () => {
  const root = project({ ...TREE, 'package.json': '{"private":true}\n' });
  const mounted = mount(root, ['--checks']);
  assert.equal(mounted.status, 0, mounted.stdout + mounted.stderr);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  repo(root);
  assert.equal(task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']).status, 0);
  writeFileSync(join(root, 'src', 'cli.mjs'), "import { build } from './digest.mjs';\nexport const run = () => build() + 1;\n", 'utf8');
  const counter = project({
    'count-git.mjs': [
      "import childProcess from 'node:child_process';",
      "import { appendFileSync } from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const original = childProcess.execFileSync;',
      'childProcess.execFileSync = function (file, args, ...rest) {',
      "  if (file === 'git') appendFileSync(process.env.COLLET_GIT_LOG, `${args.join(' ')}\\n`);",
      '  return original.call(this, file, args, ...rest);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
  });
  const log = join(counter, 'git.log');
  const out = spawnSync(process.execPath, ['--import', pathToFileURL(join(counter, 'count-git.mjs')).href, join(root, '.collet', 'checks', 'run.mjs'), '--live'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, COLLET_GIT_LOG: log },
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.split('\n').filter((line) => /^ok {3}javascript-typescript\./.test(line)).length > 1, out.stdout);
  assert.match(out.stdout, /ok {3}scope — everything changed is inside the task/);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  const listings = calls.filter((call) => call.startsWith('diff ')).map((call) => (call.includes('--no-renames') ? 'scope' : 'bundle'));
  assert.deepEqual(listings.sort(), ['bundle', 'scope'], calls.join('\n'));
  assert.equal(calls.filter((call) => call.startsWith('ls-files ')).length, 2, calls.join('\n'));
});

test('live reports the files that landed outside the task', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'report.mjs'), 'export const r = 99;\n', 'utf8');
  const out = checks(root, ['--live']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /fail scope — changed outside the open task t1: src\/report\.mjs/);
});

test('live is quiet once everything is back inside the task', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'cli.mjs'), "import { build } from './digest.mjs';\nexport const run = () => build() + 1;\n", 'utf8');
  const out = checks(root, ['--live']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /ok {3}scope — everything changed is inside the task/);
});
