// The scope check, called directly. Every case here is a way the guard was wrong in both
// directions: refusing work it had no business refusing, and waving through the one command that
// can remove a whole directory.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { check, live, matchScope, targetsOf } from '../templates/checks/scope.mjs';
import { git, mount, project, repo, TREE } from './temp-project.js';

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
});

test('a read is never a write, whatever command it arrives in', () => {
  const root = withTree();
  // sed is the trap: the same command name reads and edits in place, and the file it reads is
  // its last argument either way.
  assert.equal(fires(root, { tool: 'Bash', input: { command: "sed -n '1,5p' src/theme.mjs" } }), false);
  assert.equal(fires(root, { tool: 'Bash', input: { command: "sed -i 's/a/b/' src/theme.mjs" } }), true);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'cat src/theme.mjs' } }), false);
  assert.equal(fires(root, { tool: 'Read', input: { file_path: 'src/theme.mjs' } }), false);
});

test('a whole directory removed from outside the task is refused', () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm -rf tools' } }), true);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm tools/build.sh' } }), true);
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
});

test('PowerShell reads and copy sources are not write targets', () => {
  const root = withTree({ 'outside notes.txt': 'outside\n', 'test/inside notes.txt': 'inside\n' });
  const commands = [
    'Get-Content -LiteralPath notes.txt',
    'Get-Item -Path notes.txt',
    'Test-Path -Path notes.txt',
    'Copy-Item -LiteralPath notes.txt -Destination src/cli.mjs',
    'Copy-Item -Destination src/cli.mjs -Path notes.txt',
    'Copy-Item notes.txt src/cli.mjs',
    'Copy-Item -Path notes.txt src/cli.mjs',
    'Copy-Item notes.txt -Destination src/cli.mjs',
    'Copy-Item -LiteralPath "outside notes.txt" -Destination "test/inside notes.txt"',
    'Get-Content -LiteralPath notes.txt | Set-Content -Path src/cli.mjs',
    'Write-Output "Remove-Item notes.txt"',
  ];
  for (const command of commands) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), false, command);
  }
});

test('PowerShell aliases keep their command-specific named paths', () => {
  const root = withTree();
  for (const command of [
    'rm -LiteralPath notes.txt',
    'mv -Path notes.txt -Destination src/cli.mjs',
    'mv -Path src/cli.mjs -Destination notes.txt',
    'cp -Path src/cli.mjs -Destination notes.txt',
    'tee -FilePath notes.txt',
    'Tee-Object -FilePath notes.txt',
    'Tee-Object -InputObject x notes.txt',
  ]) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), true, command);
  }
  for (const command of [
    'rm -LiteralPath src/cli.mjs',
    'mv -Path src/cli.mjs -Destination src/digest.mjs',
    'cp -LiteralPath notes.txt -Destination src/cli.mjs',
    'tee -FilePath src/cli.mjs',
    'Tee-Object -FilePath src/cli.mjs',
    'Tee-Object -Variable notes.txt',
  ]) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), false, command);
  }
});

test('quoted literal command names keep their write policy', () => {
  const root = withTree();
  const cases = [
    ['PowerShell', "& 'Set-Content' -LiteralPath notes.txt -Value x", true],
    ['PowerShell', "& 'Remove-Item' -LiteralPath notes.txt", true],
    ['Bash', "'rm' notes.txt", true],
    ['PowerShell', "& 'Get-Content' -LiteralPath notes.txt", false],
    ['PowerShell', "& 'Copy-Item' -Path notes.txt -Destination src/cli.mjs", false],
    ['PowerShell', "& 'Set-Content' -LiteralPath src/cli.mjs -Value x", false],
    ['Bash', "'rm' src/cli.mjs", false],
  ];
  for (const [tool, command, expected] of cases) {
    assert.equal(fires(root, { tool, input: { command } }), expected, command);
  }
});

test('named and positional shell writes preserve quoted paths', () => {
  const root = withTree({ 'outside notes.txt': 'outside\n', 'test/inside notes.txt': 'inside\n' });
  const commands = [
    'Set-Content -Encoding utf8 -LiteralPath "outside notes.txt" -Value x',
    "Set-Content 'outside notes.txt' x",
    'set-content -path "outside notes.txt" -value x',
    'Out-File -FilePath "outside notes.txt" -Encoding utf8',
    'Copy-Item -Path src/cli.mjs -Destination "outside notes.txt"',
    "cp src/cli.mjs 'outside notes.txt'",
    'echo x > "outside notes.txt"',
    'Get-Content -LiteralPath src/cli.mjs | Set-Content -Path "outside notes.txt"',
  ];
  for (const command of commands) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), true, command);
  }
  assert.equal(fires(root, { tool: 'PowerShell', input: {
    command: 'Set-Content -Path "test/inside notes.txt" -Value "Remove-Item notes.txt"',
  } }), false);
  assert.equal(fires(root, { tool: 'PowerShell', input: {
    command: 'Set-Content -Path "new scratch.txt" -Value x',
  } }), false);
});

