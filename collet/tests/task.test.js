// The task CLI. The cases that matter are the ones where the file said one thing and the code did
// another: a scope that closed over nothing, a widen that closed over nothing, a close that proved
// only half of what it claimed.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { clean, CONFIG, mount, project, repo, task, TREE } from './helpers.js';

function ready(extra = {}) {
  const root = project({ ...TREE, ...extra });
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  return root;
}

test('a glob scope is resolved before it is closed over', () => {
  const root = ready();
  // The form the installer itself prints. Skipping globs made the one mechanism here inert in
  // exactly the case everybody would hit first.
  const out = task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'test/**,src/cli.mjs']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /src\/digest\.mjs {2}\(imported by src\/cli\.mjs\)/);
  clean(root);
});

test('widen closes over what it adds, and says which file pulled each one', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/report.mjs']);
  const out = task(root, ['widen', '--add', 'src/digest.mjs', '--why', 'the window lives here']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /src\/theme\.mjs {2}\(imported by src\/digest\.mjs\)/);
  const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"the window lives here"/);
  assert.match(ledger, /"imported by src\/digest\.mjs"/);
  clean(root);
});

test('widening for one reason does not drag in what an already-listed file imports', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  // src/digest.mjs came in with the add and imports src/theme.mjs. Widening for an unrelated
  // file must not quietly collect it too.
  const out = task(root, ['widen', '--add', 'src/report.mjs', '--why', 'unrelated']);
  assert.doesNotMatch(out.stdout, /theme\.mjs/);
  clean(root);
});

test('a task cannot be opened while the config still carries its placeholders', () => {
  const root = project(TREE);
  mount(root);
  const out = task(root, ['add', '--title', 't', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node -e 0']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /still carries its placeholders/);
  clean(root);
});

test('an id is never handed out twice, even after a line is removed', () => {
  const root = ready();
  task(root, ['add', '--title', 'one', '--why', 'w', '--scope', 'src/cli.mjs']);
  task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  task(root, ['add', '--title', 'two', '--why', 'w', '--scope', 'src/report.mjs']);
  task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  const ledger = join(root, '.collet', 'ledger.jsonl');
  const kept = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).slice(1).join('\n');
  writeFileSync(ledger, kept + '\n', 'utf8');
  const out = task(root, ['add', '--title', 'three', '--why', 'w', '--scope', 'src/theme.mjs']);
  assert.match(out.stdout, /task t3 —/);
  clean(root);
});

test('a flag with no value is an error, not a scope of "--accept"', () => {
  const root = ready();
  const out = task(root, ['add', '--title', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--title needs a value/);
  clean(root);
});

test('an accept command is refused when empty', () => {
  const root = project(TREE);
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), JSON.stringify({ project: 'p', accept: '' }), 'utf8');
  const out = task(root, ['add', '--title', 't', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(out.status, 2);
  clean(root);
});

test('close proves the scope held before it runs the accept command', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'report.mjs'), 'export const r = 99;\n', 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /changes landed outside t1/);
  clean(root);
});

test('a new file the repository has never seen still counts as a change', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'stray.mjs'), 'export const x = 1;\n', 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /stray\.mjs/);
  clean(root);
});

test('a failing accept command leaves the task open', () => {
  const root = ready();
  repo(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG.replace('node -e 0', 'node no-such-file.mjs'), 'utf8');
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(out.status, 1);
  assert.match(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), /"status":"in_progress"/);
  clean(root);
});

test('close records what was left out and clears the handoff it replaces', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, '.collet', 'handoff.md'), '# Handoff\n\ntask: t1\n', 'utf8');
  const out = task(root, ['close', '--left-out', 'the until bound', '--unverified', 'nothing ran on a big repo']);
  assert.equal(out.status, 0, out.stderr);
  const unverified = readFileSync(join(root, '.collet', 'unverified.md'), 'utf8');
  assert.match(unverified, /nothing ran on a big repo/);
  assert.match(unverified, /left out: the until bound/);
  assert.throws(() => readFileSync(join(root, '.collet', 'handoff.md'), 'utf8'));
  clean(root);
});

test('close needs both claims, and "nothing" is an answer', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(task(root, ['close']).status, 2);
  assert.equal(task(root, ['close', '--left-out', 'nothing']).status, 2);
  assert.equal(task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']).status, 0);
  clean(root);
});

test('status reports the refusals the guard recorded', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(
    join(root, '.collet', 'guard-log.jsonl'),
    JSON.stringify({ at: '2026-09-19T10:00:00.000Z', task: 't1', tool: 'Write', reason: 'src/x.mjs is outside' }) + '\n',
    'utf8'
  );
  const out = task(root, ['status']);
  assert.match(out.stdout, /last 1 refusal/);
  assert.match(out.stdout, /src\/x\.mjs is outside/);
  clean(root);
});

test('a second task cannot be opened while one is still open', () => {
  const root = ready();
  task(root, ['add', '--title', 'one', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = task(root, ['add', '--title', 'two', '--why', 'w', '--scope', 'src/report.mjs']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /is still open/);
  clean(root);
});

test('a ledger line that does not parse does not stop the CLI', () => {
  const root = ready();
  task(root, ['add', '--title', 'one', '--why', 'w', '--scope', 'src/cli.mjs']);
  const ledger = join(root, '.collet', 'ledger.jsonl');
  writeFileSync(ledger, readFileSync(ledger, 'utf8') + '{ not json }\n', 'utf8');
  const out = task(root, ['status']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /task t1/);
  rmSync(ledger);
  clean(root);
});
