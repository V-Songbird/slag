// The task CLI. The cases that matter are the ones where the file said one thing and the code did
// another: a scope that closed over nothing, a widen that closed over nothing, a close that proved
// only half of what it claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CONFIG, git, mount, project, repo, task, TREE } from './temp-project.js';

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
});

test('widening for one reason does not drag in what an already-listed file imports', () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  // src/digest.mjs came in with the add and imports src/theme.mjs. Widening for an unrelated
  // file must not quietly collect it too.
  const out = task(root, ['widen', '--add', 'src/report.mjs', '--why', 'unrelated']);
  assert.doesNotMatch(out.stdout, /theme\.mjs/);
});

test("widen refuses the harness's own files and records nothing", () => {
  const root = ready();
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const ledger = join(root, '.collet', 'ledger.jsonl');
  const before = readFileSync(ledger, 'utf8');
  for (const path of ['.collet/checks/no-todo.mjs', './.collet/checks/', '.collet\\checks\\no-todo.mjs', '.collet']) {
    const out = task(root, ['widen', '--add', path, '--why', 'a new check']);
    assert.equal(out.status, 2, path);
    assert.match(out.stderr, /cannot join a task, so nothing was widened/, path);
    assert.match(out.stderr, /node \.collet\/task\.mjs close/, path);
  }
  assert.equal(readFileSync(ledger, 'utf8'), before);
  // The unverified list is writable during a task, so naming it changes nothing and is allowed.
  assert.equal(task(root, ['widen', '--add', '.collet/unverified.md', '--why', 'claims']).status, 0);
});

test("add refuses the harness's own files and records nothing", () => {
  const root = ready();
  const ledger = join(root, '.collet', 'ledger.jsonl');
  for (const scope of ['.collet/checks/no-todo.mjs', 'src/cli.mjs,./.collet/checks/', '.collet']) {
    const out = task(root, ['add', '--title', 'check', '--why', 'w', '--scope', scope]);
    assert.equal(out.status, 2, scope);
    assert.match(out.stderr, /cannot join a task, so no task was opened/, scope);
    assert.equal(existsSync(ledger), false, scope);
  }
  const opened = task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /task t1 — window/);
});

test('a task cannot be opened while the config still carries its placeholders', () => {
  const root = project(TREE);
  mount(root);
  const out = task(root, ['add', '--title', 't', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node -e 0']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /still carries its placeholders/);
});

test('an id is never handed out twice, even after a line is removed', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'one', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']).status, 0);
  task(root, ['add', '--title', 'two', '--why', 'w', '--scope', 'src/report.mjs']);
  assert.equal(task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']).status, 0);
  const ledger = join(root, '.collet', 'ledger.jsonl');
  const kept = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).slice(1).join('\n');
  writeFileSync(ledger, kept + '\n', 'utf8');
  const out = task(root, ['add', '--title', 'three', '--why', 'w', '--scope', 'src/theme.mjs']);
  assert.match(out.stdout, /task t3 —/);
});

test('a flag with no value is an error, not a scope of "--accept"', () => {
  const root = ready();
  const out = task(root, ['add', '--title', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--title needs a value/);
});

test('an accept command is refused when empty', () => {
  const root = project(TREE);
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), JSON.stringify({ project: 'p', accept: '' }), 'utf8');
  const out = task(root, ['add', '--title', 't', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(out.status, 2);
});

test('close proves the scope held before it runs the accept command', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'report.mjs'), 'export const r = 99;\n', 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /fail scope — changed outside the open task t1: src\/report\.mjs/);
  assert.match(refused.stderr, /Live checks failed\. Task t1 stays open/);
});

test('a failing non-scope live check leaves the task open without running acceptance', () => {
  const root = ready({
    'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
  });
  writeFileSync(
    join(root, '.collet', 'checks', 'skipped-test.mjs'),
    [
      "export const id = 'skipped-test';",
      'export function check() { return { fires: false }; }',
      "export function live() { return { fires: true, reason: 'test skipped in test/a.test.mjs' }; }",
    ].join('\n'),
    'utf8'
  );
  repo(root);
  const opened = task(root, [
    'add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node accept.mjs',
  ]);
  assert.equal(opened.status, 0, opened.stderr);
  const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /ok\s+scope — everything changed is inside the task/);
  assert.match(refused.stdout, /fail skipped-test — test skipped in test\/a\.test\.mjs/);
  assert.match(refused.stderr, /Live checks failed\. Task t1 stays open/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /changes landed outside|widen --add|running accept command/);
  assert.equal(existsSync(join(root, 'accept-ran')), false);
  assert.equal(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), ledger);
});