test('every removal operand is checked, including named path lists', () => {
  const root = withTree({ 'outside notes.txt': 'outside\n', 'test/inside notes.txt': 'inside\n' });
  const commands = [
    'rm -f notes.txt src/cli.mjs',
    'rm -rf tools test',
    'rm -- "outside notes.txt" "test/inside notes.txt"',
    'Remove-Item -LiteralPath notes.txt,src/cli.mjs -Force',
    'Remove-Item -Path "outside notes.txt", "test/inside notes.txt" -Force',
    'Remove-Item "outside notes.txt", "test/inside notes.txt" -Force',
  ];
  for (const command of commands) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), true, command);
  }
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'rm src/cli.mjs src/digest.mjs' } }), false);
});

test('moving checks the removed sources as well as the destination', () => {
  const root = withTree({ 'outside notes.txt': 'outside\n', 'test/inside notes.txt': 'inside\n' });
  const commands = [
    'mv notes.txt src/cli.mjs',
    'mv notes.txt src/cli.mjs test',
    'mv src/cli.mjs notes.txt',
    'mv "outside notes.txt" "test/inside notes.txt"',
    'Move-Item notes.txt src/cli.mjs',
    'Move-Item -LiteralPath notes.txt -Destination src/cli.mjs',
    'Move-Item -Destination src/cli.mjs -Path notes.txt',
    'Move-Item notes.txt -Destination src/cli.mjs',
    'Move-Item -Path notes.txt src/cli.mjs',
    'Move-Item -Path "outside notes.txt", src/cli.mjs -Destination test',
    'Move-Item -Path src/cli.mjs -Destination "outside notes.txt"',
  ];
  for (const command of commands) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), true, command);
  }
  for (const command of ['mv src/cli.mjs src/digest.mjs', 'Move-Item -Path src/cli.mjs -Destination src/digest.mjs']) {
    assert.equal(fires(root, { tool: 'PowerShell', input: { command } }), false, command);
  }
});

test('a patch move checks both the source and its actual destination header', () => {
  const root = withTree();
  const patch = (from, to) => `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-a\n+b\n*** End Patch`;
  for (const key of ['patch', 'input', 'command', 'content']) {
    const moved = patch('src/cli.mjs', 'new outside.mjs');
    const call = { tool: 'apply_patch', input: { [key]: moved } };
    assert.deepEqual(targetsOf(call, root), ['src/cli.mjs', 'new outside.mjs']);
    assert.equal(fires(root, call), true, key);
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: patch('notes.txt', 'src/cli.mjs') } }), true, key);
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: patch('src/cli.mjs', 'test/new.mjs') } }), false, key);
  }
});

test('a path on another drive is outside the repository, not a path inside it', () => {
  const root = withTree();
  // relative() between two roots returns the target's own absolute path, which starts with a
  // letter rather than "..". Read as repo-relative it matches no scope and fires on a scratch file.
  for (const target of ['X:/Temp/scratch/out.txt', 'C:/Temp/out.txt', '../outside.txt']) {
    assert.equal(fires(root, { tool: 'Write', input: { file_path: target } }), false, target);
  }
});

test('a root spelled with forward slashes is the same drive as one resolved natively', () => {
  const root = withTree();
  const forward = root.split('\\').join('/');
  assert.equal(fires(forward, { tool: 'Write', input: { file_path: 'src/theme.mjs' } }), true);
});

test('creating a path that does not exist yet is scratch output, not a change', () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'node src/cli.mjs > build/out.txt' } }), false);
  assert.equal(fires(root, { tool: 'Bash', input: { command: 'node src/cli.mjs > notes.txt' } }), true);
});

test('a patch is read for every file it names', () => {
  const root = withTree();
  const patch = '*** Begin Patch\n*** Update File: src/theme.mjs\n@@\n-a\n+b\n*** End Patch';
  assert.equal(fires(root, { tool: 'apply_patch', input: { patch } }), true);
  const inside = '*** Begin Patch\n*** Update File: src/digest.mjs\n@@\n-a\n+b\n*** End Patch';
  assert.equal(fires(root, { tool: 'apply_patch', input: { patch: inside } }), false);
});

test('a patch is found under the key the host sends it in, command included', () => {
  const root = withTree();
  const outside = '*** Begin Patch\n*** Update File: src/theme.mjs\n@@\n-a\n+b\n*** End Patch';
  const inside = '*** Begin Patch\n*** Update File: src/digest.mjs\n@@\n-a\n+b\n*** End Patch';
  for (const key of ['patch', 'input', 'command', 'content']) {
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: outside } }), true, key);
    assert.equal(fires(root, { tool: 'apply_patch', input: { [key]: inside } }), false, key);
  }
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
});

