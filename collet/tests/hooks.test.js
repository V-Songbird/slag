// The three hooks, driven the way the host drives them: the event on stdin, the project in the
// environment, and only whatever they print to judge them by.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { clean, CONFIG, hook, hookOutput, mount, project, task, TREE } from './temp-project.js';

function ready(extra = {}) {
  const root = project({ ...TREE, ...extra });
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  return root;
}

test('every hook is silent in a project that does not use collet', () => {
  const root = project(TREE);
  for (const name of ['session-start.js', 'guard.js', 'handoff.js']) {
    const out = hook(name, root, { tool_name: 'Write', tool_input: { file_path: 'anything.txt' } });
    assert.equal(out.stdout, '', name);
    assert.equal(out.status, 0, name);
  }
  clean(root);
});

test('the kill switch turns every hook off, and it is a file somebody chose to create', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const before = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  assert.equal(hookOutput(before).permissionDecision, 'deny');
  writeFileSync(join(root, '.collet', 'off'), '', 'utf8');
  const after = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  assert.equal(after.stdout, '');
  clean(root);
});

test('session start states the task, its files and the command that ends it', () => {
  const root = ready();
  task(root, ['add', '--title', 'window the digest', '--why', 'w', '--scope', 'src/cli.mjs']);
  const context = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.match(context, /A digest CLI/);
  assert.match(context, /The open task is t1 — "window the digest"/);
  assert.match(context, /src\/cli\.mjs/);
  assert.match(context, /node -e 0/);
  assert.match(context, /Dates are parsed in one place/);
  clean(root);
});

test('a placeholder is not a fact, so it is never stated', () => {
  const root = project(TREE);
  mount(root);
  const context = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.doesNotMatch(context, /REPLACE ME/);
  assert.match(context, /No task is open/);
  clean(root);
});

test('a handoff for a task that is no longer open is dropped, not read out', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  hook('handoff.js', root, { trigger: 'auto' });
  const handoff = join(root, '.collet', 'handoff.md');
  assert.match(readFileSync(handoff, 'utf8'), /task: t1/);

  const carried = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.match(carried, /State carried over/);

  // Rewrite it as if it were left behind by an older, finished task.
  writeFileSync(handoff, '# Handoff\n\ntask: t0\n\nsomething long finished\n', 'utf8');
  const context = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.doesNotMatch(context, /something long finished/);
  assert.throws(() => readFileSync(handoff, 'utf8'));
  clean(root);
});

test('the compaction note is not written when nothing is open', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'handoff.md'), '# Handoff\n\ntask: t9\n', 'utf8');
  hook('handoff.js', root, { trigger: 'manual' });
  assert.throws(() => readFileSync(join(root, '.collet', 'handoff.md'), 'utf8'));
  clean(root);
});

test('the guard names a remedy that works in this project', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const reason = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } })
  ).permissionDecisionReason;
  assert.match(reason, /node \.collet\/task\.mjs widen/);
  clean(root);
});

test('the guard records what it refused', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  const log = readFileSync(join(root, '.collet', 'guard-log.jsonl'), 'utf8');
  assert.match(log, /"task":"t1"/);
  assert.match(log, /src\/theme\.mjs/);
  clean(root);
});

test("a missing project check falls back to the plugin's own copy rather than disarming", () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, '.collet', 'checks', 'scope.mjs'), 'this is not a module {{{', 'utf8');
  const out = hookOutput(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } }));
  assert.equal(out.permissionDecision, 'deny');
  clean(root);
});

test('with no task open the guard allows everything, and says nothing', () => {
  const root = ready();
  const out = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'anything.txt' } });
  assert.equal(out.stdout, '');
  clean(root);
});