for (const baseline of ['no repository', 'no committed HEAD', 'Git unavailable']) {
  test(`close refuses ${baseline} before running acceptance`, () => {
    const root = ready({
      'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
    });
    if (baseline === 'no committed HEAD') git(root, ['init', '-q']);
    if (baseline === 'Git unavailable') repo(root);
    const opened = task(root, [
      'add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node accept.mjs',
    ]);
    assert.equal(opened.status, 0, opened.stderr);
    const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
    const args = ['close', '--left-out', 'nothing', '--unverified', 'nothing'];
    let refused;
    if (baseline === 'Git unavailable') {
      const env = { ...process.env };
      // A mounted task runs through an absolute Node path; removing Git from this child's PATH
      // models the host environment without changing the machine or the parent test process.
      for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
      env.PATH = root;
      refused = spawnSync(process.execPath, [join(root, '.collet', 'task.mjs'), ...args], {
        cwd: root, env, encoding: 'utf8', windowsHide: true,
      });
    } else {
      refused = task(root, args);
    }
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /skip scope/);
    assert.match(refused.stdout, /--strict counts that as a failure/);
    assert.match(refused.stderr, /Live checks failed\. Task t1 stays open/);
    assert.match(refused.stderr, /failed or unavailable checks/);
    assert.doesNotMatch(refused.stdout, /running accept command|task t1 closed/);
    assert.equal(existsSync(join(root, 'accept-ran')), false);
    assert.equal(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), ledger);
  });
}

for (const live of ['missing', 'skipped']) {
  test(`close refuses a custom check with ${live} live coverage`, () => {
    const root = ready({
      'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
    });
    const custom = [
      "export const id = 'custom';",
      'export function check() { return { fires: false }; }',
    ];
    if (live === 'skipped') {
      custom.push("export function live() { return { fires: false, skipped: true, reason: 'required baseline unavailable' }; }");
    }
    writeFileSync(join(root, '.collet', 'checks', 'custom.mjs'), custom.join('\n'), 'utf8');
    repo(root);
    const opened = task(root, [
      'add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node accept.mjs',
    ]);
    assert.equal(opened.status, 0, opened.stderr);
    const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
    const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /ok\s+scope — everything changed is inside the task/);
    assert.match(refused.stdout, live === 'missing'
      ? /skip custom — no live check/
      : /skip custom — required baseline unavailable/);
    assert.match(refused.stdout, /1 check\(s\) could not run, and --strict counts that as a failure/);
    assert.match(refused.stderr, /Live checks failed\. Task t1 stays open/);
    assert.doesNotMatch(refused.stdout, /running accept command|task t1 closed/);
    assert.equal(existsSync(join(root, 'accept-ran')), false);
    assert.equal(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), ledger);
  });
}

for (const missing of ['scope module', 'all check files']) {
  test(`close refuses missing ${missing} instead of treating zero checks as a pass`, () => {
    const root = ready({
      'accept.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('accept-ran', 'yes');\n",
    });
    repo(root);
    const opened = task(root, [
      'add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs', '--accept', 'node accept.mjs',
    ]);
    assert.equal(opened.status, 0, opened.stderr);
    const dir = join(root, '.collet', 'checks');
    const removed = missing === 'scope module' ? ['scope.mjs'] : readdirSync(dir);
    for (const name of removed) rmSync(join(dir, name));
    const ledger = readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8');
    const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /required scope check is missing\. Task t1 stays open/);
    assert.match(refused.stderr, /Restore \.collet\/checks\/scope\.mjs/);
    assert.doesNotMatch(refused.stdout, /running accept command|task t1 closed/);
    assert.equal(existsSync(join(root, 'accept-ran')), false);
    assert.equal(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), ledger);
  });
}

test('a new file the repository has never seen still counts as a change', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  writeFileSync(join(root, 'src', 'stray.mjs'), 'export const x = 1;\n', 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /stray\.mjs/);
});

// A real project has history before collet arrives, and nobody has committed the mount's files
// when its first task closes. Committing after the mount, as ready() plus repo() does, hides that.
function mountedOnHistory() {
  const root = project({ ...TREE, 'CLAUDE.md': '# House rules\n', '.cursor/rules/.keep': '' });
  repo(root);
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  assert.equal(task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']).status, 0);
  writeFileSync(join(root, 'src', 'cli.mjs'), "import { build } from './digest.mjs';\nexport const run = () => build() + 1;\n", 'utf8');
  return root;
}

test('the first task after a mount closes before the mount is committed', () => {
  const root = mountedOnHistory();
  // AGENTS.md and .cursor/rules/collet.md are new files; CLAUDE.md is the project's, block appended.
  const status = git(root, ['status', '--porcelain']);
  for (const line of [' M CLAUDE.md', '?? AGENTS.md', '?? .cursor/rules/collet.md']) assert.ok(status.includes(line), status);
  const out = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /ok\s+scope — everything changed is inside the task/);
  assert.match(out.stdout, /task t1 closed/);
});