test('the roadmap another tool owns is never refused here', () => {
  const root = withTree({ 'ROADMAP.jsonl': '{"id":"001"}\n' });
  assert.equal(fires(root, { tool: 'Write', input: { file_path: 'ROADMAP.jsonl' } }), false);
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.foreman/config.json' } }), false);
});

test("collet's own state is not a task file, but the unverified list is", () => {
  const root = withTree();
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.collet/ledger.jsonl' } }), true);
  assert.equal(fires(root, { tool: 'Write', input: { file_path: '.collet/unverified.md' } }), false);
});

// Nothing a shell creates under .collet/ is scratch: the close-time check skips that directory, a
// check written there runs unreviewed when the task closes, and a new .collet/off silences every hook.
const HARNESS_SHELL_WRITES = [
  ['Bash', 'printf x > .collet/checks/new.mjs'],
  ['Bash', 'cp src/cli.mjs .collet/checks/new.mjs'],
  ['PowerShell', 'Copy-Item src/cli.mjs -Destination .collet/checks/new.mjs'],
  ['Bash', 'printf x > .collet/off'],
];
const NEW_PATHS_ALLOWED = [
  ['Bash', 'printf x > .collet/unverified.md'],
  ['Bash', 'printf x > build/new.txt'],
];

test('a shell write under .collet/ is refused even when it creates the path, except the unverified list', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const [tool, command] of HARNESS_SHELL_WRITES) {
    const result = check({ root, task: TASK, call: { tool, input: { command } } });
    assert.deepEqual([result.fires, result.harness], [true, true], command);
  }
  for (const [tool, command] of NEW_PATHS_ALLOWED) {
    assert.equal(fires(root, { tool, input: { command } }), false, command);
  }
});

test('with no task open a shell write under .collet/ is not refused', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const [tool, command] of [...HARNESS_SHELL_WRITES, ...NEW_PATHS_ALLOWED]) {
    assert.equal(fires(root, { tool, input: { command } }, null), false, command);
  }
});

// Three more ways in: a command that creates without a redirect, the directory spelled in another
// case, which a case-insensitive filesystem resolves to the same place, and the directory itself.
// Under a scope of ** the harness rule is all that stands between these and the kill switch.
const asCall = ([tool, arg]) => ({ tool, input: tool === 'Write' ? { file_path: arg } : { command: arg } });
const HARNESS_ROUTES = [
  ['Bash', 'touch .collet/off'],
  ['PowerShell', 'ni .collet/off'],
  ['PowerShell', 'ni -Path .collet -Name off'],
  ['Bash', 'mkdir -p .collet/checks/x'],
  ['PowerShell', 'mkdir -Path .collet/checks/x'],
  ['Bash', 'printf x > .Collet/off'],
  ['PowerShell', 'Copy-Item src/cli.mjs -Destination .COLLET/checks/new.mjs'],
  ['Write', '.Collet/off'],
  ['Bash', 'rm -rf .collet'],
  ['Bash', 'rm -rf ./.collet/'],
  ['Bash', 'mv .collet x'],
  ['PowerShell', 'Remove-Item -Recurse .Collet'],
];

test('touch, ni, mkdir, another letter case and the .collet directory itself are refused as the harness', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const task of [TASK, { ...TASK, scope: ['**'] }]) {
    for (const route of HARNESS_ROUTES) {
      const result = check({ root, task, call: asCall(route) });
      assert.deepEqual([result.fires, result.harness], [true, true], `${route[1]} with ${task.scope}`);
    }
  }
});

test('with no task open those routes are not refused', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const route of HARNESS_ROUTES) {
    assert.equal(fires(root, asCall(route), null), false, route[1]);
  }
});

test('touch and mkdir name targets only under .collet/, and a lookalike name is not the harness', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  assert.deepEqual(targetsOf(asCall(['Bash', 'touch notes.txt src/theme.mjs .collet/off']), root), ['.collet/off']);
  for (const route of [
    ['Bash', 'touch notes.txt'],
    ['Bash', 'mkdir tools'],
    ['Bash', 'mkdir -p build/x'],
    ['Bash', 'touch .collet/unverified.md'],
    ['PowerShell', 'ni .collet/unverified.md'],
    ['Bash', 'printf x > .collet-notes/a.txt'],
  ]) {
    assert.equal(fires(root, asCall(route)), false, route[1]);
  }
  const lookalike = check({ root, task: TASK, call: asCall(['Write', '.colletrc']) });
  assert.deepEqual([lookalike.fires, lookalike.harness], [true, undefined]);
  assert.equal(fires(root, asCall(['Write', '.colletrc']), { ...TASK, scope: ['**'] }), false);
});

