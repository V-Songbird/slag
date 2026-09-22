// The three hooks, driven the way the host drives them: the event on stdin, the project in the
// environment, and only whatever they print to judge them by.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CONFIG, hook, hookOutput, mount, PLUGIN, project, task, TREE } from './temp-project.js';

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
});

test('the kill switch turns every hook off, and it is a file somebody chose to create', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const before = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  assert.equal(hookOutput(before).permissionDecision, 'deny');
  writeFileSync(join(root, '.collet', 'off'), '', 'utf8');
  const after = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  assert.equal(after.stdout, '');
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
});

test('a placeholder is not a fact, so it is never stated', () => {
  const root = project(TREE);
  mount(root);
  const context = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.doesNotMatch(context, /REPLACE ME/);
  assert.match(context, /No task is open/);
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
});

test('the compaction note is not written when nothing is open', () => {
  const root = ready();
  writeFileSync(join(root, '.collet', 'handoff.md'), '# Handoff\n\ntask: t9\n', 'utf8');
  hook('handoff.js', root, { trigger: 'manual' });
  assert.throws(() => readFileSync(join(root, '.collet', 'handoff.md'), 'utf8'));
});

test('the guard names a remedy that works in this project', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const reason = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } })
  ).permissionDecisionReason;
  assert.match(reason, /node \.collet\/task\.mjs widen/);
});

// The harness's own files are refused whatever the task lists, so widening is the wrong advice there.
test('a refused harness write is told to close the task, and any other refused write to widen', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const reason = (file_path) =>
    hookOutput(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path } })).permissionDecisionReason;
  const harness = reason('.collet/checks/no-todo.mjs');
  assert.match(harness, /is the harness's own state/);
  assert.match(harness, /node \.collet\/task\.mjs close/);
  assert.doesNotMatch(harness, /widen --add/);
  assert.match(reason('src/theme.mjs'), /node \.collet\/task\.mjs widen --add/);
});

test('the guard takes the close advice from the harness flag, not from the wording', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  // A scope check that words both refusals its own way.
  writeFileSync(join(root, '.collet', 'checks', 'scope.mjs'), [
    "export const id = 'scope';",
    'export function check({ call }) {',
    "  const harness = String(call?.input?.file_path ?? '').startsWith('.collet/');",
    "  return { fires: true, harness, reason: harness ? 'Reworded harness refusal.' : 'Reworded scope refusal.' };",
    '}',
  ].join('\n'), 'utf8');
  const reason = (file_path) =>
    hookOutput(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path } })).permissionDecisionReason;
  const harness = reason('.collet/checks/no-todo.mjs');
  assert.match(harness, /^Reworded harness refusal\. .*node \.collet\/task\.mjs close/);
  assert.doesNotMatch(harness, /widen --add/);
  assert.match(reason('src/theme.mjs'), /^Reworded scope refusal\. .*node \.collet\/task\.mjs widen --add/);
});

test('the guard records what it refused', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } });
  const log = readFileSync(join(root, '.collet', 'guard-log.jsonl'), 'utf8');
  assert.match(log, /"task":"t1"/);
  assert.match(log, /src\/theme\.mjs/);
});

test("a missing project check falls back to the plugin's own copy rather than disarming", () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, '.collet', 'checks', 'scope.mjs'), 'this is not a module {{{', 'utf8');
  const out = hookOutput(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' } }));
  assert.equal(out.permissionDecision, 'deny');
});

// A project check other than scope. The guard ran only `scope.mjs` until 2026-09-20, so a check
// written by check-writer (then `/collet-check`) was admitted and ran at commit time while staying silent in session.
const TODO_CHECK = `export const id = 'no-todo';
export const what = 'a TODO left in a write';
export function check({ call }) {
  const text = call?.input?.content ?? '';
  return text.includes('TODO')
    ? { fires: true, reason: 'a TODO was left in the file.' }
    : { fires: false, reason: '' };
}
`;

const THROWS = `export const id = 'throws';
export const what = 'a check with a bug in it';
export function check() {
  throw new Error('boom');
}
`;