for (const [name, file, change] of [
  ['a project file', 'src/report.mjs', () => 'export const r = 99;\n'],
  ["the project's text beside the rules block", 'CLAUDE.md', (text) => text.replace('# House rules', '# Changed rules')],
  ['a new file holding only a rules block', 'notes.md', () => '<!-- collet:begin -->\nx\n<!-- collet:end -->\n'],
]) {
  test(`after a mount, ${name} changed outside the task still keeps it open`, () => {
    const root = mountedOnHistory();
    const path = join(root, file);
    writeFileSync(path, change(existsSync(path) ? readFileSync(path, 'utf8') : ''), 'utf8');
    const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, new RegExp(`fail scope — changed outside the open task t1: ${file.replace('.', '\\.')}\\r?$`, 'm'));
    assert.match(refused.stderr, /Live checks failed\. Task t1 stays open/);
  });
}

// A mount below the Git root, as in a monorepo. Git names changes from the repository root; the
// scope is written from the mount. CLAUDE.md is tracked there, so its rules block is read from HEAD.
function mountedBelowRoot() {
  const files = Object.entries({ ...TREE, 'CLAUDE.md': '# House rules\n' }).map(([path, text]) => [`pkg/${path}`, text]);
  const root = project({ ...Object.fromEntries(files), 'other/x.mjs': 'export const x = 1;\n' });
  const pkg = join(root, 'pkg');
  repo(root);
  mount(pkg);
  writeFileSync(join(pkg, '.collet', 'config.json'), CONFIG, 'utf8');
  assert.equal(task(pkg, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']).status, 0);
  writeFileSync(join(pkg, 'src', 'cli.mjs'), "import { build } from './digest.mjs';\nexport const run = () => build() + 1;\n", 'utf8');
  return pkg;
}

test('a mount below the Git root closes its in-scope work', () => {
  const pkg = mountedBelowRoot();
  // Beside the mount is outside its project, for the close as for the session guard.
  writeFileSync(join(pkg, '..', 'other', 'x.mjs'), 'export const x = 2;\n', 'utf8');
  const out = task(pkg, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /ok\s+scope — everything changed is inside the task/);
});

test('a mount below the Git root still refuses a change outside its task', () => {
  const pkg = mountedBelowRoot();
  writeFileSync(join(pkg, 'src', 'report.mjs'), 'export const r = 99;\n', 'utf8');
  const refused = task(pkg, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /fail scope — changed outside the open task t1: src\/report\.mjs\r?$/m);
});

test('a file name Git would quote is compared as written', () => {
  const root = ready({ 'src/café.mjs': 'export const c = 1;\n' });
  repo(root);
  assert.equal(task(root, ['add', '--title', 'accent', '--why', 'w', '--scope', 'src/café.mjs']).status, 0);
  writeFileSync(join(root, 'src', 'café.mjs'), 'export const c = 2;\n', 'utf8');
  writeFileSync(join(root, 'src', 'né.txt'), 'x\n', 'utf8');
  const refused = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /fail scope — changed outside the open task t1: src\/né\.txt\r?$/m);
});

// A staged move removes its source as well as adding its destination. Rename detection reports only
// the destination, which let a file outside the task leave through a move into the scope.
for (const [name, from, to, closes] of [
  ['a staged move out of a file outside the task keeps it open', 'src/report.mjs', 'test/report.mjs', false],
  ['a staged move within the task still closes', 'test/a.test.mjs', 'test/b.test.mjs', true],
]) {
  test(name, () => {
    const root = ready();
    repo(root);
    assert.equal(task(root, ['add', '--title', 'move', '--why', 'w', '--scope', 'src/cli.mjs,test/**']).status, 0);
    git(root, ['mv', from, to]);
    const out = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
    assert.equal(out.status, closes ? 0 : 1, out.stdout + out.stderr);
    assert.match(out.stdout, closes
      ? /ok\s+scope — everything changed is inside the task/
      : /fail scope — changed outside the open task t1: src\/report\.mjs\r?$/m);
  });
}

test('a failing accept command leaves the task open', () => {
  const root = ready();
  repo(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG.replace('node -e 0', 'node no-such-file.mjs'), 'utf8');
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']);
  assert.equal(out.status, 1);
  assert.match(readFileSync(join(root, '.collet', 'ledger.jsonl'), 'utf8'), /"status":"in_progress"/);
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
});

test('close needs both claims, and "nothing" is an answer', () => {
  const root = ready();
  repo(root);
  task(root, ['add', '--title', 'window', '--why', 'w', '--scope', 'src/cli.mjs']);
  assert.equal(task(root, ['close']).status, 2);
  assert.equal(task(root, ['close', '--left-out', 'nothing']).status, 2);
  assert.equal(task(root, ['close', '--left-out', 'nothing', '--unverified', 'nothing']).status, 0);
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
});

test('a second task cannot be opened while one is still open', () => {
  const root = ready();
  task(root, ['add', '--title', 'one', '--why', 'w', '--scope', 'src/cli.mjs']);
  const out = task(root, ['add', '--title', 'two', '--why', 'w', '--scope', 'src/report.mjs']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /is still open/);
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
});
