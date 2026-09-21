// The scope check, called directly. Every case here is a way the guard was wrong in both
// directions: refusing work it had no business refusing, and waving through the one command that
// can remove a whole directory.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { check, matchScope, targetsOf } from '../templates/checks/scope.mjs';
import { clean, project, TREE } from './temp-project.js';

const TASK = {
  id: 't1',
  title: 'window the digest',
  status: 'in_progress',
  scope: ['src/cli.mjs', 'src/digest.mjs', 'test/**'],
  accept: 'node -e 0',
};

function fires(root, call, task = TASK) {
  return check({ root, task, call }).fires;
}

const withTree = (extra = {}) => project({ ...TREE, 'notes.txt': 'notes\n', 'tools/build.sh': 'echo\n', ...extra });

test('a write tool outside the declared files is refused', () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Write', input: { file_path: 'src/theme.mjs' } }), true);
  assert.equal(fires(root, { tool: 'Write', input: { file_path: 'src/digest.mjs' } }), false);
  clean(root);
});

test('a read is never a write, whatever command it arrives in', () => {
  const root = withTree();
  // sed is the trap: the same command name reads and edits in place, and the file it reads is
  // its last argument either way.
  assert.equal(fires(root, { tool: 'Bash', input: { command: "sed -n '1,5p' src/theme.mjs" } }), false);
  assert.equal(fires(root, { tool: 'Bash', input: { command: "sed -i 's/a/b/' src/theme.mjs" } }), true);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'cat src/theme.mjs' } }), false);
  assert.equal(fires(root, { tool: 'Read', input: { file_path: 'src/theme.mjs' } }), false);
  clean(root);
});

test('a whole directory removed from outside the task is refused', () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm -rf tools' } }), true);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm tools/build.sh' } }), true);
  clean(root);
});

test('a cmdlet path behind a value-taking flag is still found', () => {
  const root = withTree();
  const cases = [
    'New-Item -ItemType File notes.txt',
    'Set-Content -Encoding utf8 -Path notes.txt -Value x',
    'Set-Content notes.txt "x"',
    'Remove-Item -Force -Path notes.txt',
  ];
  for (const command of cases) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), true, command);
  }
  clean(root);
});

test('a path on another drive is outside the repository, not a path inside it', () => {
  const root = withTree();
  // relative() between two roots returns the target's own absolute path, which starts with a
  // letter rather than "..". Read as repo-relative it matches no scope and fires on a scratch file.
  for (const target of ['X:/Temp/scratch/out.txt', 'C:/Temp/out.txt', '../outside.txt']) {
    assert.equal(fires(root, { tool: 'Write', input: { file_path: target } }), false, target);
  }
  clean(root);
});

test('a root spelled with forward slashes is the same drive as one resolved natively', () => {
  const root = withTree();
  const forward = root.split('\\').join('/');
  assert.equal(fires(forward, { tool: 'Write', input: { file_path: 'src/theme.mjs' } }), true);
  clean(root);
});

test('creating a path that does not exist yet is scratch output, not a change', () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'node src/cli.mjs > build/out.txt' } }), false);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'node src/cli.mjs > notes.txt' } }), true);
  clean(root);
});

test('a patch is read for every file it names', () => {
  const root = withTree();
  const patch = '*** Begin Patch\n*** Update File: src/theme.mjs\n@@\n-a\n+b\n*** End Patch';
  assert.equal(fires(root, { tool: 'apply_patch', input: { patch } }), true);
  const inside = '*** Begin Patch\n*** Update File: src/digest.mjs\n@@\n-a\n+b\n*** End Patch';
  assert.equal(fires(root, { tool: 'apply_patch', input: { patch: inside } }), false);
  clean(root);
});

test('a patch is found under the key the host sends it in, command included', () => {
  const root = withTree();
  const outside = '*** Begin Patch\n*** Update File: src/theme.mjs\n@@\n-a\n+b\n*** End Patch';
  const inside = '*** Begin Patch\n*** Update File: src/digest.mjs\n@@\n-a\n+b\n*** End Patch';
  for (const key of ['patch', 'input', 'command', 'content']) {
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: outside } }), true, key);
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: inside } }), false, key);
  }
  clean(root);
});

// A session opened in `src/` writes `../notes.txt` and `digest.mjs`. Read against the root, the
// first is outside the repository and waved through, and the second is a file that does not exist.
test('a relative path is read from the directory the call ran in', () => {
  const root = withTree();
  const cwd = join(root, 'src');
  const patch = (file) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`;
  assert.equal(fires(root, { tool: 'apply_patch', input: { command: patch('../notes.txt') }, cwd }), true);
  assert.equal(fires(root, { tool: 'apply_patch', input: { command: patch('digest.mjs') }, cwd }), false);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm ../notes.txt' }, cwd }), true);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm digest.mjs' }, cwd }), false);
  clean(root);
});

test('the roadmap another tool owns is never refused here', () => {
  const root = withTree({ 'ROADMAP.jsonl': '{"id":"001"}\n' });
  assert.equal(fires(root, { tool: 'Write', input: { file_path: 'ROADMAP.jsonl' } }), false);
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.foreman/config.json' } }), false);
  clean(root);
});

test("collet's own state is not a task file, but the unverified list is", () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.collet/ledger.jsonl' } }), true);
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.collet/unverified.md' } }), false);
  clean(root);
});

test('with no task open nothing is enforced', () => {
  const root = withTree();
  assert.equal(check({ root, task: null, call: { tool: 'Write', input: { file_path: 'any.txt' } } }).fires, false);
  clean(root);
});

test('a declared folder owns what sits beneath it', () => {
  assert.equal(matchScope('src/auth/', 'src/auth/token.ts'), true);
  assert.equal(matchScope('src/auth', 'src/auth/token.ts'), true);
  assert.equal(matchScope('src/auth', 'src/authority.ts'), false);
  assert.equal(matchScope('src/**', 'src/deep/nested/file.ts'), true);
  assert.equal(matchScope('src/*.mjs', 'src/cli.mjs'), true);
  assert.equal(matchScope('src/*.mjs', 'src/deep/cli.mjs'), false);
  assert.equal(matchScope('src/cli.mjs', 'src/cli.mjs'), true);
});

test('targetsOf says a non-write is a non-write rather than an empty list', () => {
  const root = withTree();
  assert.equal(targetsOf({ tool: 'Read', input: { file_path: 'src/cli.mjs' } }, root), null);
  assert.deepEqual(targetsOf({ tool: 'Write', input: { file_path: 'x.txt' } }, root), ['x.txt']);
  assert.deepEqual(targetsOf({ tool: 'Bash', input: { command: 'rm -rf tools' } }, root), ['tools']);
  clean(root);
});

test('a target the check cannot read does not throw', () => {
  const root = project({});
  for (const call of [{}, { tool: 'Write' }, { tool: 'Bash', input: {} }, { tool: 'Write', input: { file_path: null } }]) {
    assert.doesNotThrow(() => check({ root, task: TASK, call }));
  }
  assert.doesNotThrow(() => check({ root: join(root, 'missing'), task: TASK, call: { tool: 'Bash', input: { command: 'rm x' } } }));
  clean(root);
});