test('every check the project owns runs at write time, not just scope', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, '.collet', 'checks', 'no-todo.mjs'), TODO_CHECK, 'utf8');
  const out = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/cli.mjs', content: 'TODO: later\n' } })
  );
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /a TODO was left/);
  // Widening the task is scope's remedy. Here the mistake is inside a file the task already owns.
  assert.doesNotMatch(out.permissionDecisionReason, /widen/);
  assert.match(readFileSync(join(root, '.collet', 'guard-log.jsonl'), 'utf8'), /"check":"no-todo"/);
});

test('a check that throws does not stop the checks after it', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, '.collet', 'checks', 'a-throws.mjs'), THROWS, 'utf8');
  writeFileSync(join(root, '.collet', 'checks', 'b-todo.mjs'), TODO_CHECK, 'utf8');
  const out = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/cli.mjs', content: 'TODO: later\n' } })
  );
  assert.equal(out.permissionDecision, 'deny');
});

test('with no task open the guard allows everything, and says nothing', () => {
  const root = ready();
  const out = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'anything.txt' } });
  assert.equal(out.stdout, '');
});

// Codex sets no CLAUDE_PROJECT_DIR. The project arrives as `cwd` in the event, and the hook may
// well be run from somewhere else.
test('a host that names the project in the event needs no environment variable', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const event = { tool_name: 'Write', tool_input: { file_path: 'src/theme.mjs' }, cwd: root };
  const out = hook('guard.js', root, event, { cwd: PLUGIN, project: null });
  assert.equal(hookOutput(out).permissionDecision, 'deny');
});

// Codex on Windows hands a hook's command to PowerShell. A `commandWindows` that wrapped its script
// in double quotes had `$env:` and `$LASTEXITCODE` expanded by that outer shell, failed, and the
// host carried on with the call: a guard wired, listed and never run. Seen in a live session. The
// plain command ran there as it is, so it is the only one.
test('the Codex hooks name one command per hook, with no Windows override to break', () => {
  const { hooks } = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'codex-hooks.json'), 'utf8'));
  for (const groups of Object.values(hooks))
    for (const { hooks: handlers } of groups)
      for (const handler of handlers) {
        assert.equal(handler.commandWindows, undefined);
        assert.match(handler.command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/[a-z-]+\.js"$/);
      }
});

// A session opened in `src/` names `src/` as its directory, on every host. The harness is one
// level up, and a guard that looked only where it was told found none and stood down.
test('a session opened below the project root is still held to the task', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const below = join(root, 'src');
  const call = { tool_name: 'Write', tool_input: { file_path: join(root, 'src', 'theme.mjs') } };
  const named = hook('guard.js', root, { ...call, cwd: below }, { cwd: PLUGIN, project: null });
  assert.equal(hookOutput(named).permissionDecision, 'deny', 'the directory arrives in the event');
  const inEnv = hook('guard.js', root, call, { cwd: PLUGIN, project: below });
  assert.equal(hookOutput(inEnv).permissionDecision, 'deny', 'the directory arrives in the environment');
  // A relative path is relative to that directory: `cli.mjs` from `src/` is the task's own file.
  const relative = { tool_name: 'Write', tool_input: { file_path: 'cli.mjs' }, cwd: below };
  assert.equal(hook('guard.js', root, relative, { cwd: PLUGIN, project: null }).stdout, '');
});