// PowerShell's aliases, Rename-Item and New-Item -Name reach the same directory.
const ALIAS_ROUTES = [
  'Rename-Item .collet x', 'ren .collet x', 'rni .collet x',
  'Rename-Item -Path .collet/checks/scope.mjs -NewName x.mjs', 'Rename-Item notes.txt .collet',
  'move .collet x', 'mi .collet x', 'del .collet/config.json', 'erase .collet/config.json',
  'ri -Recurse .collet', 'rd -Recurse .collet', 'rmdir .collet/checks', 'copy src/cli.mjs .collet/off',
  'cpi src/cli.mjs .collet/off', 'ac .collet/off x', 'clc .collet/config.json', 'md .collet/checks/x',
  'New-Item -Name .collet/off -ItemType File', 'ni -Name .collet/off', 'New-Item -Path . -Name .collet/off',
];

test('PowerShell aliases, Rename-Item and New-Item -Name are refused under .collet/', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '', '.collet/config.json': '{}' });
  for (const task of [TASK, { ...TASK, scope: ['**'] }]) {
    for (const command of ALIAS_ROUTES) {
      const result = check({ root, task, call: asCall(['PowerShell', command]) });
      assert.deepEqual([result.fires, result.harness], [true, true], `${command} with ${task.scope}`);
    }
  }
  for (const command of ALIAS_ROUTES) {
    assert.equal(fires(root, asCall(['PowerShell', command]), null), false, command);
  }
});

test('Rename-Item, md and New-Item -Name keep their decisions outside .collet/', () => {
  const root = withTree();
  for (const command of [
    'ren notes.txt notes.md', 'Rename-Item src/cli.mjs cli2.mjs', 'md build/x', 'New-Item -Name build.txt',
    'del .collet/unverified.md',
  ]) {
    assert.equal(fires(root, asCall(['PowerShell', command])), false, command);
  }
  // New-Item was read before: its -Path is still the target, and still outside the task.
  assert.deepEqual(targetsOf(asCall(['PowerShell', 'New-Item -Path tools -Name new.sh']), root), ['tools']);
  assert.equal(fires(root, asCall(['PowerShell', 'New-Item -Path tools -Name new.sh'])), true);
});

// The repository itself reads as outside the repository, yet removing or moving it, or a directory
// that holds it, takes every file with it, the harness included.
test('removing or moving the repository root, or a directory holding it, is refused', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  const absolute = root.split('\\').join('/');
  const name = basename(root);
  const routes = [
    ['Bash', `rm -rf ../${name}`], ['Bash', `rm -rf ${absolute}`], ['PowerShell', `Remove-Item -Recurse ${absolute}`],
    ['PowerShell', 'Remove-Item -Recurse -Force .'], ['Bash', 'rm -rf ..'], ['Bash', 'rm -rf src/..'],
    ['PowerShell', `del -Recurse ../${name}`], ['Bash', `mv ../${name} ../moved-away`],
    ['PowerShell', `Move-Item -Path ${absolute} -Destination ../moved-away`], ['Bash', 'mv . ../moved-away'],
  ];
  for (const task of [TASK, { ...TASK, scope: ['**'] }]) {
    for (const route of routes) {
      const result = check({ root, task, call: asCall(route) });
      assert.deepEqual([result.fires, result.harness], [true, true], `${route[1]} with ${task.scope}`);
    }
  }
  for (const route of routes) assert.equal(fires(root, asCall(route), null), false, route[1]);
});

test('a sibling of the root, or a move or copy into it, keeps its decision', () => {
  const root = withTree();
  const name = basename(root);
  for (const route of [
    ['Bash', `rm -rf ../${name}-sibling`], ['Bash', `rm -rf ${root.split('\\').join('/')}-sibling`],
    ['Bash', 'mv ../outside.txt .'], ['PowerShell', 'Move-Item -Path ../outside.txt -Destination .'],
    ['Bash', 'cp ../outside.txt .'],
  ]) {
    assert.equal(fires(root, asCall(route)), false, route[1]);
  }
  assert.deepEqual(targetsOf(asCall(['Bash', 'rm -rf tools']), root), ['tools']);
});

// A removal may name the working directory or the home directory through a shell token: $PWD and
// ${PWD}, cmd's %CD% and a leading ~. Each reads as the path it names, following the shell's
// quoting. cmd syntax arrives as a Bash call, the tool name collet gives Antigravity's commands.
const TOKEN_ROUTES = [
  [['Bash', 'rm -rf "$PWD"'], 'harness'], [['Bash', 'rm -rf ${PWD}'], 'harness'],
  [['Bash', 'rm $PWD/src/cli.mjs'], 'allowed'], [['Bash', 'rm -rf ~'], 'scope'], [['Bash', "rm -rf '$PWD'"], 'allowed'],
  [['PowerShell', 'Remove-Item -Recurse $pwd'], 'harness'], [['PowerShell', 'Remove-Item $PWD\\src\\cli.mjs'], 'allowed'],
  [['PowerShell', 'Remove-Item -Recurse ~'], 'scope'], [['PowerShell', "Remove-Item -Recurse '$PWD'"], 'allowed'],
  [['Bash', 'rd /s /q %CD%'], 'harness'], [['Bash', 'del %cd%\\src\\cli.mjs'], 'allowed'], [['Bash', "rd /s /q '%CD%'"], 'allowed'],
];

test('the working-directory and home tokens in a removal read as the paths they name, per shell', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = join(root, 'tools');
  try {
    const decide = ([tool, command], cwd = root) => {
      const result = check({ root, task: TASK, call: { tool, input: { command }, cwd } });
      return result.fires ? (result.harness ? 'harness' : 'scope') : 'allowed';
    };
    for (const [call, expected] of TOKEN_ROUTES) assert.equal(decide(call), expected, call[1]);
    // Any other variable, a substitution, a quoted ~ and a POSIX $pwd stay unread, as before.
    for (const command of ['rm -rf $HOME', 'rm -rf $(pwd)', 'rm -rf $PWDX', 'rm -rf "~"', 'rm -rf $pwd', 'rm -rf ~other']) {
      assert.equal(decide(['Bash', command]), 'allowed', command);
    }
    // Without a working directory from the host, $PWD keeps today's decision.
    assert.equal(decide(['Bash', 'rm -rf "$PWD"'], null), 'allowed');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// The four tokens name their paths wherever the parser reads a path: a redirect, a write, a copy or a
// move, not only a removal. The quoting rules and the unknown working directory hold as before.
const TOKEN_PATHS = [
  [['Bash', 'echo x > $PWD/.collet/off'], 'harness'], [['Bash', 'touch $PWD/.collet/off'], 'harness'],
  [['PowerShell', 'Set-Content $PWD\\.collet\\off x'], 'harness'], [['Bash', 'mv $PWD ../elsewhere'], 'harness'],
  [['PowerShell', 'Move-Item $PWD ../elsewhere'], 'harness'], [['Bash', 'cp src/cli.mjs %CD%/.collet/off'], 'harness'],
  [['Bash', 'echo x > $PWD/src/cli.mjs'], 'allowed'], [['Bash', 'touch $PWD/src/cli.mjs'], 'allowed'],
  [['PowerShell', 'Set-Content $PWD\\src\\cli.mjs x'], 'allowed'], [['Bash', 'mv $PWD/src/cli.mjs ${PWD}/src/digest.mjs'], 'allowed'],
  [['Bash', 'cp notes.txt $PWD/src/cli.mjs'], 'allowed'], [['Bash', 'cp src/cli.mjs $PWD/notes.txt'], 'scope'],
  [['Bash', "echo x > '$PWD/.collet/off'"], 'allowed'], [['PowerShell', "Set-Content '$PWD\\.collet\\off' x"], 'allowed'],
];

test('the working-directory and home tokens name their paths in every write, copy and move', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  const decide = ([tool, command], cwd = root) => {
    const result = check({ root, task: TASK, call: { tool, input: { command }, cwd } });
    return result.fires ? (result.harness ? 'harness' : 'scope') : 'allowed';
  };
  for (const [call, expected] of TOKEN_PATHS) assert.equal(decide(call), expected, call[1]);
  // Without a working directory from the host, $PWD keeps today's decision.
  assert.equal(decide(['Bash', 'echo x > $PWD/.collet/off'], null), 'allowed');
});

// Under PowerShell a cmdlet's FileSystem provider reads a leading ~ in a quoted path too, so the
// check does; a POSIX shell reads it only unquoted, as before.
test('a quoted leading ~ is the home directory under PowerShell and a literal name in a POSIX shell', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const decide = ([tool, command]) => {
    const result = check({ root, task: TASK, call: { tool, input: { command }, cwd: root } });
    return result.fires ? (result.harness ? 'harness' : 'scope') : 'allowed';
  };
  try {
    // A home inside the project but outside the scope, then the directory that holds the project.
    for (const [home, expected] of [[join(root, 'tools'), 'scope'], [dirname(root), 'harness']]) {
      process.env.HOME = process.env.USERPROFILE = home;
      for (const command of ["Remove-Item -Recurse '~'", 'Remove-Item -Recurse "~"', "del -Recurse '~\\'"]) {
        assert.equal(decide(['PowerShell', command]), expected, `${command} with home ${expected}`);
      }
      for (const command of ["rm -rf '~'", 'rm -rf "~"']) assert.equal(decide(['Bash', command]), 'allowed', command);
    }
    assert.equal(decide(['PowerShell', "Remove-Item -Recurse '~other'"]), 'allowed');
    assert.equal(decide(['PowerShell', "Remove-Item -Recurse '$PWD'"]), 'allowed');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// PowerShell binds an abbreviated flag to the one parameter of that cmdlet it begins (Get-Command,
// PowerShell 7), so the abbreviation gets the full flag's decision, inside the scope, outside it and
// under .collet/. A prefix that begins several parameters is refused by PowerShell and stays unread.
const ABBREVIATED = [
  ['New-Item -Path . -Na .collet/off', 'New-Item -Path . -Name .collet/off', 'harness'],
  ['New-Item -Path test -N new.mjs', 'New-Item -Path test -Name new.mjs', 'allowed'],
  ['Copy-Item -De src/cli.mjs notes.txt', 'Copy-Item -Destination src/cli.mjs notes.txt', 'allowed'],
  ['Copy-Item -Dest notes.txt src/cli.mjs', 'Copy-Item -Destination notes.txt src/cli.mjs', 'scope'],
  ['Move-Item src/cli.mjs -D .collet/off', 'Move-Item src/cli.mjs -Destination .collet/off', 'harness'],
  ['Rename-Item -Li .collet -NewN x', 'Rename-Item -LiteralPath .collet -NewName x', 'harness'],
  ['Rename-Item -Li src/cli.mjs -NewN cli2.mjs', 'Rename-Item -LiteralPath src/cli.mjs -NewName cli2.mjs', 'allowed'],
  ['Remove-Item -Li notes.txt', 'Remove-Item -LiteralPath notes.txt', 'scope'],
  ['Remove-Item -LP src/cli.mjs', 'Remove-Item -LiteralPath src/cli.mjs', 'allowed'],
  ['Set-Content -Li .collet/off -V x', 'Set-Content -LiteralPath .collet/off -Value x', 'harness'],
  ['Out-File -Pa notes.txt', 'Out-File -FilePath notes.txt', 'scope'],
  ['Out-File -Pat src/cli.mjs', 'Out-File -FilePath src/cli.mjs', 'allowed'],
  ['Remove-Item -Pa .collet/config.json', 'Remove-Item -Path .collet/config.json', 'harness'],
  ['Tee-Object -LP .collet/off', 'Tee-Object -LiteralPath .collet/off', 'harness'],
];

/** What the check decides for one PowerShell call: allowed, or refused for the scope or the harness. */
function decision(root, command) {
  const result = check({ root, task: TASK, call: asCall(['PowerShell', command]) });
  return result.fires ? (result.harness ? 'harness' : 'scope') : 'allowed';
}

test('an abbreviated PowerShell flag gets the decision of the flag it abbreviates', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const [short, full, expected] of ABBREVIATED) {
    assert.equal(decision(root, full), expected, full);
    assert.equal(decision(root, short), expected, short);
  }
  assert.deepEqual(targetsOf(asCall(['PowerShell', 'Copy-Item -De src/cli.mjs notes.txt']), root), ['src/cli.mjs']);
  // -T begins both -ItemType (alias Type) and -Value (alias Target): PowerShell refuses the call, and
  // the parser keeps today's reading. -Ty begins only -ItemType.
  assert.equal(decision(root, 'New-Item -T File .collet/off'), 'allowed');
  assert.equal(decision(root, 'New-Item -Ty File .collet/off'), 'harness');
  // Under PowerShell rm is Remove-Item, so -i is -Include and the call names no path; in a POSIX shell
  // -i asks before removing notes.txt.
  assert.equal(decision(root, 'rm -i notes.txt'), 'allowed');
  assert.equal(check({ root, task: TASK, call: { ...asCall(['Bash', 'rm -i notes.txt']), shell: 'posix' } }).fires, true);
});

// rm, cp, mv, tee and rmdir are PowerShell's cmdlets under PowerShell and POSIX commands in a POSIX
// shell. Where the host does not say which shell ran them, the POSIX reading stands, and the
// PowerShell reading adds what it would write under .collet/.
const SHARED_NAMES = [
  ['cp -Dest .collet/off notes.txt', { powershell: 'harness', posix: 'scope', unknown: 'scope' }],
  ['cp -Dest .collet/off src/cli.mjs', { powershell: 'harness', posix: 'allowed', unknown: 'harness' }],
  ['cp src/cli.mjs notes.txt', { powershell: 'scope', posix: 'scope', unknown: 'scope' }],
  ['cp notes.txt src/cli.mjs', { powershell: 'allowed', posix: 'allowed', unknown: 'allowed' }],
  ['rm -i notes.txt', { powershell: 'allowed', posix: 'scope', unknown: 'scope' }],
  ['mv -Dest .collet/x src/cli.mjs', { powershell: 'harness', posix: 'harness', unknown: 'harness' }],
  ['tee -Fi .collet/off', { powershell: 'harness', posix: 'harness', unknown: 'harness' }],
  ['rmdir -LP .collet', { powershell: 'harness', posix: 'harness', unknown: 'harness' }],
];

test('a shared name reads as the command of the shell that ran it, and both ways when that is unknown', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const [command, expected] of SHARED_NAMES) {
    for (const [shell, decided] of Object.entries(expected)) {
      const call = { tool: 'Bash', input: { command }, cwd: root, shell: shell === 'unknown' ? undefined : shell };
      const result = check({ root, task: TASK, call });
      assert.equal(result.fires ? (result.harness ? 'harness' : 'scope') : 'allowed', decided, `${command} (${shell})`);
    }
  }
});