// Antigravity runs the hook from the plugin directory, nests the call under toolCall with
// PascalCase arguments, and reads a bare decision back — including the allow.
test('on Antigravity the guard reads toolCall and answers with a bare decision', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const run = (toolCall) =>
    JSON.parse(
      hook('guard.js', root, { toolCall, workspacePaths: [root] }, { args: ['antigravity'], cwd: PLUGIN, project: null })
        .stdout
    );

  const write = run({ name: 'write_to_file', args: { TargetFile: 'src/theme.mjs', CodeContent: '' } });
  assert.equal(write.decision, 'deny');
  assert.match(write.reason, /src\/theme\.mjs is outside the open task/);
  assert.match(write.reason, /node \.collet\/task\.mjs widen/);

  const edit = run({ name: 'replace_file_content', args: { AbsolutePath: join(root, 'src', 'report.mjs') } });
  assert.equal(edit.decision, 'deny');

  const shell = run({ name: 'run_command', args: { CommandLine: 'echo x > src/theme.mjs', Cwd: root } });
  assert.equal(shell.decision, 'deny');

  assert.deepEqual(run({ name: 'write_to_file', args: { TargetFile: 'src/cli.mjs' } }), { decision: 'allow' });
  assert.deepEqual(run({ name: 'view_file', args: { AbsolutePath: join(root, 'src', 'theme.mjs') } }), {
    decision: 'allow',
  });
});

test('Antigravity finds the harness from absolute file targets when workspace context is absent', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  for (const name of ['write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    for (const key of ['TargetFile', 'AbsolutePath']) {
      const run = (file) => hook('guard.js', root, {
        toolCall: { name, args: { [key]: join(root, 'src', file) } },
        workspacePaths: [],
      }, { args: ['antigravity'], cwd: PLUGIN, project: null });
      const denied = run('theme.mjs');
      assert.equal(denied.status, 0, `${name} ${key}`);
      const answer = JSON.parse(denied.stdout);
      assert.equal(answer.decision, 'deny', `${name} ${key}`);
      assert.match(answer.reason, /src\/theme\.mjs is outside the open task/);
      assert.deepEqual(JSON.parse(run('cli.mjs').stdout), { decision: 'allow' }, `${name} ${key}`);
    }
  }
});

test('Antigravity finds the harness from an absolute command Cwd when workspace context is absent', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const run = (file) => hook('guard.js', root, {
    toolCall: { name: 'run_command', args: { CommandLine: `echo x > ${file}`, Cwd: join(root, 'src') } },
    workspacePaths: [],
  }, { args: ['antigravity'], cwd: PLUGIN, project: null });
  const denied = JSON.parse(run('theme.mjs').stdout);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /src\/theme\.mjs is outside the open task/);
  assert.deepEqual(JSON.parse(run('cli.mjs').stdout), { decision: 'allow' });
});

test('explicit project context keeps precedence over Antigravity target inference', () => {
  const root = ready();
  const other = project(TREE);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const toolCall = { name: 'write_to_file', args: { TargetFile: join(root, 'src', 'theme.mjs') } };
  const cases = [
    [{ toolCall, cwd: root, workspacePaths: [root] }, other],
    [{ toolCall, cwd: other, workspacePaths: [root] }, null],
    [{ toolCall, workspacePaths: [other] }, null],
  ];
  for (const [event, projectRoot] of cases) {
    const result = hook('guard.js', root, event, { args: ['antigravity'], cwd: PLUGIN, project: projectRoot });
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  }
});

test('Antigravity does not invent project context from relative tool arguments', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const calls = [
    { name: 'write_to_file', args: { TargetFile: 'src/theme.mjs' } },
    { name: 'write_to_file', args: { AbsolutePath: 'src/theme.mjs' } },
    { name: 'run_command', args: { CommandLine: 'echo x > theme.mjs', Cwd: 'src' } },
    { name: 'write_to_file', args: {} },
  ];
  for (const toolCall of calls) {
    const result = hook('guard.js', root, { toolCall, workspacePaths: [] }, {
      args: ['antigravity'], cwd: PLUGIN, project: null,
    });
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  }
});

test('on Antigravity a project without collet is allowed out loud, not in silence', () => {
  const root = project(TREE);
  const out = hook(
    'guard.js',
    root,
    { toolCall: { name: 'write_to_file', args: { TargetFile: 'anything.txt' } }, workspacePaths: [root] },
    { args: ['antigravity'], cwd: PLUGIN, project: null }
  );
  assert.deepEqual(JSON.parse(out.stdout), { decision: 'allow' });
});