// A parameter that takes a value, the cmdlet's own or a common one, consumes it: the value is never
// read as the path. Each call writes to its last operand; switches such as -Force consume nothing.
const VALUE_TAKERS = [
  'Out-File -Width 200', 'Out-File -ErrorAction Stop', 'Out-File -EA Stop', 'Out-File -ErrorA Stop',
  'New-Item -Credential c', 'Set-Content -WarningAction Ignore -Value x', 'Add-Content -OutVariable o -Value x',
  'Out-File -OutBuffer 10', 'Out-File -PipelineVariable p', 'Out-File -InformationAction Ignore', 'Out-File -INFA Ignore',
  'Out-File -ProgressAction Ignore', 'Out-File -ErrorVariable e', 'Out-File -WarningVariable w', 'Out-File -IV i',
  'Copy-Item -ToSession s notes.txt', 'Copy-Item -EA Stop notes.txt', 'Set-Content -Force -Value x', 'Out-File -WhatIf',
];

test('a value-taking parameter consumes its value, so the operand after it is the path', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const call of VALUE_TAKERS) {
    assert.equal(decision(root, `${call} .collet/off`), 'harness', `${call} .collet/off`);
    assert.equal(decision(root, `${call} src/cli.mjs`), 'allowed', `${call} src/cli.mjs`);
  }
  // A prefix that begins only common parameters, several of them, stays unread, as PowerShell refuses it.
  assert.equal(decision(root, 'Remove-Item -W x notes.txt'), 'scope');
});

// PowerShell binds -Name:value exactly as -Name value, abbreviated or not, and a switch written
// -Switch:$false takes nothing further.
const COLON_FORMS = [
  ['Set-Content -Path:.collet/off -Value x', 'harness'], ['Set-Content -Pa:src/cli.mjs -Value x', 'allowed'],
  ['Set-Content -Path:notes.txt -Value x', 'scope'], ['Remove-Item -LiteralPath:.collet', 'harness'],
  ['Remove-Item -Li:src/cli.mjs', 'allowed'], ['Remove-Item -LP:notes.txt', 'scope'],
  ['Copy-Item notes.txt -Destination:.collet/off', 'harness'], ['Copy-Item notes.txt -Dest:src/cli.mjs', 'allowed'],
  ['Copy-Item src/cli.mjs -D:notes.txt', 'scope'], ['New-Item -Path:. -Name:.collet/off', 'harness'],
  ['New-Item -Path:test -Na:new.mjs', 'allowed'], ['Rename-Item .collet -NewName:x', 'harness'],
  ['Rename-Item -Path:src/cli.mjs -NewN:cli2.mjs', 'allowed'], ['Rename-Item notes.txt -NewName:.collet', 'harness'],
  ['Out-File -FilePath:.collet/off', 'harness'], ['Out-File -Fi:src/cli.mjs', 'allowed'], ['Out-File -FilePath:notes.txt', 'scope'],
  ['Remove-Item -Path:"notes.txt"', 'scope'], ['Remove-Item -Recurse:$true notes.txt', 'scope'],
  ['Remove-Item -Recurse:$false src/cli.mjs', 'allowed'], ['Remove-Item -Force:$true .collet/off', 'harness'],
];

test('a PowerShell argument written -Name:value reads as -Name value', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '' });
  for (const [command, expected] of COLON_FORMS) assert.equal(decision(root, command), expected, command);
});

// An alias gets the decision of the cmdlet it names, for every path. Rename-Item and mkdir are read
// for the harness only, so ren, rni and md are too.
const ALIAS_OF = {
  ac: 'Add-Content', clc: 'Clear-Content', copy: 'Copy-Item', cpi: 'Copy-Item', move: 'Move-Item',
  mi: 'Move-Item', del: 'Remove-Item', erase: 'Remove-Item', rd: 'Remove-Item', ri: 'Remove-Item',
  rmdir: 'Remove-Item', ren: 'Rename-Item', rni: 'Rename-Item', md: 'mkdir', ni: 'New-Item',
};
// Operands inside the scope, outside it and under .collet/, with the decision the cmdlet gets.
const OPERANDS = {
  'Add-Content': [['src/cli.mjs x', 'allowed'], ['notes.txt x', 'scope'], ['.collet/off x', 'harness']],
  'Clear-Content': [['src/cli.mjs', 'allowed'], ['notes.txt', 'scope'], ['.collet/config.json', 'harness']],
  'Copy-Item': [['notes.txt src/cli.mjs', 'allowed'], ['src/cli.mjs notes.txt', 'scope'], ['src/cli.mjs .collet/off', 'harness']],
  'Move-Item': [['src/cli.mjs src/digest.mjs', 'allowed'], ['notes.txt src/cli.mjs', 'scope'], ['.collet x', 'harness']],
  'Remove-Item': [['src/cli.mjs', 'allowed'], ['notes.txt', 'scope'], ['.collet/config.json', 'harness']],
  'Rename-Item': [['src/cli.mjs cli2.mjs', 'allowed'], ['notes.txt notes.md', 'allowed'], ['.collet x', 'harness']],
  mkdir: [['test/x', 'allowed'], ['build/x', 'allowed'], ['.collet/checks/x', 'harness']],
  'New-Item': [['test/new.mjs', 'allowed'], ['notes.txt', 'scope'], ['.collet/off', 'harness']],
};

test('an alias gets the decision of the cmdlet it names, inside the scope, outside it and under .collet/', () => {
  const root = withTree({ '.collet/checks/scope.mjs': '', '.collet/config.json': '{}' });
  for (const [alias, cmdlet] of Object.entries(ALIAS_OF)) {
    for (const [operands, expected] of OPERANDS[cmdlet]) {
      assert.equal(decision(root, `${cmdlet} ${operands}`), expected, `${cmdlet} ${operands}`);
      assert.equal(decision(root, `${alias} ${operands}`), expected, `${alias} ${operands}`);
    }
  }
  // rmdir is a POSIX command too, and reads as a removal there as well, as rm -r does.
  assert.equal(fires(root, asCall(['Bash', 'rmdir tools'])), true);
});

test('with no task open nothing is enforced', () => {
  const root = withTree();
  assert.equal(check({ root, task: null, call: { tool: 'Write', input: { file_path: 'any.txt' } } }).fires, false);
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
});

test('a target the check cannot read does not throw', () => {
  const root = project({});
  for (const call of [{}, { tool: 'Write' }, { tool: 'Bash', input: {} }, { tool: 'Write', input: { file_path: null } }]) {
    assert.doesNotThrow(() => check({ root, task: TASK, call }));
  }
  assert.doesNotThrow(() => check({ root: join(root, 'missing'), task: TASK, call: { tool: 'Bash', input: { command: 'rm x' } } }));
});

// The mount's rules block is the harness's own write while the project has not committed it. A
// rules surface HEAD does not have starts empty, so the block alone is no task change whether the
// new file is untracked or staged; the project's text around the block still is.
function mountedWith(files = {}) {
  const root = project({ ...TREE, ...files });
  repo(root);
  assert.equal(mount(root).status, 0);
  return root;
}
const liveIn = (root) => live({ root, task: { id: 't1', scope: ['src/cli.mjs'] } });
const prepend = (root, file, text) => writeFileSync(join(root, file), text + readFileSync(join(root, file), 'utf8'), 'utf8');

for (const staged of [false, true]) {
  const state = staged ? 'staged' : 'untracked';
  test(`a new AGENTS.md holding only the rules block is no task change, ${state}`, () => {
    const root = mountedWith();
    if (staged) git(root, ['add', 'AGENTS.md']);
    assert.deepEqual(liveIn(root), { fires: false, reason: 'everything changed is inside the task' });
  });

  test(`a new AGENTS.md with project text around the rules block is a task change, ${state}`, () => {
    const root = mountedWith();
    prepend(root, 'AGENTS.md', '# Project notes\n\n');
    if (staged) git(root, ['add', 'AGENTS.md']);
    assert.deepEqual(liveIn(root), { fires: true, reason: 'changed outside the open task t1: AGENTS.md' });
  });

  test(`a tracked AGENTS.md is read from HEAD as before, ${state === 'staged' ? 'staged' : 'unstaged'}`, () => {
    const root = mountedWith({ 'AGENTS.md': '# House rules\n' });
    if (staged) git(root, ['add', 'AGENTS.md']);
    assert.equal(liveIn(root).fires, false, 'the block appended to committed text');
    prepend(root, 'AGENTS.md', '# More rules\n');
    if (staged) git(root, ['add', 'AGENTS.md']);
    assert.deepEqual(liveIn(root), { fires: true, reason: 'changed outside the open task t1: AGENTS.md' });
  });
}
